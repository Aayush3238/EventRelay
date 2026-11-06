// Embedded background mode (RUN_BACKGROUND=true): runs the BullMQ worker,
// sweeper and outbox dispatcher inside the API process.
// Why this exists: Render has no free tier for background workers, so a
// single free web service can still deliver webhooks for testing. The
// separate worker/dispatcher processes remain the recommended production
// setup — in embedded mode a restart kills in-flight deliveries (the lease
// + sweeper recover them, so nothing is lost, but throughput is shared).
const logger = require('./lib/logger');

async function startBackground() {
  // Lazy requires so a broken/missing Redis never blocks API boot.
  const { startWorker } = require('../../worker/src/worker');
  const { startDispatcher } = require('../../worker/src/dispatcher');

  const stopWorker = startWorker();
  const stopDispatcher = await startDispatcher();
  logger.info('embedded background worker + dispatcher started (RUN_BACKGROUND=true)');

  return async () => {
    await stopDispatcher();
    await stopWorker();
  };
}

module.exports = { startBackground };
