const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db/pool');
const { signJwt, httpError } = require('../middleware/auth');
const { validate, registerSchema, loginSchema } = require('../middleware/validate');

const router = express.Router();

// Passwords are human-chosen, low-entropy → bcrypt cost 12. (API keys are
// the opposite case; see shared/crypto.js for why they use SHA-256.)
router.post('/register', validate(registerSchema), async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const { rows } = await query(
        `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
         RETURNING id, name, email, created_at`,
        [name, email.toLowerCase(), passwordHash],
      );
      const user = rows[0];
      return res.status(201).json({ user, token: signJwt(user) });
    } catch (err) {
      if (err.code === '23505') return next(httpError(409, 'CONFLICT', 'Email already registered'));
      throw err;
    }
  } catch (err) {
    return next(err);
  }
});

router.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];
    // Same response either way — don't leak "email exists" to strangers.
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) return next(httpError(401, 'UNAUTHORIZED', 'Invalid email or password'));
    const safe = { id: user.id, name: user.name, email: user.email, created_at: user.created_at };
    return res.json({ user: safe, token: signJwt(safe) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
