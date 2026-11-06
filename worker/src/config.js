const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

module.exports = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://eventrelay:eventrelay@localhost:5432/eventrelay',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  leaseMs: Number(process.env.DELIVERY_LEASE_MS || 100000),
  maxAttempts: Number(process.env.MAX_ATTEMPTS || 6),
  baseDelayMs: Number(process.env.BASE_RETRY_DELAY_MS || 5000),
  multiplier: Number(process.env.RETRY_MULTIPLIER || 2),
  maxDelayMs: Number(process.env.MAX_RETRY_DELAY_MS || 3600000),
  maxResponseBytes: Number(process.env.MAX_RESPONSE_BYTES || 65536),
  concurrency: Number(process.env.WORKER_CONCURRENCY || 10),
};
