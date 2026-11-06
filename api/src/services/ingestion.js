// Event ingestion: the heart of EventRelay. One TX creates the event, one
// delivery per subscribed endpoint, and one outbox row per delivery. If any
// of it fails, none of it happened — that's the whole point.
const crypto = require('node:crypto');
const { withTransaction, query } = require('../db/pool');
const env = require('../config/env');

async function findExistingByIdempotency(userId, idempotencyKey) {
  const { rows } = await query(
    `SELECT id, event_type FROM events WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey]
  );
  if (!rows[0]) return null;
  const eventId = rows[0].id;
  const { rows: d } = await query(
    'SELECT COUNT(*)::int AS n FROM deliveries WHERE event_id = $1',
    [eventId]
  );
  return { eventId, type: rows[0].event_type, status: 'accepted', deliveriesCreated: d[0].n, deduplicated: true };
}

async function ingestEvent({ userId, type, data, idempotencyKey }) {
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized, 'utf8') > env.maxEventPayloadBytes) {
    const err = new Error('Event payload too large');
    err.status = 413;
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }

  if (idempotencyKey) {
    const existing = await findExistingByIdempotency(userId, idempotencyKey);
    if (existing) return existing;
  }

  try {
    return await withTransaction(async (client) => {
      if (idempotencyKey) {
        const { rows } = await client.query(
          'SELECT id, event_type FROM events WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE',
          [userId, idempotencyKey]
        );
        if (rows[0]) {
          // Lost a race: someone else committed first. Reuse their event.
          const { rows: d } = await client.query(
            'SELECT COUNT(*)::int AS n FROM deliveries WHERE event_id = $1',
            [rows[0].id]
          );
          return { eventId: rows[0].id, type: rows[0].event_type, status: 'accepted', deliveriesCreated: d[0].n, deduplicated: true };
        }
      }

      const eventId = crypto.randomUUID();
      await client.query(
        `INSERT INTO events (id, user_id, idempotency_key, event_type, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [eventId, userId, idempotencyKey || null, type, serialized]
      );

      const { rows: endpoints } = await client.query(
        `SELECT e.id FROM endpoints e
         JOIN endpoint_event_types eet ON eet.endpoint_id = e.id
         WHERE e.user_id = $1 AND e.is_active AND e.deleted_at IS NULL AND eet.event_type = $2`,
        [userId, type]
      );

      let deliveriesCreated = 0;
      for (const ep of endpoints) {
        const deliveryId = crypto.randomUUID();
        const { rows: inserted } = await client.query(
          `INSERT INTO deliveries (id, event_id, endpoint_id, status)
           VALUES ($1, $2, $3, 'pending') ON CONFLICT DO NOTHING RETURNING id`,
          [deliveryId, eventId, ep.id]
        );
        if (!inserted.length) continue;
        deliveriesCreated += 1;
        await client.query(
          `INSERT INTO outbox_messages (id, message_type, aggregate_id, available_at)
           VALUES ($1, 'delivery.created', $2, NOW())`,
          [crypto.randomUUID(), inserted[0].id]
        );
      }

      return { eventId, type, status: 'accepted', deliveriesCreated, deduplicated: false };
    });
  } catch (err) {
    // Unique-violation race on (user_id, idempotency_key): the other
    // transaction won. Return their result instead of a 500.
    if (err.code === '23505' && idempotencyKey) {
      const existing = await findExistingByIdempotency(userId, idempotencyKey);
      if (existing) return existing;
    }
    throw err;
  }
}

module.exports = { ingestEvent };
