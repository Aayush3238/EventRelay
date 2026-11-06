const env = require('./config/env');

env.assertLeaseSafety(); // fail fast before we accept a single request

const app = require('./app');
const logger = require('./lib/logger');
const { pool } = require('./db/pool');

const server = app.listen(env.port, () => {
  logger.info({ port: env.port }, 'eventrelay-api listening');
});

// Free-tier single-process mode: also run worker + dispatcher in here.
// Failures here must never take the API down, hence the catch.
if (process.env.RUN_BACKGROUND === 'true') {
  const { startBackground } = require('./background');
  startBackground().catch((err) => logger.error({ err }, 'embedded background mode failed to start'));
}

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  // Don't hang forever on keep-alive sockets.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
