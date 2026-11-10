const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('../db/pool');
const { verifyApiKeyHash } = require('@eventrelay/shared').crypto;

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function requireJwt(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw httpError(401, 'UNAUTHORIZED', 'Missing bearer token');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (err) {
    if (err.status) return next(err);
    return next(httpError(401, 'UNAUTHORIZED', 'Invalid or expired token'));
  }
}

// API-key auth for POST /v1/events. Lookup is by the 16-char prefix (UNIQUE),
// then SHA-256 compare in constant time. No bcrypt on this hot path.
async function requireApiKey(req, _res, next) {
  try {
    const raw = req.headers['x-api-key'];
    if (!raw || typeof raw !== 'string') throw httpError(401, 'UNAUTHORIZED', 'Missing X-API-Key header');
    const prefix = raw.slice(0, 16);
    const { rows } = await query(
      `SELECT id, user_id, key_hash, revoked_at, expires_at FROM api_keys WHERE key_prefix = $1`,
      [prefix],
    );
    const key = rows[0];
    if (!key || !verifyApiKeyHash(raw, key.key_hash)) {
      throw httpError(401, 'UNAUTHORIZED', 'Invalid API key');
    }
    if (key.revoked_at) throw httpError(401, 'UNAUTHORIZED', 'API key revoked');
    if (key.expires_at && new Date(key.expires_at) <= new Date()) {
      throw httpError(401, 'UNAUTHORIZED', 'API key expired');
    }
    req.apiKey = key;
    req.userId = key.user_id;
    // Best-effort bookkeeping; never fail the request over this.
    query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [key.id]).catch(() => {});
    return next();
  } catch (err) {
    return next(err);
  }
}

function signJwt(user) {
  return jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '24h' });
}

module.exports = { requireJwt, requireApiKey, signJwt, httpError, bcrypt };
