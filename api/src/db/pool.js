// One pool for the API process. withTransaction is the only sane way to do
// multi-statement writes here — hand-rolled BEGIN/COMMIT leaks connections.
const { Pool } = require('pg');
const env = require('../config/env');

// Neon/Upstash-style URLs carry sslmode=require — pg needs an explicit
// ssl option or those connections fail with a confusing error.
const ssl = /sslmode=require/.test(env.databaseUrl) ? { rejectUnauthorized: false } : false;
const pool = new Pool({ connectionString: env.databaseUrl, max: 20, ssl });

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already dead */ }
    throw err;
  } finally {
    client.release();
  }
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query, withTransaction };
