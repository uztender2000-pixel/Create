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
// GET /api/admin/products/filter-options?supplier_id=...&(same filters as GET /)
// The dropdown options are "active": each facet (brand, category, status,
// Hubber sub-supplier) is computed with every OTHER currently-applied
// filter still in effect (but not its own) — so picking status "Промодеро-
// ваний" immediately narrows the category dropdown to only categories that
// actually contain a moderated product, picking a stock threshold narrows
// brands to ones that still have matching stock, and so on. Without this,
// the panel would happily let you pick a combination with zero results.
router.get('/filter-options', async (req, res) => {
  try {
    const { supplier_id } = req.query;
    if (!supplier_id) return res.status(400).json({ error: "supplier_id обов'язковий" });

    const brandsQ = buildFacetWhere(req.query, 'vendor');
    const categoriesQ = buildFacetWhere(req.query, 'category_id');
    const statusesQ = buildFacetWhere(req.query, 'status_id');
    const hubberQ = buildFacetWhere(req.query, 'hubber_supplier_id');

    const [brands, categories, statuses, hubberSuppliers] = await Promise.all([
      pool.query(
        `SELECT vendor AS value, COUNT(*)::int AS count FROM products p
          WHERE ${brandsQ.where} AND vendor IS NOT NULL AND vendor <> ''
          GROUP BY vendor ORDER BY count DESC LIMIT 500`, brandsQ.params),
      pool.query(
        `SELECT category_id AS id, category_name AS name, COUNT(*)::int AS count FROM products p
          WHERE ${categoriesQ.where} AND category_id IS NOT NULL
          GROUP BY category_id, category_name ORDER BY name ASC LIMIT 1000`, categoriesQ.params),
      pool.query(
        `SELECT raw_meta->>'statusId' AS id, raw_meta->>'status' AS name, COUNT(*)::int AS count FROM products p
          WHERE ${statusesQ.where} AND raw_meta ? 'statusId' AND raw_meta->>'statusId' IS NOT NULL
          GROUP BY raw_meta->>'statusId', raw_meta->>'status' ORDER BY count DESC`, statusesQ.params),
      pool.query(
        `SELECT raw_meta->>'hubberSupplierId' AS id, raw_meta->>'hubberSupplierName' AS name,
                MAX((raw_meta->>'hubberSupplierRating')::numeric) AS rating, COUNT(*)::int AS count
           FROM products p
          WHERE ${hubberQ.where} AND raw_meta ? 'hubberSupplierId' AND raw_meta->>'hubberSupplierId' IS NOT NULL
          GROUP BY raw_meta->>'hubberSupplierId', raw_meta->>'hubberSupplierName'
          ORDER BY count DESC LIMIT 1000`, hubberQ.params),
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
      const { where, params } = buildFacetWhere(filter);
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

// Shared WHERE-builder for the products list, the "active" filter-options
// facets, and bulk-include's `filter` mode — one place, so they can never
// silently drift apart. `excludeField`, when given, skips that one field's
// own condition (used so a facet's dropdown reflects every filter EXCEPT
// itself — see /filter-options above).
function buildFacetWhere(f, excludeField) {
  const conditions = ['p.supplier_id = $1'];
  const params = [f.supplier_id];
  const add = (field, sql, value) => {
    if (field === excludeField) return;
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };

  if (excludeField !== 'included') {
    if (f.included === 'true') conditions.push('p.included = true');
    else if (f.included === 'false') conditions.push('p.included = false');
  }
  if (f.q && f.q.trim()) add('q', 'p.name ILIKE ?', `%${f.q.trim()}%`);
  if (f.vendor_code && f.vendor_code.trim()) add('vendor_code', 'p.vendor_code ILIKE ?', `%${f.vendor_code.trim()}%`);
  if (f.supplier_product_id && f.supplier_product_id.trim()) add('supplier_product_id', 'p.supplier_product_id ILIKE ?', `%${f.supplier_product_id.trim()}%`);
  if (f.category_id) add('category_id', 'p.category_id = ?', f.category_id);
  if (f.vendor) add('vendor', 'p.vendor = ?', f.vendor);
  if (f.price_from) add('price_from', 'p.price >= ?', Number(f.price_from));
  if (f.price_to) add('price_to', 'p.price <= ?', Number(f.price_to));
  if (excludeField !== 'availability') {
    if (f.availability === 'in_stock') conditions.push('p.available = true');
    else if (f.availability === 'out_of_stock') conditions.push('p.available = false');
  }
  if (excludeField !== 'stock_min' && f.stock_min) add('stock_min', 'p.stock >= ?', Number(f.stock_min));
  if (f.status_id) add('status_id', "p.raw_meta->>'statusId' = ?", String(f.status_id));
  if (excludeField !== 'is_top') {
    if (f.is_top === 'true') conditions.push("(p.raw_meta->>'isTop')::boolean = true");
    else if (f.is_top === 'false') conditions.push("COALESCE((p.raw_meta->>'isTop')::boolean, false) = false");
  }
  if (f.hubber_supplier_id) add('hubber_supplier_id', "p.raw_meta->>'hubberSupplierId' = ?", String(f.hubber_supplier_id));
  if (excludeField !== 'shop_category_id') {
    if (f.shop_category_id === 'unassigned') {
      conditions.push('NOT EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id)');
    } else if (f.shop_category_id) {
      add('shop_category_id', 'EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = ?)', f.shop_category_id);
    }
  }

  return { where: conditions.join(' AND '), params };
}

// =====================================================================
// Live catalogue browsing — the whole point of this section is that the
// server never bulk-loads a manual_selection supplier's catalogue. This
// proxies straight to the supplier's own API (adapter.browseCatalog),
// filtered server-side by Hubber/etc itself, and writes NOTHING to our
// database. See services/suppliers/hubber.js's browseCatalog() for
// exactly what's sent.
// =====================================================================

// Same normalized-filter shape used by both endpoints below, built once
// from the request's query params so /browse and /browse-categories can
// never silently diverge on what a given field means.
function parseBrowseFilters(q) {
  return {
    id: q.id,
    name: q.name,
    vendorCode: q.vendor_code,
    markTop: q.mark_top === 'true',
    companyId: q.company_id,
    categoryId: q.category_id || q.subcategory_id || undefined,
    priceFrom: q.price_from,
    priceTo: q.price_to,
    availability: q.availability,
    status: q.status,
    startEditedAt: q.edited_from,
    endEditedAt: q.edited_to,
  };
}

// GET /api/admin/products/browse-categories — the supplier's OWN category
// tree, ONE LEVEL AT A TIME (top-level by default, or the children of
// `parent_id` when given — matching the filter panel's category →
// subcategory cascade, which only ever needs one level open at once).
//
// "Active": every OTHER filter currently applied (status, availability,
// price, mark/top, company_id, edited dates — everything Hubber itself
// can filter on) is passed straight through, and each category in the
// list gets a cheap existence check (one limit=1 request per category,
// run in parallel) so a category with ZERO matching products for the
// current filters is simply left out — not just hidden with a count of
// "0" that still makes the list look enormous. Bounded to one tree level
// at a time is what keeps this from becoming hundreds of requests.
//
// stock_min is NOT one of the filters checked here: Hubber's API has no
// server-side stock filter, so we can't ask "does category X have any
// item with stock ≥ N" without pulling real product data — the one thing
// this whole feature exists to avoid. The category list may therefore
// still include a category that turns out to have nothing once stock_min
// is applied to the actual search; there's no way around that without
// bulk-loading, so /browse (below) is what gives the honest final answer.
router.get('/browse-categories', async (req, res) => {
  try {
    const { supplier_id, parent_id } = req.query;
    if (!supplier_id) return res.status(400).json({ error: "supplier_id обов'язковий" });

    const { rows: supRows } = await pool.query('SELECT * FROM suppliers WHERE id = $1', [supplier_id]);
    if (!supRows.length) return res.status(404).json({ error: 'Постачальника не знайдено' });
    const supplier = supRows[0];

    const adapter = getAdapter(supplier);
    if (typeof adapter.fetchCategories !== 'function') {
      return res.json([]); // adapter doesn't expose a category tree — filter panel just hides the field
    }

    const allCategories = await adapter.fetchCategories(supplier);
    const byId = new Map(allCategories.map((c) => [String(c.id), c]));
    const level = parent_id
      ? allCategories.filter((c) => String(c.parentId) === String(parent_id))
      : allCategories.filter((c) => !c.parentId || !byId.has(String(c.parentId)));

    const filters = parseBrowseFilters(req.query);
    const hasOtherFilters = Object.values(filters).some((v) => v != null && v !== '' && v !== false);

    if (!hasOtherFilters || typeof adapter.browseCatalog !== 'function') {
      // Nothing narrowing the results yet — no need to spend a request per
      // category, just show the whole level as-is.
      return res.json(level);
    }

    const withMatches = await Promise.all(
      level.map(async (c) => {
        try {
          const { items } = await adapter.browseCatalog(supplier, { ...filters, categoryId: c.id }, 1, 1);
          return items.length > 0 ? c : null;
        } catch {
          return c; // if the existence check itself fails, don't hide the category — fail open
        }
      })
    );
    res.json(withMatches.filter(Boolean));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to load supplier categories' });
  }
});

// GET /api/admin/products/browse — a full search, not "one page": given the
// current filters, walks the supplier's catalogue (internally, across as
// many of the supplier's own pages as it takes) and returns a batch of
// TARGET matching products — every single one already filtered for
// already-imported and stock_min, so nothing in the response is ever a
// placeholder the admin can't actually pick. Only ever runs when the admin
// explicitly asks for it (the "Сформувати перелік" / "Знайти ще" buttons on
// the frontend) — never automatically, and never as a side effect of
// paging through a stale list.
//
// Query params: supplier_id (required), start_page (1-based; omit or 1 to
// start a fresh search, or pass back the previous response's next_start_
// page to keep searching further for "Знайти ще"), plus the same filters
// as /browse-categories above, plus stock_min (our own post-filter, since
// Hubber has no server-side stock filter).
//
// Bounded by MAX_SUPPLIER_PAGES so one click can never trigger an
// unbounded crawl of the supplier's entire catalogue — if that cap is hit
// before TARGET matches are found, the response says so (`capped: true`)
// so the admin can narrow the filter instead of blindly clicking "Знайти
// ще" over and over.
const TARGET_RESULTS = 60;
const MAX_SUPPLIER_PAGES = 20; // ≈2000 raw products scanned per click, worst case

router.get('/browse', async (req, res) => {
  try {
    const { supplier_id } = req.query;
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

    const filters = parseBrowseFilters(req.query);
    const stockMin = req.query.stock_min !== undefined && req.query.stock_min !== '' ? Number(req.query.stock_min) : null;

    let page = Math.max(1, parseInt(req.query.start_page, 10) || 1);
    const collected = [];
    let pagesScanned = 0;
    let exhausted = false;

    while (collected.length < TARGET_RESULTS && pagesScanned < MAX_SUPPLIER_PAGES) {
      const { items: rawItems, hasMore } = await adapter.browseCatalog(supplier, filters, page);
      pagesScanned += 1;

      if (rawItems.length) {
        const ids = rawItems.map((p) => String(p.supplierProductId));
        const { rows } = await pool.query(
          `SELECT supplier_product_id FROM products WHERE supplier_id = $1 AND supplier_product_id = ANY($2::text[])`,
          [supplier.id, ids]
        );
        const alreadyImportedIds = new Set(rows.map((r) => r.supplier_product_id));

        for (const p of rawItems) {
          if (alreadyImportedIds.has(String(p.supplierProductId))) continue;
          if (stockMin != null && !(Number.isFinite(p.stock) && p.stock >= stockMin)) continue;
          collected.push(p);
        }
      }

      page += 1;
      if (!hasMore) { exhausted = true; break; }
    }

    res.json({
      items: collected,
      nextStartPage: exhausted ? null : page,
      exhausted,
      capped: !exhausted && pagesScanned >= MAX_SUPPLIER_PAGES,
      pagesScanned,
    });
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
