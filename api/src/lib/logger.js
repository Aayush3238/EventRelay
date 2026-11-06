// Structured logs. Redact anything that looks like a secret — logs are the
// first place people accidentally commit credentials to.
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'password', 'signing_secret', 'ENCRYPTION_KEY'],
    censor: '[redacted]',
  },
  base: { service: 'eventrelay-api' },
});

module.exports = logger;
