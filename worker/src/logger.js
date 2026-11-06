const pino = require('pino');
module.exports = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: { paths: ['signing_secret', 'ENCRYPTION_KEY', 'secret'], censor: '[redacted]' },
  base: { service: 'eventrelay-worker' },
});
