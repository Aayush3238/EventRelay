// Outbox dispatcher: the only process allowed to call queue.add().
// Polls DUE rows (available_at <= NOW()), claims them with a lock token,
// enqueues with jobId = outbox_<id>, then marks published under the token.
const crypto = require('node:crypto');
const { withTransaction, query } = require('./db');
const { createQueue } = require('./queue');
const logger = require('./logger');

const BATCH = 50;
const LEASE_MS = 30000;

async function claimDue() {
  const token = crypto.randomUUID();
  const rows = await withTransaction(async (client) => {
    const { rows: due } = await client.query(
      `SELECT id, aggregate_id FROM outbox_messages
       WHERE published_at IS NULL AND available_at <= NOW()
         AND (locked_until IS NULL OR locked_until < NOW())
       ORDER BY available_at, created_at LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [BATCH],
    );
    if (!due.length) return [];
    const ids = due.map((r) => r.id);
    await client.query(
      `UPDATE outbox_messages
       SET locked_until = NOW() + make_interval(secs => $2 / 1000.0),
           lock_token = $3, attempts = attempts + 1
       WHERE id = ANY($1::uuid[])`,
      [ids, LEASE_MS, token],
    );
    return due;
  });
  return { rows, token };
}

async function runOnce(queue) {
  const { rows, token } = await claimDue();
  for (const msg of rows) {
    try {
      await queue.add(
        'deliver',
        { deliveryId: msg.aggregate_id, outboxId: msg.id },
        {
          jobId: `outbox_${msg.id}`, // same row ⇒ same id ⇒ BullMQ dedupes re-publishes
        },
      );
      // Guarded mark: if our lease expired mid-flight, another dispatcher
      // owns this row — marking it published would be a lie.
      const { rowCount } = await query(
        `UPDATE outbox_messages
         SET published_at = NOW(), lock_token = NULL, locked_until = NULL
         WHERE id = $1 AND lock_token = $2 AND locked_until > NOW()`,
        [msg.id, token],
      );
      if (!rowCount) logger.warn({ outboxId: msg.id }, 'lost outbox lease before marking published');
    } catch (err) {
      // Redis down etc. — release the claim, leave unpublished, next poll retries.
      logger.error({ err, outboxId: msg.id }, 'failed to enqueue outbox message');
      await query(
        'UPDATE outbox_messages SET lock_token = NULL, locked_until = NULL WHERE id = $1 AND lock_token = $2',
        [msg.id, token],
      ).catch(() => {});
    }
  }
  return rows.length;
}

async function startDispatcher() {
  const queue = createQueue();
  logger.info('dispatcher started');
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const n = await runOnce(queue);
        if (n === 0) await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        logger.error({ err }, 'dispatcher loop error');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };
  const done = loop();
  return async () => {
    stopped = true;
    await done;
    await queue.close();
  };
}

module.exports = { startDispatcher, runOnce };
