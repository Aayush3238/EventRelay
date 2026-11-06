// Lease sweeper: finds deliveries stuck in 'processing' past their lease and
// finalizes their in_progress attempt as worker_lost, then re-enqueues via
// outbox. This is how a crashed worker's deliveries come back to life.
const crypto = require('node:crypto');
const { withTransaction } = require('./db');
const logger = require('./logger');

async function sweepOnce() {
  return withTransaction(async (client) => {
    const { rows: stuck } = await client.query(
      `SELECT d.id, d.attempt_count, ep.max_attempts
       FROM deliveries d JOIN endpoints ep ON ep.id = d.endpoint_id
       WHERE d.status = 'processing' AND d.locked_until < NOW()
       ORDER BY d.locked_until LIMIT 50
       FOR UPDATE OF d SKIP LOCKED`
    );
    if (!stuck.length) return 0;

    for (const d of stuck) {
      // The claim invariant guarantees exactly one in_progress attempt.
      await client.query(
        `UPDATE delivery_attempts
         SET status = 'worker_lost', error_message = 'lease_expired',
             completed_at = NOW()
         WHERE delivery_id = $1 AND status = 'in_progress'`,
        [d.id]
      );

      const exhausted = d.attempt_count >= (d.max_attempts || 6);
      if (exhausted) {
        await client.query(
          `UPDATE deliveries
           SET status = 'failed', dead_lettered_at = NOW(),
               lock_token = NULL, locked_until = NULL, updated_at = NOW()
           WHERE id = $1`,
          [d.id]
        );
      } else {
        await client.query(
          `UPDATE deliveries
           SET status = 'retrying', next_attempt_at = NOW(),
               lock_token = NULL, locked_until = NULL, updated_at = NOW()
           WHERE id = $1`,
          [d.id]
        );
        await client.query(
          `INSERT INTO outbox_messages (id, message_type, aggregate_id, available_at)
           VALUES ($1, 'delivery.recovery', $2, NOW())`,
          [crypto.randomUUID(), d.id]
        );
      }
    }
    logger.warn({ swept: stuck.length }, 'swept expired processing leases');
    return stuck.length;
  });
}

function startSweeper(intervalMs = 15000) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try { await sweepOnce(); } catch (err) { logger.error({ err }, 'sweeper error'); }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  const done = loop();
  return async () => { stopped = true; await done; };
}

module.exports = { startSweeper, sweepOnce };
