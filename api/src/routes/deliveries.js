const express = require('express');
const crypto = require('node:crypto');
const { query, withTransaction } = require('../db/pool');
const { requireJwt, httpError } = require('../middleware/auth');
const { validate, paginationSchema } = require('../middleware/validate');

const router = express.Router();
router.use(requireJwt);

router.get('/', validate(paginationSchema, 'query'), async (req, res, next) => {
  try {
    const { limit, offset, status, endpointId } = req.query;
    const params = [req.user.id, limit, offset];
    let where = 'WHERE e.user_id = $1';
    if (status) {
      params.push(status);
      where += ` AND d.status = $${params.length}`;
    }
    if (endpointId) {
      params.push(endpointId);
      where += ` AND d.endpoint_id = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT d.id, d.event_id, d.endpoint_id, d.status, d.attempt_count, d.total_attempt_count,
              d.replay_count, d.next_attempt_at, d.last_response_status, d.last_error,
              d.created_at, d.updated_at, ev.event_type
       FROM deliveries d
       JOIN endpoints e ON e.id = d.endpoint_id
       JOIN events ev ON ev.id = d.event_id
       ${where} ORDER BY d.created_at DESC LIMIT $2 OFFSET $3`,
      params,
    );
    res.json({ deliveries: rows, meta: { limit, offset } });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT d.*, ev.event_type, ev.payload, e.url AS endpoint_url
       FROM deliveries d
       JOIN endpoints e ON e.id = d.endpoint_id
       JOIN events ev ON ev.id = d.event_id
       WHERE d.id = $1 AND e.user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) return next(httpError(404, 'NOT_FOUND', 'Delivery not found'));
    const { rows: attempts } = await query(
      `SELECT id, cycle_number, attempt_number, status, request_timestamp, response_status,
              response_body, response_time_ms, error_message, started_at, completed_at
       FROM delivery_attempts WHERE delivery_id = $1 ORDER BY cycle_number, attempt_number`,
      [req.params.id],
    );
    res.json({ delivery: rows[0], attempts });
  } catch (err) {
    next(err);
  }
});

// Replay is FAILED-ONLY in v1 (plan §8.5). The single UPDATE...WHERE status='failed'
// is what makes concurrent replays safe: the loser updates 0 rows → 409.
router.post('/:id/replay', async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      // Ownership check first, then the atomic flip.
      const { rows: owned } = await client.query(
        `SELECT d.id FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
         WHERE d.id = $1 AND e.user_id = $2`,
        [req.params.id, req.user.id],
      );
      if (!owned.length) return { notFound: true };

      const { rows } = await client.query(
        `UPDATE deliveries
         SET status = 'pending', attempt_count = 0,
             replay_count = replay_count + 1, next_attempt_at = NOW(),
             lock_token = NULL, locked_until = NULL,
             succeeded_at = NULL, dead_lettered_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'failed'
         RETURNING replay_count`,
        [req.params.id],
      );
      if (!rows.length) return { conflict: true };

      await client.query(
        `INSERT INTO outbox_messages (id, message_type, aggregate_id, available_at)
         VALUES ($1, 'delivery.replay', $2, NOW())`,
        [crypto.randomUUID(), req.params.id],
      );
      return { replayCount: rows[0].replay_count };
    });

    if (result.notFound) return next(httpError(404, 'NOT_FOUND', 'Delivery not found'));
    if (result.conflict) {
      return next(
        httpError(
          409,
          'CONFLICT',
          'Delivery is not in a failed state (already replayed or still in progress)',
        ),
      );
    }
    res.status(202).json({ deliveryId: req.params.id, status: 'pending', replayCount: result.replayCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
