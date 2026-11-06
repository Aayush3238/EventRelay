// Central env access. Fail fast on the stuff that would silently break
// signing/encryption later — finding out at delivery time is worse.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const leaseMs = Number(process.env.DELIVERY_LEASE_MS || 100000);
const maxTimeout = Number(process.env.MAX_ENDPOINT_TIMEOUT_MS || 30000);

function assertLeaseSafety() {
  // Plan §7.3: lease must comfortably exceed the worst-case endpoint timeout,
  // otherwise a healthy worker could lose its lease mid-delivery.
  const minimum = maxTimeout * 3 + 10000;
  if (leaseMs < minimum) {
    throw new Error(
      `DELIVERY_LEASE_MS=${leaseMs} is too small: needs >= ${minimum} ` +
      `(3x MAX_ENDPOINT_TIMEOUT_MS=${maxTimeout} + 10s margin)`
    );
  }
  if ((process.env.NODE_ENV || 'development') === 'production') {
    if (String(process.env.ALLOW_LOCAL_ENDPOINTS || '').toLowerCase() === 'true') {
      throw new Error('ALLOW_LOCAL_ENDPOINTS=true is forbidden in production');
    }
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
      throw new Error('JWT_SECRET must be set (>=32 chars) in production');
    }
    if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY must be set in production');
  }
}

module.exports = {
  port: Number(process.env.PORT || 4000),
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'postgres://eventrelay:eventrelay@localhost:5432/eventrelay',
  leaseMs,
  maxTimeoutMs: maxTimeout,
  maxEventPayloadBytes: Number(process.env.MAX_EVENT_PAYLOAD_BYTES || 262144),
  assertLeaseSafety,
};
