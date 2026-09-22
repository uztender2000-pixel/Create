const { Pool } = require('pg');

// Render's managed Postgres requires SSL in production but not in local dev.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Creates the tables if they don't exist yet, and adds any new columns to
// an already-existing table. Safe to run on every boot.
async function initSchema() {
  // ---------------------------------------------------------------------
  // 1. suppliers — the new heart of the system. Every product and every
  //    order line now belongs to exactly one supplier, and each supplier
  //    is served by an "adapter" (a module in services/suppliers/) that
  //    knows how to talk to that particular supplier.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id                SERIAL PRIMARY KEY,
      code              TEXT UNIQUE NOT NULL,             -- 'dropshipping_ua', 'brain', 'mti', ...
      name              TEXT NOT NULL,
      adapter           TEXT NOT NULL DEFAULT 'yml_feed', -- which module in services/suppliers handles it
      feed_urls         TEXT[] DEFAULT '{}',              -- for feed-based adapters
      api_url           TEXT,                             -- for API-based adapters
      api_key           TEXT,                             -- never exposed through the admin API
      api_login         TEXT,
      config            JSONB NOT NULL DEFAULT '{}',      -- anything adapter-specific
      markup_percent    NUMERIC NOT NULL DEFAULT 0,       -- default markup for this supplier's products
      auto_order        BOOLEAN NOT NULL DEFAULT false,   -- send orders automatically via the adapter
      active            BOOLEAN NOT NULL DEFAULT true,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      last_sync_at      TIMESTAMPTZ,
      last_sync_status  TEXT,                             -- 'ok' | 'error'
      last_sync_message TEXT,
      created_at        TIMESTAMPTZ DEFAULT now()
    );
  `);

  // ---------------------------------------------------------------------
  // 2. Core tables. On a brand-new database these are created in their
  //    multi-supplier form straight away. On an existing database the
  //    CREATE ... IF NOT EXISTS below is a no-op and the migration block
  //    further down converts the old single-supplier tables in place.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id                  BIGSERIAL PRIMARY KEY,     -- OUR id, stable across suppliers
      supplier_id         INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      supplier_product_id TEXT NOT NULL,             -- the id/offer id used by that supplier
      name                TEXT NOT NULL,
      description         TEXT,
      price               NUMERIC NOT NULL,          -- your cost from the supplier (drop price)
      retail_price        NUMERIC,                   -- what you actually sell it for
      price_overridden    BOOLEAN NOT NULL DEFAULT false, -- true once you set the price by hand
      markup_percent      NUMERIC,                   -- per-product markup, overrides the supplier default
      category_id         TEXT,
      category_name       TEXT,
      section             TEXT,
      picture_url         TEXT,
      pictures            TEXT[],
      vendor_code         TEXT,
      params              JSONB,
      vendor              TEXT,
      stock               INTEGER,                   -- units in stock when the supplier reports a number
      available           BOOLEAN DEFAULT true,
      featured            BOOLEAN DEFAULT false,
      last_seen_at        TIMESTAMPTZ DEFAULT now(), -- last time this product appeared in a sync
      updated_at          TIMESTAMPTZ DEFAULT now(),
      UNIQUE (supplier_id, supplier_product_id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      phone         TEXT,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id              SERIAL PRIMARY KEY,
      product_id      BIGINT REFERENCES products(id),
      quantity        INTEGER DEFAULT 1,
      customer_name   TEXT NOT NULL,
      customer_phone  TEXT NOT NULL,
      customer_city   TEXT,
      np_branch       TEXT,
      comment         TEXT,
      status          TEXT DEFAULT 'new',
      ttn             TEXT,
      user_id         INTEGER,
      created_at      TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id  BIGINT NOT NULL REFERENCES products(id),
      quantity    INTEGER NOT NULL DEFAULT 1,
      added_at    TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (user_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id                    SERIAL PRIMARY KEY,
      name                  TEXT NOT NULL,
      email                 TEXT UNIQUE NOT NULL,
      password_hash         TEXT NOT NULL,
      role                  TEXT NOT NULL DEFAULT 'staff',
      permissions           JSONB NOT NULL DEFAULT '{"orders": true, "stats": false, "settings": false}',
      must_change_password  BOOLEAN NOT NULL DEFAULT true,
      active                BOOLEAN NOT NULL DEFAULT true,
      created_at            TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Columns added to users/orders by earlier versions — kept as-is.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_code_expires TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_code_expires TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saved_delivery_method TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saved_city TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saved_city_ref TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saved_branch TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS saved_courier_address TEXT;

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id INTEGER;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_submitted BOOLEAN DEFAULT false;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_method TEXT DEFAULT 'branch';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS np_city TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_address TEXT;
  `);

  // ---------------------------------------------------------------------
  // 3. MIGRATION: single-supplier -> multi-supplier.
  //
  //    Runs only when products.id is still TEXT (the old schema, where the
  //    primary key was the dropshipping.ua offer id). It:
  //      * registers dropshipping.ua as the first supplier
  //      * gives every existing product a numeric id of our own, keeping
  //        the old id as supplier_product_id
  //      * repoints orders.product_id and cart_items.product_id at new ids
  //    No rows are lost and no order loses its product link.
  // ---------------------------------------------------------------------
  await pool.query(`
    DO $mig$
    DECLARE
      legacy_supplier_id INTEGER;
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'products' AND column_name = 'id' AND data_type = 'text'
      ) THEN
        RAISE NOTICE '[migration] converting products to the multi-supplier schema...';

        INSERT INTO suppliers (code, name, adapter, active)
        VALUES ('dropshipping_ua', 'Dropshipping.ua', 'yml_feed', true)
        ON CONFLICT (code) DO NOTHING;
        SELECT id INTO legacy_supplier_id FROM suppliers WHERE code = 'dropshipping_ua';

        ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id INTEGER;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_product_id TEXT;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS price_overridden BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS markup_percent NUMERIC;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INTEGER;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT now();

        UPDATE products
           SET supplier_id = legacy_supplier_id,
               supplier_product_id = id
         WHERE supplier_product_id IS NULL;

        -- Any product whose retail price was already set by hand keeps it:
        -- mark it as overridden so future syncs never overwrite it again.
        UPDATE products
           SET price_overridden = true
         WHERE retail_price IS NOT NULL AND retail_price <> price;

        CREATE SEQUENCE IF NOT EXISTS products_id_seq;
        ALTER TABLE products ADD COLUMN new_id BIGINT;
        UPDATE products SET new_id = nextval('products_id_seq');

        -- Repoint the two tables that reference products.
        ALTER TABLE orders ADD COLUMN new_product_id BIGINT;
        UPDATE orders o SET new_product_id = p.new_id FROM products p WHERE p.id = o.product_id;

        ALTER TABLE cart_items ADD COLUMN new_product_id BIGINT;
        UPDATE cart_items c SET new_product_id = p.new_id FROM products p WHERE p.id = c.product_id;

        ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_product_id_fkey;
        ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_product_id_fkey;
        ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_pkey;

        ALTER TABLE orders DROP COLUMN product_id;
        ALTER TABLE orders RENAME COLUMN new_product_id TO product_id;
        ALTER TABLE cart_items DROP COLUMN product_id;
        ALTER TABLE cart_items RENAME COLUMN new_product_id TO product_id;

        -- Swap the products primary key over to the new numeric id.
        ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pkey;
        ALTER TABLE products DROP COLUMN id;
        ALTER TABLE products RENAME COLUMN new_id TO id;
        ALTER TABLE products ALTER COLUMN id SET NOT NULL;
        ALTER TABLE products ALTER COLUMN id SET DEFAULT nextval('products_id_seq');
        ALTER SEQUENCE products_id_seq OWNED BY products.id;
        ALTER TABLE products ADD PRIMARY KEY (id);

        ALTER TABLE products ALTER COLUMN supplier_id SET NOT NULL;
        ALTER TABLE products ALTER COLUMN supplier_product_id SET NOT NULL;
        ALTER TABLE products ADD CONSTRAINT products_supplier_product_unique
          UNIQUE (supplier_id, supplier_product_id);
        ALTER TABLE products ADD CONSTRAINT products_supplier_id_fkey
          FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE;

        ALTER TABLE cart_items ALTER COLUMN product_id SET NOT NULL;
        ALTER TABLE cart_items ADD PRIMARY KEY (user_id, product_id);
        ALTER TABLE orders ADD CONSTRAINT orders_product_id_fkey
          FOREIGN KEY (product_id) REFERENCES products(id);
        ALTER TABLE cart_items ADD CONSTRAINT cart_items_product_id_fkey
          FOREIGN KEY (product_id) REFERENCES products(id);

        RAISE NOTICE '[migration] done.';
      END IF;
    END
    $mig$;
  `);

  // ---------------------------------------------------------------------
  // 4. Per-supplier order tracking. One order row = one product from one
  //    supplier; group_id ties together every row that came from the same
  //    checkout, so a two-supplier basket is still one order for the
  //    customer while being two separate submissions for you.
  // ---------------------------------------------------------------------
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS group_id UUID;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_order_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_status TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_error TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS unit_price NUMERIC;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS cost_price NUMERIC;

    UPDATE orders o SET supplier_id = p.supplier_id
      FROM products p WHERE p.id = o.product_id AND o.supplier_id IS NULL;

    -- Journal of SQL run from the admin panel with write access enabled.
    CREATE TABLE IF NOT EXISTS admin_sql_log (
      id         SERIAL PRIMARY KEY,
      admin_id   INTEGER,
      admin_email TEXT,
      query      TEXT NOT NULL,
      outcome    TEXT NOT NULL,          -- 'ok' | 'error' | 'bad_password'
      detail     TEXT,                   -- row counts or the error message
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- Забираємо стару назву розділу з уже завантажених товарів.
    UPDATE products SET section = 'Інші товари' WHERE section = 'Товари-бестселери🔥';
    UPDATE products SET category_name = 'Інші товари' WHERE category_name = 'Товари-бестселери🔥';

    CREATE INDEX IF NOT EXISTS idx_products_supplier ON products (supplier_id);
    CREATE INDEX IF NOT EXISTS idx_products_available ON products (available);
    CREATE INDEX IF NOT EXISTS idx_products_section ON products (section);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);
    CREATE INDEX IF NOT EXISTS idx_orders_group ON orders (group_id);
    CREATE INDEX IF NOT EXISTS idx_orders_supplier ON orders (supplier_id);
  `);
}

// Creates the very first owner/admin account, but only if admin_users is
// completely empty — safe to call on every boot.
async function seedInitialAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admin_users');
  if (rows[0].count > 0) return;

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

// Backwards compatibility with the old FEED_1_URL..FEED_5_URL variables:
// if they're set and dropshipping.ua has no feeds registered yet, fill them
// in from the environment. After that the database is the source of truth
// and these vars are ignored — you manage feeds through the admin API.
async function seedSuppliersFromEnv() {
  const urls = [];
  for (let i = 1; i <= 5; i++) {
    const url = process.env[`FEED_${i}_URL`];
    if (url && url.trim()) urls.push(url.trim());
  }
  if (!urls.length) return;

  const { rows } = await pool.query('SELECT id, feed_urls FROM suppliers WHERE code = $1', ['dropshipping_ua']);

  if (!rows.length) {
    await pool.query(
      `INSERT INTO suppliers (code, name, adapter, feed_urls, api_url, api_key, active, auto_order)
       VALUES ('dropshipping_ua', 'Dropshipping.ua', 'yml_feed', $1, $2, $3, true, $4)`,
      [
        urls,
        process.env.SUPPLIER_API_URL || null,
        process.env.SUPPLIER_API_KEY || null,
        Boolean(process.env.SUPPLIER_API_URL && process.env.SUPPLIER_API_KEY),
      ]
    );
    console.log(`[suppliers] Registered dropshipping.ua from environment with ${urls.length} feed(s).`);
    return;
  }

  if (!rows[0].feed_urls || rows[0].feed_urls.length === 0) {
    await pool.query('UPDATE suppliers SET feed_urls = $2 WHERE id = $1', [rows[0].id, urls]);
    console.log(`[suppliers] Filled in ${urls.length} feed URL(s) for dropshipping.ua from environment.`);
  }
}

module.exports = { pool, initSchema, seedInitialAdmin, seedSuppliersFromEnv };
