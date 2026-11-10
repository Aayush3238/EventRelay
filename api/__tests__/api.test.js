// API smoke tests. The health + validation tests run without a DB; the
// integration block needs a real Postgres (DATABASE_URL) and is skipped
// otherwise — never faked with pg-mem for locking/transaction claims.
const request = require('supertest');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long!!';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || Buffer.alloc(32, 3).toString('base64');

const app = require('../src/app');

describe('health', () => {
  it('GET /health → 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('validation', () => {
  it('bad register body → 422', async () => {
    const res = await request(app).post('/auth/register').send({ email: 'nope' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('unknown route → 404 with requestId', async () => {
    const res = await request(app).get('/definitely-not-here');
    expect(res.status).toBe(404);
    expect(res.body.error.requestId).toBeTruthy();
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
describeDb('integration (real Postgres)', () => {
  const { pool } = require('../src/db/pool');

  afterAll(async () => {
    await pool.end();
  });

  it('register → create api key → ingest → replay flow', async () => {
    const email = `t${Date.now()}@example.com`;
    const reg = await request(app)
      .post('/auth/register')
      .send({ name: 'Tester', email, password: 'password-123' });
    expect(reg.status).toBe(201);
    const token = reg.body.token;

    const keyRes = await request(app)
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'test' });
    expect(keyRes.status).toBe(201);
    expect(keyRes.body.rawKey.startsWith('er_live_')).toBe(true);

    // No endpoints subscribed → accepted with 0 deliveries, no crash.
    const ingest = await request(app)
      .post('/v1/events')
      .set('X-API-Key', keyRes.body.rawKey)
      .send({ type: 'order.created', data: { orderId: 'ORD-1' } });
    expect([200, 202]).toContain(ingest.status);
    expect(ingest.body.deliveriesCreated).toBe(0);

    // Same idempotency key twice → same event, deduplicated.
    const again = await request(app)
      .post('/v1/events')
      .set('X-API-Key', keyRes.body.rawKey)
      .set('Idempotency-Key', 'same-key')
      .send({ type: 'order.created', data: { orderId: 'ORD-1' } });
    const again2 = await request(app)
      .post('/v1/events')
      .set('X-API-Key', keyRes.body.rawKey)
      .set('Idempotency-Key', 'same-key')
      .send({ type: 'order.created', data: { orderId: 'ORD-1' } });
    expect(again.body.eventId).toBe(again2.body.eventId);
    expect(again2.body.deduplicated).toBe(true);
  });
});
