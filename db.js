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

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1;

    -- Admin/owner accounts for the separate owner dashboard (admin.html).
    -- role = 'admin' always has full access to every page, regardless of
    -- the permissions column — that's the owner's role. Any other role
    -- (e.g. 'staff') is limited to whatever permissions lists as true.
    CREATE TABLE IF NOT EXISTS admin_users (
      id                    SERIAL PRIMARY KEY,
      name                  TEXT NOT NULL,
      email                 TEXT UNIQUE NOT NULL,
      password_hash         TEXT NOT NULL,
      role                  TEXT NOT NULL DEFAULT 'staff', -- 'admin' or 'staff'
      permissions           JSONB NOT NULL DEFAULT '{"orders": true, "stats": false, "settings": false}',
      must_change_password  BOOLEAN NOT NULL DEFAULT true,
      active                BOOLEAN NOT NULL DEFAULT true,
      created_at            TIMESTAMPTZ DEFAULT now()
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

// Creates the very first owner/admin account, but only if admin_users is
// completely empty — safe to call on every boot. Reads the initial email
// and password from env vars you set once in Render; the owner is forced
// to change that password on first login (see must_change_password).
async function seedInitialAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admin_users');
  if (rows[0].count > 0) return; // already seeded, never overwrite

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_INITIAL_PASSWORD;
  if (!email || !password) {
    console.warn('[admin] No admin_users yet, and ADMIN_EMAIL/ADMIN_INITIAL_PASSWORD are not set — ' +
      'the owner dashboard has no way to log in until you set them in Render → Environment and redeploy.');
    return;
  }

  const bcrypt = require('bcryptjs');
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO admin_users (name, email, password_hash, role, permissions, must_change_password)
     VALUES ('Власник', $1, $2, 'admin', '{"orders":true,"stats":true,"settings":true}', true)`,
    [email.toLowerCase(), passwordHash]
  );
  console.log(`[admin] Seeded initial owner account for ${email}. Change the password on first login.`);
}

module.exports = { pool, initSchema, seedInitialAdmin };
