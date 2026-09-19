const { Pool } = require('pg');

// Render's managed Postgres requires SSL in production but not in local dev.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Creates the tables if they don't exist yet. Safe to run on every boot.
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id            TEXT PRIMARY KEY,        -- offer id from the dropshipping.ua feed
      name          TEXT NOT NULL,
      description   TEXT,
      price         NUMERIC NOT NULL,        -- your cost from the supplier (drop price)
      retail_price  NUMERIC,                 -- what you actually sell it for — set manually
      category_id   TEXT,
      picture_url   TEXT,
      vendor        TEXT,
      available     BOOLEAN DEFAULT true,
      featured      BOOLEAN DEFAULT false,   -- mark your 3 finalists true so they show up first
      updated_at    TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id              SERIAL PRIMARY KEY,
      product_id      TEXT REFERENCES products(id),
      customer_name   TEXT NOT NULL,
      customer_phone  TEXT NOT NULL,
      customer_city   TEXT,
      np_branch       TEXT,                  -- Nova Poshta branch/address
      comment         TEXT,
      status          TEXT DEFAULT 'new',    -- new -> confirmed -> ordered_from_supplier -> shipped -> done
      ttn             TEXT,                  -- tracking number, filled in once you ship
      created_at      TIMESTAMPTZ DEFAULT now()
    );
  `);
}

module.exports = { pool, initSchema };
