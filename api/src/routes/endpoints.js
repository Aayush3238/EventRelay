const express = require('express');
const crypto = require('node:crypto');
const { query, withTransaction } = require('../db/pool');
const { requireJwt, httpError } = require('../middleware/auth');
const { validate, endpointSchema } = require('../middleware/validate');
const { encryptSecret, generateSigningSecret } = require('@eventrelay/shared').crypto;
const { validateEndpointUrl, SsrfError } = require('@eventrelay/shared').ssrf;
const env = require('../config/env');

const router = express.Router();
router.use(requireJwt);

// Never leak signing_secret_encrypted (or anything derived from it) here.
const PUBLIC_COLS = `id, user_id, name, url, is_active, deleted_at, timeout_ms, max_attempts, created_at, updated_at`;

async function withSubscriptions(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const { rows: subs } = await query(
    'SELECT endpoint_id, event_type FROM endpoint_event_types WHERE endpoint_id = ANY($1::uuid[]) ORDER BY event_type',
    [ids]
  );
  const byId = new Map(ids.map((id) => [id, []]));
  for (const s of subs) byId.get(s.endpoint_id).push(s.event_type);
  return rows.map((r) => ({ ...r, eventTypes: byId.get(r.id) }));
}

async function validateUrlOrThrow(url, timeoutMs) {
  // Lease inequality (plan §7.3): lease must cover 3x worst timeout + margin.
  if (timeoutMs * 3 + 10000 > env.leaseMs) {
    throw httpError(422, 'VALIDATION_ERROR',
      `timeoutMs=${timeoutMs} violates the lease rule: needs DELIVERY_LEASE_MS >= ${timeoutMs * 3 + 10000}`);
  }
  try {
    await validateEndpointUrl(url);
  } catch (err) {
    if (err instanceof SsrfError || err.code === 'SSRF_BLOCKED') {
      throw httpError(422, 'SSRF_BLOCKED', err.message);
    }
    // DNS failure etc. — let the operator fix the hostname.
    throw httpError(422, 'VALIDATION_ERROR', `Could not validate endpoint host: ${err.message}`);
  }
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${PUBLIC_COLS} FROM endpoints WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ endpoints: await withSubscriptions(rows) });
  } catch (err) { next(err); }
});

router.post('/', validate(endpointSchema), async (req, res, next) => {
  try {
    const { name, url, eventTypes, timeoutMs, maxAttempts, isActive } = req.body;
    await validateUrlOrThrow(url, timeoutMs);
    const secret = generateSigningSecret();
    const created = await withTransaction(async (client) => {
      const id = crypto.randomUUID();
      const { rows } = await client.query(
        `INSERT INTO endpoints (id, user_id, name, url, signing_secret_encrypted, timeout_ms, max_attempts, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${PUBLIC_COLS}`,
        [id, req.user.id, name, url, encryptSecret(secret), timeoutMs, maxAttempts, isActive]
      );
      for (const t of eventTypes) {
        await client.query('INSERT INTO endpoint_event_types (endpoint_id, event_type) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, t]);
      }
      return rows[0];
    });
    // signingSecret shown once, like API keys. It's the HMAC key the receiver
    // needs to verify signatures — store it safely, we can't show it again.
    res.status(201).json({ endpoint: { ...created, eventTypes }, signingSecret: secret });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${PUBLIC_COLS} FROM endpoints WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return next(httpError(404, 'NOT_FOUND', 'Endpoint not found'));
    const [endpoint] = await withSubscriptions(rows);
    res.json({ endpoint });
  } catch (err) { next(err); }
});

router.put('/:id', validate(endpointSchema), async (req, res, next) => {
  try {
    const { name, url, eventTypes, timeoutMs, maxAttempts, isActive } = req.body;
    await validateUrlOrThrow(url, timeoutMs);
    const updated = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE endpoints SET name=$1, url=$2, timeout_ms=$3, max_attempts=$4, is_active=$5, updated_at=NOW()
         WHERE id=$6 AND user_id=$7 AND deleted_at IS NULL RETURNING ${PUBLIC_COLS}`,
        [name, url, timeoutMs, maxAttempts, isActive, req.params.id, req.user.id]
      );
      if (!rows.length) return null;
      await client.query('DELETE FROM endpoint_event_types WHERE endpoint_id = $1', [req.params.id]);
      for (const t of eventTypes) {
        await client.query('INSERT INTO endpoint_event_types (endpoint_id, event_type) VALUES ($1,$2)', [req.params.id, t]);
      }
      return rows[0];
    });
    if (!updated) return next(httpError(404, 'NOT_FOUND', 'Endpoint not found'));
    const [endpoint] = await withSubscriptions([updated]);
    res.json({ endpoint });
  } catch (err) { next(err); }
});

// Soft delete, deliberately. The endpoint row stays so historical deliveries
// still resolve; fan-out ignores it via is_active/deleted_at checks.
router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE endpoints SET deleted_at = NOW(), is_active = false, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return next(httpError(404, 'NOT_FOUND', 'Endpoint not found'));
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.post('/:id/rotate-secret', async (req, res, next) => {
  try {
    const secret = generateSigningSecret();
    const { rows } = await query(
      `UPDATE endpoints SET signing_secret_encrypted = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL RETURNING id`,
      [encryptSecret(secret), req.params.id, req.user.id]
    );
    if (!rows.length) return next(httpError(404, 'NOT_FOUND', 'Endpoint not found'));
    res.json({ signingSecret: secret });
  } catch (err) { next(err); }
});

module.exports = router;
