const express = require('express');
const crypto = require('node:crypto');
const { query } = require('../db/pool');
const { requireJwt, httpError } = require('../middleware/auth');
const { validate, createApiKeySchema } = require('../middleware/validate');
const { generateApiKey } = require('@eventrelay/shared').crypto;

const router = express.Router();
router.use(requireJwt);

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, key_prefix, last_used_at, expires_at, created_at, revoked_at
       FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id],
    );
    res.json({ apiKeys: rows });
  } catch (err) {
    next(err);
  }
});

// The raw key is returned exactly once, here. After this response it's gone —
// we only keep SHA-256(raw) + the display prefix, so even a DB dump can't
// reconstruct usable keys.
router.post('/', validate(createApiKeySchema), async (req, res, next) => {
  try {
    const { name, expiresAt } = req.body;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { raw, prefix, hash } = generateApiKey();
      try {
        const { rows } = await query(
          `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, name, key_prefix, expires_at, created_at`,
          [crypto.randomUUID(), req.user.id, name, prefix, hash, expiresAt || null],
        );
        return res.status(201).json({ apiKey: rows[0], rawKey: raw });
      } catch (err) {
        if (err.code === '23505') continue; // prefix collision — regenerate
        throw err;
      }
    }
    return next(httpError(500, 'INTERNAL_ERROR', 'Could not generate a unique API key'));
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE api_keys SET revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) return next(httpError(404, 'NOT_FOUND', 'API key not found'));
    res.json({ revoked: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
