// Redis-wipe / lost-jobs recovery (plan.md §6.4).
// Run after Redis was wiped: jobs that were already published are gone from
// Redis, but their deliveries still sit in Postgres as pending/retrying (or
// processing with an expired lease). This script recreates outbox rows for
// them so the dispatcher re-enqueues. History and counters are untouched.
//   node scripts/recover-queue.js [--dry-run]
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const dryRun = process.argv.includes('--dry-run');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://eventrelay:eventrelay@localhost:5432/eventrelay',
  max: 5,
});

const ELIGIBLE = `(d.status IN ('pending','retrying')
  OR (d.status = 'processing' AND d.locked_until < NOW()))`;

async function main() {
  const { rows: counts } = await pool.query(
    `SELECT d.status, COUNT(*)::int AS n FROM deliveries d
     WHERE ${ELIGIBLE}
       AND NOT EXISTS (SELECT 1 FROM outbox_messages o
                       WHERE o.aggregate_id = d.id AND o.published_at IS NULL)
     GROUP BY d.status`,
  );
  console.log('eligible deliveries:', counts);
  if (dryRun) {
    console.log('[dry-run] nothing written');
    return;
  }

  let total = 0;
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT d.id FROM deliveries d
         WHERE ${ELIGIBLE}
           AND NOT EXISTS (SELECT 1 FROM outbox_messages o
                           WHERE o.aggregate_id = d.id AND o.published_at IS NULL)
         ORDER BY d.created_at LIMIT 500
         FOR UPDATE OF d SKIP LOCKED`,
      );
      if (!rows.length) {
        await client.query('COMMIT');
        break;
      }
      for (const r of rows) {
        // Expired-processing deliveries may have a stranded in_progress attempt.
        await client.query(
          `UPDATE delivery_attempts SET status = 'worker_lost',
             error_message = 'lease_expired', completed_at = NOW()
           WHERE delivery_id = $1 AND status = 'in_progress'`,
          [r.id],
        );
        await client.query(
          `UPDATE deliveries SET lock_token = NULL, locked_until = NULL, updated_at = NOW()
           WHERE id = $1`,
          [r.id],
        );
        await client.query(
          `INSERT INTO outbox_messages (id, message_type, aggregate_id, available_at)
           VALUES ($1, 'delivery.recovery', $2, NOW())`,
          [crypto.randomUUID(), r.id],
        );
      }
      await client.query('COMMIT');
      total += rows.length;
      console.log(`re-enqueued ${rows.length} (total ${total})`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(`done. re-enqueued ${total} deliveries`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
