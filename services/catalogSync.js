const { pool } = require('../db');
const { getAdapter } = require('./suppliers');
const { logEvent } = require('./logger');

// =====================================================================
// Catalogue synchronisation.
//
// Works for every supplier regardless of protocol: it asks the supplier's
// adapter for products, writes them in batches, and afterwards marks as
// unavailable anything that supplier didn't send this time round.
//
// Two rules that the old importer got wrong and this one gets right:
//
//   1. YOUR RETAIL PRICE IS NEVER OVERWRITTEN. Once you set a price by
//      hand (price_overridden = true), syncing only updates the cost
//      price. Otherwise retail_price is recalculated from the cost plus
//      the markup (per-product markup wins over the supplier default).
//
//   2. PRODUCTS THAT VANISH FROM THE FEED GO OFFLINE. Anything not seen
//      during this sync gets available = false, instead of hanging around
//      in the catalogue forever and being sold when the supplier no
//      longer has it.
// =====================================================================

const BATCH_SIZE = 500;

// Batch upsert via UNNEST: one round-trip per 500 products instead of 500
// round-trips. On a 40 000-product catalogue this is the difference
// between a sync that finishes in a minute and one that doesn't finish.
async function upsertBatch(client, supplier, items, syncStartedAt) {
  if (!items.length) return 0;

  const cols = {
    supplierProductId: [],
    name: [],
    description: [],
    price: [],
    categoryId: [],
    categoryName: [],
    section: [],
    pictureUrl: [],
    pictures: [],
    vendorCode: [],
    params: [],
    vendor: [],
    stock: [],
    available: [],
  };

  for (const p of items) {
    cols.supplierProductId.push(String(p.supplierProductId));
    cols.name.push(p.name || '');
    cols.description.push(p.description || '');
    cols.price.push(Number.isFinite(p.price) ? p.price : 0);
    cols.categoryId.push(p.categoryId || null);
    cols.categoryName.push(p.categoryName || null);
    cols.section.push(p.section || null);
    cols.pictureUrl.push(p.pictureUrl || null);
    // Passed as a JSON string per row and expanded back into a text[]
    // inside SQL — UNNEST cannot take a two-dimensional array of pictures.
    cols.pictures.push(JSON.stringify(Array.isArray(p.pictures) ? p.pictures : []));
    cols.vendorCode.push(p.vendorCode || null);
    cols.params.push(JSON.stringify(p.params || {}));
    cols.vendor.push(p.vendor || null);
    cols.stock.push(Number.isFinite(p.stock) ? p.stock : null);
    cols.available.push(p.available !== false);
  }

  await client.query(
    `
    INSERT INTO products (
      supplier_id, supplier_product_id, name, description, price, retail_price,
      category_id, category_name, section, picture_url, pictures,
      vendor_code, params, vendor, stock, available, last_seen_at, updated_at
    )
    SELECT
      $1,
      t.supplier_product_id,
      t.name,
      t.description,
      t.price,
      -- Initial retail price for a brand-new product: cost + markup.
      ROUND(t.price * (1 + $16::numeric / 100), 2),
      t.category_id,
      t.category_name,
      t.section,
      t.picture_url,
      ARRAY(SELECT jsonb_array_elements_text(t.pictures::jsonb)),
      t.vendor_code,
      t.params::jsonb,
      t.vendor,
      t.stock,
      t.available,
      $17::timestamptz, $17::timestamptz
    FROM UNNEST(
      $2::text[], $3::text[], $4::text[], $5::numeric[], $6::text[], $7::text[],
      $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[],
      $14::int[], $15::boolean[]
    ) AS t(
      supplier_product_id, name, description, price, category_id, category_name,
      section, picture_url, pictures, vendor_code, params, vendor,
      stock, available
    )
    ON CONFLICT (supplier_id, supplier_product_id) DO UPDATE SET
      name          = EXCLUDED.name,
      description   = EXCLUDED.description,
      price         = EXCLUDED.price,
      -- The rule that protects your margin: a hand-set price is left
      -- alone; otherwise recalculate from the new cost and the markup.
      retail_price  = CASE
                        WHEN products.price_overridden THEN products.retail_price
                        ELSE ROUND(
                          EXCLUDED.price * (1 + COALESCE(products.markup_percent, $16::numeric) / 100), 2)
                      END,
      category_id   = EXCLUDED.category_id,
      category_name = EXCLUDED.category_name,
      section       = EXCLUDED.section,
      picture_url   = EXCLUDED.picture_url,
      pictures      = EXCLUDED.pictures,
      vendor_code   = EXCLUDED.vendor_code,
      params        = EXCLUDED.params,
      vendor        = EXCLUDED.vendor,
      stock         = EXCLUDED.stock,
      available     = EXCLUDED.available,
      last_seen_at  = EXCLUDED.last_seen_at,
      updated_at    = EXCLUDED.updated_at
    `,
    [
      supplier.id,
      cols.supplierProductId,
      cols.name,
      cols.description,
      cols.price,
      cols.categoryId,
      cols.categoryName,
      cols.section,
      cols.pictureUrl,
      cols.pictures,
      cols.vendorCode,
      cols.params,
      cols.vendor,
      cols.stock,
      cols.available,
      Number(supplier.markup_percent) || 0,
      syncStartedAt,
    ]
  );

  return items.length;
}

// Syncs one supplier. Returns { supplier, imported, deactivated }.
async function syncSupplier(supplier) {
  const adapter = getAdapter(supplier);
  if (!adapter.capabilities?.catalog) {
    throw new Error(`Адаптер "${supplier.adapter}" не вміє віддавати каталог`);
  }

  const syncStartedAt = new Date();
  const client = await pool.connect();
  let imported = 0;

  try {
    imported = await adapter.fetchCatalog(
      supplier,
      async (batch) => {
        await upsertBatch(client, supplier, batch, syncStartedAt);
      },
      { batchSize: BATCH_SIZE }
    );

    // Anything this supplier didn't send this time is no longer on sale.
    // Scoped to this supplier only — other suppliers' products untouched.
    const { rowCount: deactivated } = await client.query(
      `UPDATE products
          SET available = false, updated_at = now()
        WHERE supplier_id = $1
          AND available = true
          AND (last_seen_at IS NULL OR last_seen_at < $2)`,
      [supplier.id, syncStartedAt]
    );

    await client.query(
      `UPDATE suppliers
          SET last_sync_at = now(), last_sync_status = 'ok',
              last_sync_message = $2
        WHERE id = $1`,
      [supplier.id, `${imported} товарів оновлено, ${deactivated} знято з продажу`]
    );

    return { supplier: supplier.name, imported, deactivated };
  } catch (err) {
    await pool.query(
      `UPDATE suppliers
          SET last_sync_at = now(), last_sync_status = 'error', last_sync_message = $2
        WHERE id = $1`,
      [supplier.id, String(err.message).slice(0, 500)]
    );
    await logEvent({
      source: 'sync',
      supplierId: supplier.id,
      message: `Синхронізація "${supplier.name}" не вдалась: ${err.message}`,
      detail: err.stack,
    });
    throw err;
  } finally {
    client.release();
  }
}

// Syncs every active supplier. One failing supplier never stops the rest —
// with a marketplace pulling from several sources that matters: BRAIN
// being down for an hour shouldn't empty your MTI catalogue.
async function syncAllSuppliers() {
  const { rows: suppliers } = await pool.query(
    'SELECT * FROM suppliers WHERE active = true ORDER BY sort_order, id'
  );

  if (!suppliers.length) {
    console.warn('[sync] Жодного активного постачальника — нічого імпортувати.');
    return [];
  }

  const results = [];
  for (const supplier of suppliers) {
    try {
      const result = await syncSupplier(supplier);
      console.log(`[sync] ${supplier.name}: ${result.imported} оновлено, ${result.deactivated} знято з продажу`);
      results.push(result);
    } catch (err) {
      console.error(`[sync] ${supplier.name} — помилка:`, err.message);
      results.push({ supplier: supplier.name, error: err.message });
    }
  }
  return results;
}

async function syncSupplierById(supplierId) {
  const { rows } = await pool.query('SELECT * FROM suppliers WHERE id = $1', [supplierId]);
  if (!rows.length) throw new Error('Постачальника не знайдено');
  return syncSupplier(rows[0]);
}

module.exports = { syncAllSuppliers, syncSupplier, syncSupplierById };
