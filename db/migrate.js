// Tiny migration runner: applies db/migrations/*.sql once, in order.
// I chose this over a migrate library because 60 lines of pg code is easier
// to debug at 2am than a framework's naming conventions.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const connectionString = process.env.DATABASE_URL || 'postgres://eventrelay:eventrelay@localhost:5432/eventrelay';
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (rows.length) { console.log(`skip  ${file}`); continue; }
      console.log(`apply ${file}`);
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('migrations done');
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
