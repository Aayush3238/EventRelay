// Concurrency tests (plan §14): real Postgres, parallel clients. These prove
// the race-safety claims that unit tests can't — duplicate ingestion collapses
// to exactly one event, and concurrent replays create exactly one new cycle.
// Skipped without DATABASE_URL; never faked with pg-mem (see plan §14).
const crypto = require('node:crypto');
const request = require('supertest');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long!!';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || Buffer.alloc(32, 3).toString('base64');

const app = require('../src/app');
const { pool, query } = require('../src/db/pool');
const { encryptSecret } = require('@eventrelay/shared').crypto;

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('concurrency (real Postgres)', () => {
  const createdUserIds = [];

  // Fixture: a user with an API key and one endpoint subscribed to
  // order.created, built through the real API for auth + a direct endpoint
  // insert (this test is about ingestion/replay races, not SSRF validation).
  async function makeUserWithEndpoint() {
    const email = `conc-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const reg = await request(app)
      .post('/auth/register')
      .send({ name: 'Concurrency', email, password: 'password-123' });
    expect(reg.status).toBe(201);
    createdUserIds.push(reg.body.user.id);

    const keyRes = await request(app)
      .post('/api-keys')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ name: 'conc' });
    expect(keyRes.status).toBe(201);

    const endpointId = crypto.randomUUID();
    await query(
      `INSERT INTO endpoints (id, user_id, name, url, signing_secret_encrypted)
       VALUES ($1, $2, 'conc-endpoint', 'https://example.com/hook', $3)`,
      [endpointId, reg.body.user.id, encryptSecret('test-secret')],
    );
    await query(`INSERT INTO endpoint_event_types (endpoint_id, event_type) VALUES ($1, 'order.created')`, [
      endpointId,
    ]);

    return { userId: reg.body.user.id, token: reg.body.token, rawKey: keyRes.body.rawKey, endpointId };
  }

  afterAll(async () => {
    // Leave no test rows behind — this runs against a real database.
    for (const userId of createdUserIds) {
      await query(
        `DELETE FROM delivery_attempts WHERE delivery_id IN
           (SELECT id FROM deliveries WHERE endpoint_id IN
             (SELECT id FROM endpoints WHERE user_id = $1))`,
        [userId],
      );
      await query(
        `DELETE FROM outbox_messages WHERE aggregate_id IN
           (SELECT id FROM deliveries WHERE endpoint_id IN
             (SELECT id FROM endpoints WHERE user_id = $1))`,
        [userId],
      );
      await query(
        `DELETE FROM deliveries WHERE endpoint_id IN (SELECT id FROM endpoints WHERE user_id = $1)`,
        [userId],
      );
      await query(`DELETE FROM events WHERE user_id = $1`, [userId]);
      await query(
        `DELETE FROM endpoint_event_types WHERE endpoint_id IN (SELECT id FROM endpoints WHERE user_id = $1)`,
        [userId],
      );
      await query(`DELETE FROM endpoints WHERE user_id = $1`, [userId]);
      await query(`DELETE FROM api_keys WHERE user_id = $1`, [userId]);
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    await pool.end();
  });

  it('8 parallel ingests with one Idempotency-Key → 1 event, 1 delivery, 1 outbox row', async () => {
    const { userId, rawKey } = await makeUserWithEndpoint();
    const idemKey = `race-${crypto.randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post('/v1/events')
          .set('X-API-Key', rawKey)
          .set('Idempotency-Key', idemKey)
          .send({ type: 'order.created', data: { orderId: 'RACE-1' } }),
      ),
    );

    // Every racer gets a sane answer — nobody sees a 500 from the race.
    for (const r of results) expect([200, 202]).toContain(r.status);

    // All eight saw the same event id, and exactly one of them created it.
    const ids = new Set(results.map((r) => r.body.eventId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.body.deduplicated === false)).toHaveLength(1);
    expect(results.every((r) => r.body.deliveriesCreated === 1)).toBe(true);

    const eventId = [...ids][0];
    const { rows: events } = await query(
      `SELECT COUNT(*)::int AS n FROM events WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idemKey],
    );
    expect(events[0].n).toBe(1);

    // One subscribed endpoint → exactly one delivery, exactly one outbox row.
    const { rows: deliveries } = await query(
      `SELECT COUNT(*)::int AS n FROM deliveries WHERE event_id = $1`,
      [eventId],
    );
    expect(deliveries[0].n).toBe(1);

    const { rows: outbox } = await query(
      `SELECT COUNT(*)::int AS n FROM outbox_messages
       WHERE message_type = 'delivery.created'
         AND aggregate_id IN (SELECT id FROM deliveries WHERE event_id = $1)`,
      [eventId],
    );
    expect(outbox[0].n).toBe(1);
  });

  it('two parallel replays of one failed delivery → one 202, one 409, one new cycle', async () => {
    const { userId, token, endpointId } = await makeUserWithEndpoint();

    // Fixture: an event whose delivery already exhausted its retries.
    const eventId = crypto.randomUUID();
    const deliveryId = crypto.randomUUID();
    await query(
      `INSERT INTO events (id, user_id, event_type, payload)
       VALUES ($1, $2, 'order.created', '{"orderId":"RACE-2"}'::jsonb)`,
      [eventId, userId],
    );
    await query(
      `INSERT INTO deliveries (id, event_id, endpoint_id, status, attempt_count, dead_lettered_at)
       VALUES ($1, $2, $3, 'failed', 6, NOW())`,
      [deliveryId, eventId, endpointId],
    );

    const [a, b] = await Promise.all([
      request(app).post(`/deliveries/${deliveryId}/replay`).set('Authorization', `Bearer ${token}`),
      request(app).post(`/deliveries/${deliveryId}/replay`).set('Authorization', `Bearer ${token}`),
    ]);

    // The status='failed' guard makes this linearizable: exactly one wins.
    expect([a.status, b.status].sort()).toEqual([202, 409]);

    const { rows } = await query(`SELECT status, replay_count, attempt_count FROM deliveries WHERE id = $1`, [
      deliveryId,
    ]);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].replay_count).toBe(1); // exactly one new cycle
    expect(rows[0].attempt_count).toBe(0); // reset for the new cycle

    const { rows: outbox } = await query(
      `SELECT COUNT(*)::int AS n FROM outbox_messages
       WHERE message_type = 'delivery.replay' AND aggregate_id = $1`,
      [deliveryId],
    );
    expect(outbox[0].n).toBe(1); // the loser must not have enqueued a second one
  });
});
