'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 10000
});

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', ['world-shop-v2']);
  if (applied.rowCount) {
    console.log('Database schema world-shop-v2 already applied');
    return;
  }

  const schemaPath = path.join(__dirname, 'database', 'schema.sql');
  let schema = fs.readFileSync(schemaPath, 'utf8')
    .replace(/^\\s*BEGIN\\s*;?/i, '')
    .replace(/COMMIT\\s*;?\\s*$/i, '');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One-time reset of this project's legacy tables, explicitly authorized by the owner.
    await client.query(`
      DROP TABLE IF EXISTS transactions CASCADE;
      DROP TABLE IF EXISTS orders CASCADE;
      DROP TABLE IF EXISTS payments CASCADE;
      DROP TABLE IF EXISTS activation_keys CASCADE;
      DROP TABLE IF EXISTS products CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);
    await client.query(schema);
    await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', ['world-shop-v2']);
    await client.query('COMMIT');
    console.log('Database reset and migrated to world-shop-v2');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

migrate()
  .catch(error => {
    console.error('Database migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
