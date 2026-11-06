// Entry point. Modes:
//   node worker.js                  → BullMQ worker + sweeper
//   node worker.js --mode=dispatcher → outbox dispatcher only
// Roles are split so you can scale them independently in Compose.
const { Worker } = require('bullmq');
const config = require('./config');
const logger = require('./logger');
const { createConnection } = require('./queue');
const { processDelivery } = require('./delivery');
const { startSweeper } = require('./sweeper');
const { startDispatcher } = require('./dispatcher');
const { pool } = require('./db');

const mode = process.argv.includes('--mode=dispatcher') ? 'dispatcher' : 'worker';

async function main() {
  if (mode === 'dispatcher') {
    const stop = await startDispatcher();
    const shutdown = async () => { await stop(); await pool.end(); process.exit(0); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return;
  }

  const worker = new Worker(
    'deliveries',
    async (job) => {
      const { deliveryId } = job.data;
      try {
        return await processDelivery(deliveryId);
      } catch (err) {
        // Don't let one bad job kill the worker. The lease + sweeper will
        // pick the delivery back up if we truly crash mid-flight.
        logger.error({ err, deliveryId }, 'delivery processing threw');
        return { error: String(err.message || err) };
      }
    },
    { connection: createConnection(), concurrency: config.concurrency }
  );

  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'bullmq job failed'));
  logger.info({ concurrency: config.concurrency }, 'worker started');

  const stopSweeper = startSweeper();
  const shutdown = async () => {
    await stopSweeper();
    await worker.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => { logger.fatal({ err }, 'worker failed to start'); process.exit(1); });
