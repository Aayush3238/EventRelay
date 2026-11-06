const env = require('./config/env');

env.assertLeaseSafety(); // fail fast before we accept a single request

const app = require('./app');
const logger = require('./lib/logger');
const { pool } = require('./db/pool');

const server = app.listen(env.port, () => {
  logger.info({ port: env.port }, 'eventrelay-api listening');
});

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
