// Dev seed: one user, one API key, one local endpoint subscribed to order.created.
// Run migrations first. The printed API key + signing secret are shown once.
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { generateApiKey, generateSigningSecret, encryptSecret } = require('../packages/shared/src/crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://eventrelay:eventrelay@localhost:5432/eventrelay',
});

async function main() {
  const email = 'dev@example.com';
  const passwordHash = await bcrypt.hash('dev-password-123', 12);
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash) VALUES ('Dev', $1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [email, passwordHash],
  );
  const userId = rows[0].id;

  const { raw, prefix, hash } = generateApiKey();
  await pool.query(
    `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash)
     VALUES ($1, $2, 'seed', $3, $4) ON CONFLICT (key_prefix) DO NOTHING`,
    [crypto.randomUUID(), userId, prefix, hash],
  );

  const secret = generateSigningSecret();
  const epId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO endpoints (id, user_id, name, url, signing_secret_encrypted)
     VALUES ($1, $2, 'local receiver', 'http://localhost:5001/webhook', $3)`,
    [epId, userId, encryptSecret(secret)],
  );
  await pool.query(
    `INSERT INTO endpoint_event_types (endpoint_id, event_type)
     VALUES ($1, 'order.created') ON CONFLICT DO NOTHING`,
    [epId],
  );

  console.log(
    JSON.stringify(
      {
        hint: 'seeded dev user',
        email,
        password: 'dev-password-123',
        apiKey: raw,
        signingSecret: secret,
        note: 'start receiver: npm run dev:receiver -- 5001 ' + secret,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
