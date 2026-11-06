// BullMQ wiring. Note what's NOT here: no retries, no delays. Postgres
// `available_at` is the scheduler; Redis is just a fast hand-off mechanism.
const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const config = require('./config');

function createConnection() {
  // BullMQ needs maxRetriesPerRequest: null or it throws on blocking commands.
  return new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
}

function createQueue() {
  return new Queue('deliveries', { connection: createConnection() });
}

module.exports = { createQueue, createConnection };
