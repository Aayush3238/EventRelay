const express = require('express');
const { query } = require('../db/pool');
const { requireJwt } = require('../middleware/auth');

const router = express.Router();
router.use(requireJwt);

router.get('/overview', async (req, res, next) => {
  try {
    const { rows: byStatus } = await query(
      `SELECT d.status, COUNT(*)::int AS n
       FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
       WHERE e.user_id = $1 GROUP BY d.status`,
      [req.user.id]
    );
    const { rows: totals } = await query(
      `SELECT COUNT(*)::int AS events FROM events WHERE user_id = $1`,
      [req.user.id]
    );
    const { rows: recentFailures } = await query(
      `SELECT d.id, d.status, d.last_error, d.created_at, d.updated_at, ev.event_type
       FROM deliveries d
       JOIN endpoints e ON e.id = d.endpoint_id
       JOIN events ev ON ev.id = d.event_id
       WHERE e.user_id = $1 AND d.status = 'failed'
       ORDER BY d.updated_at DESC LIMIT 10`,
      [req.user.id]
    );
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
    const succeeded = counts.succeeded || 0;
    const terminal = (counts.succeeded || 0) + (counts.failed || 0);
    res.json({
      events: totals[0].events,
      deliveriesByStatus: counts,
      successRate: terminal ? succeeded / terminal : null,
      recentFailures,
    });
  } catch (err) { next(err); }
});

module.exports = router;
