// Concurrent claim race (plan §7.1 / §14): two workers, one delivery —
// exactly one claim may win, and the loser must leave no trace (no second
// attempt row, no counter bump). Real Postgres required; skipped without it.
const crypto = require('node:crypto');

const { pool, query } = require('../src/db');
const { claimDelivery } = require('../src/delivery');
const { encryptSecret } = require('@eventrelay/shared').crypto;

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('claim race (real Postgres)', () => {
  const ids = { userId: null, endpointId: null, eventId: null, deliveryId: null };

  beforeAll(async () => {
    ids.userId = crypto.randomUUID();
    ids.endpointId = crypto.randomUUID();
    ids.eventId = crypto.randomUUID();
    ids.deliveryId = crypto.randomUUID();

    await query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Claim Race', $2, 'x')`,
      [ids.userId, `claim-${crypto.randomUUID().slice(0, 8)}@example.com`],
    );
    await query(
      `INSERT INTO endpoints (id, user_id, name, url, signing_secret_encrypted)
       VALUES ($1, $2, 'claim-endpoint', 'https://example.com/hook', $3)`,
      [ids.endpointId, ids.userId, encryptSecret('test-secret')],
    );
    await query(
      `INSERT INTO events (id, user_id, event_type, payload)
       VALUES ($1, $2, 'order.created', '{"orderId":"CLAIM-1"}'::jsonb)`,
      [ids.eventId, ids.userId],
    );
    await query(
      `INSERT INTO deliveries (id, event_id, endpoint_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [ids.deliveryId, ids.eventId, ids.endpointId],
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM delivery_attempts WHERE delivery_id = $1`, [ids.deliveryId]);
    await query(`DELETE FROM outbox_messages WHERE aggregate_id = $1`, [ids.deliveryId]);
    await query(`DELETE FROM deliveries WHERE id = $1`, [ids.deliveryId]);
    await query(`DELETE FROM events WHERE id = $1`, [ids.eventId]);
    await query(`DELETE FROM endpoints WHERE id = $1`, [ids.endpointId]);
    await query(`DELETE FROM users WHERE id = $1`, [ids.userId]);
    await pool.end();
  });

  it('two parallel claims → exactly one wins, one attempt row, counters bumped once', async () => {
    const [a, b] = await Promise.all([claimDelivery(ids.deliveryId), claimDelivery(ids.deliveryId)]);

    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    expect(winner.status).toBe('processing');
    expect(winner.attempt_count).toBe(1);
    expect(winner.total_attempt_count).toBe(1);
    expect(winner.lock_token).toBeTruthy();
    expect(winner.attempt_id).toBeTruthy();

    const { rows } = await query(
      `SELECT status, attempt_count, total_attempt_count, lock_token FROM deliveries WHERE id = $1`,
      [ids.deliveryId],
    );
    expect(rows[0].status).toBe('processing');
    expect(rows[0].attempt_count).toBe(1); // loser must not double-bump
    expect(rows[0].total_attempt_count).toBe(1);
    expect(rows[0].lock_token).toBe(winner.lock_token);

    const { rows: attempts } = await query(
      `SELECT id, status, attempt_number, cycle_number FROM delivery_attempts WHERE delivery_id = $1`,
      [ids.deliveryId],
    );
    expect(attempts).toHaveLength(1); // the loser's CTE inserted nothing
    expect(attempts[0].status).toBe('in_progress');
    expect(attempts[0].attempt_number).toBe(1);
    expect(attempts[0].cycle_number).toBe(1);
    expect(attempts[0].id).toBe(winner.attempt_id);
  });

  it('claiming an already-leased delivery is a no-op', async () => {
    // Delivery is 'processing' with a fresh lease from the previous test.
    const again = await claimDelivery(ids.deliveryId);
    expect(again).toBeNull();

    const { rows } = await query(`SELECT attempt_count FROM deliveries WHERE id = $1`, [ids.deliveryId]);
    expect(rows[0].attempt_count).toBe(1);
  });
});
