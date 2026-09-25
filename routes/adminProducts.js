const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');
const { getAdapter } = require('../services/suppliers');
const { upsertBatch } = require('../services/catalogSync');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('settings'));

// =====================================================================
// Product selection screen for "manual_selection" suppliers (Hubber,
// MyDrop, TradeEvo, and any future API-driven adapter): browse everything
// the last sync pulled in, filter it every way the supplier's own API
// allows, and decide per-product (or in bulk) whether it goes on sale —
// plus assign it into the admin's own category/subcategory tree.
//
// Nothing here talks to the supplier's API directly — it filters what's
// already sitting in `products` (+ raw_meta) after a sync, which is both
// faster and works identically for every adapter, generic or not.
// =====================================================================

// GET /api/admin/products — filtered, paginated product browser.
// Required: supplier_id.
// Optional filters (all mirror what Hubber's /product/cursor#marketplace
// itself supports, plus a few of our own on top):
//   included        'true' | 'false' | 'all'   (default 'all')
//   q                name, partial match
//   vendor_code      article, partial match
//   supplier_product_id  the supplier's own id, partial match
//   category_id      raw category id as reported by the supplier
//   vendor           brand/vendor name, exact match
//   price_from / price_to           cost price range
//   availability     'in_stock' | 'out_of_stock' | 'all' (default 'all')
//   status_id        Hubber moderation status (raw_meta.statusId)
//   is_top           'true' | 'false'          (raw_meta.isTop)
//   hubber_supplier_id                          (raw_meta.hubberSupplierId)
//   edited_from / edited_to   ISO dates          (raw_meta.editedAt)
//   has_photo        'true' | 'false'
//   attr_name + attr_value    filter on a spec/attribute in `params`
//   shop_category_id 'unassigned' or a categories.id — already placed / not
//   sort             'newest' | 'name_asc' | 'price_asc' | 'price_desc'
//   page, limit
router.get('/', async (req, res) => {
  try {
    const {
      supplier_id, included, q, vendor_code, supplier_product_id, category_id,
      vendor, price_from, price_to, availability, status_id, is_top,
      hubber_supplier_id, edited_from, edited_to, has_photo,
      attr_name, attr_value, shop_category_id, sort,
    } = req.query;

    if (!supplier_id) return res.status(400).json({ error: 'supplier_id обов\'язковий' });

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const conditions = ['p.supplier_id = $1'];
    const params = [supplier_id];
    const add = (sql, value) => { params.push(value); conditions.push(sql.replace('?', `$${params.length}`)); };

    if (included === 'true') conditions.push('p.included = true');
    else if (included === 'false') conditions.push('p.included = false');

    if (q && q.trim()) add('p.name ILIKE ?', `%${q.trim()}%`);
    if (vendor_code && vendor_code.trim()) add('p.vendor_code ILIKE ?', `%${vendor_code.trim()}%`);
    if (supplier_product_id && supplier_product_id.trim()) add('p.supplier_product_id ILIKE ?', `%${supplier_product_id.trim()}%`);
    if (category_id) add('p.category_id = ?', category_id);
    if (vendor) add('p.vendor = ?', vendor);
    if (price_from) add('p.price >= ?', Number(price_from));
    if (price_to) add('p.price <= ?', Number(price_to));

    if (availability === 'in_stock') conditions.push('p.available = true');
    else if (availability === 'out_of_stock') conditions.push('p.available = false');

    if (status_id) add("p.raw_meta->>'statusId' = ?", String(status_id));
    if (is_top === 'true') conditions.push("(p.raw_meta->>'isTop')::boolean = true");
    else if (is_top === 'false') conditions.push("COALESCE((p.raw_meta->>'isTop')::boolean, false) = false");
    if (hubber_supplier_id) add("p.raw_meta->>'hubberSupplierId' = ?", String(hubber_supplier_id));
    if (edited_from) add("(p.raw_meta->>'editedAt')::timestamptz >= ?", edited_from);
    if (edited_to) add("(p.raw_meta->>'editedAt')::timestamptz <= ?", edited_to);

    if (has_photo === 'true') conditions.push('p.picture_url IS NOT NULL');
    else if (has_photo === 'false') conditions.push('p.picture_url IS NULL');

    // Attribute/spec filter (products.params is a flat {name: value} map) —
    // needs two placeholders (key + value), so it's built explicitly
    // rather than through the single-placeholder add() helper.
    if (attr_name && attr_name.trim()) {
      params.push(attr_name.trim());
      const keyIdx = params.length;
      if (attr_value && attr_value.trim()) {
        params.push(`%${attr_value.trim()}%`);
        conditions.push(`p.params ->> $${keyIdx} ILIKE $${params.length}`);
      } else {
        conditions.push(`p.params ? $${keyIdx}`);
      }
    }

    if (shop_category_id === 'unassigned') {
      conditions.push('NOT EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id)');
    } else if (shop_category_id) {
      add('EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ?)', shop_category_id);
    }

    const where = conditions.join(' AND ');

    const SORTS = {
      newest: 'p.updated_at DESC',
      name_asc: 'p.name ASC',
      price_asc: 'p.price ASC',
      price_desc: 'p.price DESC',
    };
    const orderBy = SORTS[sort] || SORTS.newest;

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM products p WHERE ${where}`, params
    );
    const total = countRows[0].total;

    const dataParams = [...params, limit, offset];
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.vendor_code, p.supplier_product_id, p.price, p.retail_price,
              p.category_id, p.category_name, p.section, p.vendor, p.picture_url,
              p.stock, p.available, p.included, p.raw_meta, p.updated_at,
              COALESCE(
                (SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name))
                   FROM product_categories pc JOIN categories c ON c.id = pc.category_id
                  WHERE pc.product_id = p.id),
                '[]'::jsonb
              ) AS shop_categories
         FROM products p
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({ products: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// GET /api/admin/products/filter-options?supplier_id=... — distinct values
// actually present for this supplier's imported products, to populate the
// filter dropdowns (brands, raw categories, Hubber sub-suppliers, statuses)
// without hard-coding anything adapter-specific in the frontend.
router.get('/filter-options', async (req, res) => {
  try {
    const { supplier_id } = req.query;
    if (!supplier_id) return res.status(400).json({ error: 'supplier_id обов\'язковий' });

    const [brands, categories, statuses, hubberSuppliers] = await Promise.all([
      pool.query(
        `SELECT vendor AS value, COUNT(*)::int AS count FROM products
          WHERE supplier_id = $1 AND vendor IS NOT NULL AND vendor <> ''
          GROUP BY vendor ORDER BY count DESC LIMIT 500`, [supplier_id]),
      pool.query(
        `SELECT category_id AS id, category_name AS name, COUNT(*)::int AS count FROM products
          WHERE supplier_id = $1 AND category_id IS NOT NULL
          GROUP BY category_id, category_name ORDER BY name ASC LIMIT 1000`, [supplier_id]),
      pool.query(
        `SELECT raw_meta->>'statusId' AS id, raw_meta->>'status' AS name, COUNT(*)::int AS count FROM products
          WHERE supplier_id = $1 AND raw_meta ? 'statusId' AND raw_meta->>'statusId' IS NOT NULL
          GROUP BY raw_meta->>'statusId', raw_meta->>'status' ORDER BY count DESC`, [supplier_id]),
      pool.query(
        `SELECT raw_meta->>'hubberSupplierId' AS id, raw_meta->>'hubberSupplierName' AS name,
                MAX((raw_meta->>'hubberSupplierRating')::numeric) AS rating, COUNT(*)::int AS count
           FROM products
          WHERE supplier_id = $1 AND raw_meta ? 'hubberSupplierId' AND raw_meta->>'hubberSupplierId' IS NOT NULL
          GROUP BY raw_meta->>'hubberSupplierId', raw_meta->>'hubberSupplierName'
          ORDER BY count DESC LIMIT 1000`, [supplier_id]),
    ]);

    res.json({
      brands: brands.rows,
      categories: categories.rows,
      statuses: statuses.rows,
      hubberSuppliers: hubberSuppliers.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load filter options' });
  }
});

// PATCH /api/admin/products/bulk-include
// body: { ids?: [1,2,3], filter?: { ...same query params as GET / above },
//         included: true|false }
// Either pass explicit ids (from checkboxes on the current page), or a
// filter object to include/exclude EVERYTHING matching it in one go
// ("select all 4000 that matched this filter", not just the visible page).
router.patch('/bulk-include', async (req, res) => {
  try {
    const { ids, filter, included } = req.body;
    if (typeof included !== 'boolean') return res.status(400).json({ error: 'included (boolean) обов\'язковий' });

    if (Array.isArray(ids) && ids.length) {
      const { rowCount } = await pool.query(
        `UPDATE products SET included = $2, updated_at = now() WHERE id = ANY($1::bigint[])`,
        [ids, included]
      );
      return res.json({ ok: true, updated: rowCount });
    }

    if (filter && filter.supplier_id) {
      const { where, params } = buildFilterWhere(filter);
      const { rowCount } = await pool.query(
        `UPDATE products p SET included = $${params.length + 1}, updated_at = now() WHERE ${where}`,
        [...params, included]
      );
      return res.json({ ok: true, updated: rowCount });
    }

    return res.status(400).json({ error: 'Передайте ids[] або filter.supplier_id' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update products' });
  }
});

// PATCH /api/admin/products/assign-categories
// body: { ids: [1,2,3], category_ids: [5,7], mode: 'set' | 'add' | 'remove' }
//   set    — replace this product's category assignments with exactly category_ids
//   add    — keep existing assignments, add these too
//   remove — drop these category_ids from the product, keep the rest
router.patch('/assign-categories', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ids, category_ids, mode } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids[] обов\'язковий' });
    if (!Array.isArray(category_ids)) return res.status(400).json({ error: 'category_ids[] обов\'язковий' });
    if (!['set', 'add', 'remove'].includes(mode)) return res.status(400).json({ error: "mode має бути 'set', 'add' або 'remove'" });

    await client.query('BEGIN');

    if (mode === 'set') {
      await client.query('DELETE FROM product_categories WHERE product_id = ANY($1::bigint[])', [ids]);
      if (category_ids.length) {
        await client.query(
          `INSERT INTO product_categories (product_id, category_id)
           SELECT pid, cid FROM UNNEST($1::bigint[]) pid, UNNEST($2::int[]) cid
           ON CONFLICT DO NOTHING`,
          [ids, category_ids]
        );
      }
    } else if (mode === 'add') {
      if (category_ids.length) {
        await client.query(
          `INSERT INTO product_categories (product_id, category_id)
           SELECT pid, cid FROM UNNEST($1::bigint[]) pid, UNNEST($2::int[]) cid
           ON CONFLICT DO NOTHING`,
          [ids, category_ids]
        );
      }
    } else {
      await client.query(
        `DELETE FROM product_categories WHERE product_id = ANY($1::bigint[]) AND category_id = ANY($2::int[])`,
        [ids, category_ids]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to assign categories' });
  } finally {
    client.release();
  }
});

// Shared WHERE-builder used by bulk-include's `filter` mode — same fields
// as GET / above, kept in one place so the two never drift apart.
function buildFilterWhere(f) {
  const conditions = ['p.supplier_id = $1'];
  const params = [f.supplier_id];
  const add = (sql, value) => { params.push(value); conditions.push(sql.replace('?', `$${params.length}`)); };

  if (f.included === 'true') conditions.push('p.included = true');
  else if (f.included === 'false') conditions.push('p.included = false');
  if (f.q && f.q.trim()) add('p.name ILIKE ?', `%${f.q.trim()}%`);
  if (f.vendor_code && f.vendor_code.trim()) add('p.vendor_code ILIKE ?', `%${f.vendor_code.trim()}%`);
  if (f.category_id) add('p.category_id = ?', f.category_id);
  if (f.vendor) add('p.vendor = ?', f.vendor);
  if (f.price_from) add('p.price >= ?', Number(f.price_from));
  if (f.price_to) add('p.price <= ?', Number(f.price_to));
  if (f.availability === 'in_stock') conditions.push('p.available = true');
  else if (f.availability === 'out_of_stock') conditions.push('p.available = false');
  if (f.status_id) add("p.raw_meta->>'statusId' = ?", String(f.status_id));
  if (f.is_top === 'true') conditions.push("(p.raw_meta->>'isTop')::boolean = true");
  if (f.hubber_supplier_id) add("p.raw_meta->>'hubberSupplierId' = ?", String(f.hubber_supplier_id));

  return { where: conditions.join(' AND '), params };
}

// =====================================================================
// Live catalogue browsing — the whole point of this section is that the
// server never bulk-loads a manual_selection supplier's catalogue. This
// proxies straight to the supplier's own API (adapter.browseCatalog),
// filtered server-side by Hubber/etc itself, one page (~50 items) at a
// time, and writes NOTHING to our database. See services/suppliers/
// hubber.js's browseCatalog() for exactly what's sent.
// =====================================================================

// GET /api/admin/products/browse-categories — the supplier's OWN category
// tree (flat, with parent_id), for the "Огляд каталогу" filter panel's
// category → subcategory cascade. Cached briefly on the adapter side
// (see hubber.js's fetchCategoryMap), so this is cheap to call whenever
// the admin opens the filter panel.
router.get('/browse-categories', async (req, res) => {
  try {
    const { supplier_id } = req.query;
    if (!supplier_id) return res.status(400).json({ error: "supplier_id обов'язковий" });

    const { rows: supRows } = await pool.query('SELECT * FROM suppliers WHERE id = $1', [supplier_id]);
    if (!supRows.length) return res.status(404).json({ error: 'Постачальника не знайдено' });
    const supplier = supRows[0];

    const adapter = getAdapter(supplier);
    if (typeof adapter.fetchCategories !== 'function') {
      return res.json([]); // adapter doesn't expose a category tree — filter panel just hides the field
    }
    res.json(await adapter.fetchCategories(supplier));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to load supplier categories' });
  }
});

// GET /api/admin/products/browse — one live page from the supplier's own
// API. Query params: supplier_id (required), page (1-based, default 1),
// plus whatever the adapter's browseCatalog accepts — for Hubber: id,
// name, vendor_code, mark_top, company_id, category_id, price_from,
// price_to, availability, status, edited_from, edited_to — plus our own
// adapter-agnostic extras applied after the fact: stock_min (only show
// items with at least this many units left).
//
// Products already in OUR database for this supplier are dropped from the
// result entirely (not just flagged) — that's the "не показувати вже
// додані" behaviour, checked against exactly this page's ~50 ids, so it
// stays cheap regardless of how large the supplier's remote catalogue is.
router.get('/browse', async (req, res) => {
  try {
    const { supplier_id, page } = req.query;
    if (!supplier_id) return res.status(400).json({ error: "supplier_id обов'язковий" });

    const { rows: supRows } = await pool.query('SELECT * FROM suppliers WHERE id = $1', [supplier_id]);
    if (!supRows.length) return res.status(404).json({ error: 'Постачальника не знайдено' });
    const supplier = supRows[0];
    if (!supplier.manual_selection) {
      return res.status(400).json({ error: 'Живий перегляд доступний лише для постачальників із ручним відбором' });
    }

    const adapter = getAdapter(supplier);
    if (!adapter.capabilities?.liveBrowse || typeof adapter.browseCatalog !== 'function') {
      return res.status(400).json({ error: `Адаптер "${supplier.adapter}" не підтримує живий перегляд каталогу` });
    }

    const filters = {
      id: req.query.id,
      name: req.query.name,
      vendorCode: req.query.vendor_code,
      markTop: req.query.mark_top === 'true',
      companyId: req.query.company_id,
      categoryId: req.query.category_id || req.query.subcategory_id || undefined,
      priceFrom: req.query.price_from,
      priceTo: req.query.price_to,
      availability: req.query.availability,
      status: req.query.status,
      startEditedAt: req.query.edited_from,
      endEditedAt: req.query.edited_to,
    };
    const stockMin = req.query.stock_min !== undefined && req.query.stock_min !== '' ? Number(req.query.stock_min) : null;

    const { items: rawItems, page: pageNum, total, hasMore } = await adapter.browseCatalog(supplier, filters, page || 1);

    // Already-in-our-catalogue check, scoped to just this page's ids.
    const ids = rawItems.map((p) => String(p.supplierProductId));
    let alreadyImportedIds = new Set();
    if (ids.length) {
      const { rows } = await pool.query(
        `SELECT supplier_product_id FROM products WHERE supplier_id = $1 AND supplier_product_id = ANY($2::text[])`,
        [supplier.id, ids]
      );
      alreadyImportedIds = new Set(rows.map((r) => r.supplier_product_id));
    }

    const items = rawItems.filter((p) => {
      if (alreadyImportedIds.has(String(p.supplierProductId))) return false;
      if (stockMin != null && !(Number.isFinite(p.stock) && p.stock >= stockMin)) return false;
      return true;
    });

    res.json({ items, page: pageNum, total, hasMore });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to browse catalogue' });
  }
});

// POST /api/admin/products/import-selected
// body: { supplier_id, items: [ <normalized product objects, exactly as
//         returned by GET /browse above> ], category_ids?: [1, 2] }
// Writes ONLY these specific products to the database, included = true —
// this is the one place a manual_selection supplier's products actually
// reach our server/database outside of refreshing what's already there.
// category_ids, if given, are assigned to every imported product in the
// same step — for when the supplier's own category doesn't match your
// site's structure and you already know where these belong.
router.post('/import-selected', async (req, res) => {
  const client = await pool.connect();
  try {
    const { supplier_id, items, category_ids } = req.body;
    if (!supplier_id) return res.status(400).json({ error: "supplier_id обов'язковий" });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "items[] обов'язковий" });
    if (items.length > 200) return res.status(400).json({ error: 'За раз можна імпортувати не більше 200 товарів' });

    const { rows: supRows } = await pool.query('SELECT * FROM suppliers WHERE id = $1', [supplier_id]);
    if (!supRows.length) return res.status(404).json({ error: 'Постачальника не знайдено' });
    const supplier = supRows[0];

    const normalized = items
      .filter((p) => p && p.supplierProductId != null && p.name)
      .map((p) => ({
        supplierProductId: p.supplierProductId,
        name: p.name,
        description: p.description,
        price: p.price,
        categoryId: p.categoryId,
        categoryName: p.categoryName,
        section: p.section,
        pictureUrl: p.pictureUrl,
        pictures: p.pictures,
        vendorCode: p.vendorCode,
        vendor: p.vendor,
        params: p.params,
        stock: p.stock,
        available: p.available,
        meta: p.meta,
      }));
    if (!normalized.length) return res.status(400).json({ error: 'Жоден переданий товар не має коректної форми' });

    await client.query('BEGIN');
    const count = await upsertBatch(client, supplier, normalized, new Date(), /* forceIncluded */ true);

    if (Array.isArray(category_ids) && category_ids.length) {
      const supplierProductIds = normalized.map((p) => String(p.supplierProductId));
      await client.query(
        `INSERT INTO product_categories (product_id, category_id)
         SELECT p.id, cid
           FROM products p, UNNEST($3::int[]) cid
          WHERE p.supplier_id = $1 AND p.supplier_product_id = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [supplier.id, supplierProductIds, category_ids]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, imported: count });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to import products' });
  } finally {
    client.release();
  }
});

module.exports = router;
