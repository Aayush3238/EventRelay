const express = require('express');
const rateLimit = require('express-rate-limit');
const { query } = require('../db/pool');
const { requireJwt, requireApiKey, httpError } = require('../middleware/auth');
const { validate, ingestSchema, paginationSchema } = require('../middleware/validate');
const { ingestEvent } = require('../services/ingestion');

const router = express.Router();

// Ingestion is the hottest path in the system — rate limit per API key so one
// runaway producer can't starve the pool for everyone else.
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed by API key, not IP — avoid req.ip here entirely (express-rate-limit
  // v8 requires its ipKeyGenerator helper whenever IP is part of the key).
  keyGenerator: (req) => String(req.headers['x-api-key'] || 'anon').slice(0, 64),
  message: { error: { code: 'RATE_LIMITED', message: 'Too many events' } },
});

router.post('/v1/events', ingestLimiter, requireApiKey, validate(ingestSchema), async (req, res, next) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 200)) {
      return next(httpError(422, 'VALIDATION_ERROR', 'Invalid Idempotency-Key header'));
    }
    const result = await ingestEvent({
      userId: req.userId,
      type: req.body.type,
      data: req.body.data,
      idempotencyKey: idempotencyKey || null,
    });
    res.status(result.deduplicated ? 200 : 202).json(result);
  } catch (err) { next(err); }
});

// Dashboard reads (JWT). All scoped to the caller's own data.
router.get('/events', requireJwt, validate(paginationSchema, 'query'), async (req, res, next) => {
  try {
    const { limit, offset } = req.query;
    const { type } = req.query;
    const params = [req.user.id, limit, offset];
    let where = 'WHERE user_id = $1';
    if (type) { params.push(type); where += ` AND event_type = $${params.length}`; }
    const { rows } = await query(
      `SELECT id, event_type, payload, created_at FROM events ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      params
    );
    const countParams = type ? [req.user.id, type] : [req.user.id];
    const { rows: total } = await query(
      `SELECT COUNT(*)::int AS n FROM events ${where}`,
      countParams
    );
    res.json({ events: rows, meta: { limit, offset, total: total[0].n } });
  } catch (err) { next(err); }
});

router.get('/events/:id', requireJwt, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, event_type, payload, created_at FROM events WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return next(httpError(404, 'NOT_FOUND', 'Event not found'));
    const { rows: deliveries } = await query(
      `SELECT d.id, d.endpoint_id, d.status, d.attempt_count, d.total_attempt_count, d.replay_count,
              d.last_response_status, d.last_error, d.created_at, d.updated_at
       FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
       WHERE d.event_id = $1 AND e.user_id = $2 ORDER BY d.created_at`,
      [req.params.id, req.user.id]
    );
    res.json({ event: rows[0], deliveries });
  } catch (err) { next(err); }
});

module.exports = router;
