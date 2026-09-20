const { Pool } = require('pg');

// Render's managed Postgres requires SSL in production but not in local dev.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Creates the tables if they don't exist yet, and adds any new columns to
// an already-existing table. Safe to run on every boot.
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id            TEXT PRIMARY KEY,        -- offer id from the dropshipping.ua feed
      name          TEXT NOT NULL,
      description   TEXT,
      price         NUMERIC NOT NULL,        -- your cost from the supplier (drop price)
      retail_price  NUMERIC,                 -- what you actually sell it for
      category_id   TEXT,
      category_name TEXT,                    -- human-readable category, parsed from the feed
      section       TEXT,                    -- top-level section, e.g. "Зоотовари", "Дім", "Парфумерія"
      picture_url   TEXT,                     -- first image, used for grid cards
      pictures      TEXT[],                   -- every image from the feed, for the detail page gallery
      vendor_code   TEXT,                      -- supplier's SKU/article number
      params        JSONB,                     -- spec table: {"Об'єм": "500 мл", "Вага": "10 кг", ...}
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
      user_id         INTEGER,               -- who placed it, if logged in (NULL for guest checkout)
      created_at      TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      phone         TEXT,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT now()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_code_expires TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_code_expires TIMESTAMPTZ;
    -- Saved delivery info, so checkout can autofill it for repeat orders.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saved_delivery_method TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saved_city TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saved_city_ref TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saved_branch TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saved_courier_address TEXT;

    CREATE TABLE IF NOT EXISTS support_messages (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id  TEXT NOT NULL REFERENCES products(id),
      quantity    INTEGER NOT NULL DEFAULT 1,
      added_at    TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (user_id, product_id)
    );

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id INTEGER;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_submitted BOOLEAN DEFAULT false;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_method TEXT DEFAULT 'branch'; -- 'branch' or 'courier'
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS np_city TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_address TEXT;

    -- Safe on a table that already existed before this update: adds the two
    -- new columns without touching any existing data.
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category_name TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS section TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS pictures TEXT[];
    ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_code TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS params JSONB;
  `);
}

module.exports = { pool, initSchema };
