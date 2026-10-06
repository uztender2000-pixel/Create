const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Sentinel value for "products with no section" — chosen unlikely to
// collide with a real category name from any feed. The frontend maps
// this exact string to the label "Без категорії"; nothing else about it
// is special to the database.
const UNCATEGORIZED = '__uncategorized__';

// Our own shop's display name — the "seller" shown on a product card for
// shop_ships suppliers (see suppliers.fulfillment_type below). Same value
// routes/config.js hands the frontend, kept in one place so they can't drift.
const SHOP_NAME = process.env.SHOP_NAME || 'В Хату.UA';

// Who's actually selling this product, for the product card:
//   - shop_ships supplier: WE are ("мій магазин") — we create the receipt/
//     TTN and collect payment, so the customer is buying from us.
//   - supplier_ships (classic dropship): the REAL supplier. For an
//     aggregator adapter like Hubber, that's the specific underlying
//     seller behind that one product (raw_meta.hubberSupplierName), since
//     "Hubber" itself is just the API we buy through, not who's actually
//     selling it — falls back to the supplier's own name when an adapter
//     has no such per-product seller (an ordinary single-seller feed).
function resolveSeller(row) {
  if (row.fulfillment_type === 'shop_ships') return SHOP_NAME;
  return row.raw_meta?.hubberSupplierName || row.supplier_name;
}

// Whitelist of sort options -> SQL ORDER BY clause. Never interpolate the
// sort value directly into SQL — always go through this map.
const SORT_OPTIONS = {
  price_asc: 'p.retail_price ASC NULLS LAST',
  price_desc: 'p.retail_price DESC NULLS LAST',
  name_asc: 'p.name ASC',
  name_desc: 'p.name DESC',
  popular: 'order_count DESC, p.updated_at DESC',
  newest: 'p.updated_at DESC',
  random: 'RANDOM()', // used for the homepage's "10 random products" view
};

// ---------------------------------------------------------------------------
// Фільтри за характеристиками (products.params — JSONB-об'єкт { назва: значення }).
//
// Клієнт передає вибір одним параметром:
//   ?filters={"колір":["чорний","білий"],"__vendor":["nike"]}&price_min=100&price_max=900
// Ключі й значення тут — у «нормалізованому» вигляді (lower + btrim), саме такими
// їх віддає /meta/filters, тому JS-ом їх повторно НЕ нормалізуємо: порівняння
// відбувається тим самим SQL-виразом, яким вони були утворені.
// "__vendor" — службовий ключ для бренду (колонка products.vendor).
// ---------------------------------------------------------------------------
const VENDOR_KEY = '__vendor';

// params може бути NULL або не об'єктом — jsonb_each_text на таких падає, тож підстраховуємось.
const POBJ = `(CASE WHEN jsonb_typeof(p.params) = 'object' THEN p.params ELSE '{}'::jsonb END)`;

function parseFilters(raw) {
  const out = {};
  if (!raw) return out;
  let obj;
  try { obj = JSON.parse(raw); } catch { return out; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [key, vals] of Object.entries(obj).slice(0, 30)) {
    if (!key || key.length > 120 || !Array.isArray(vals)) continue;
    const clean = [...new Set(vals.filter((v) => typeof v === 'string' && v.length > 0 && v.length <= 120))].slice(0, 100);
    if (clean.length) out[key] = clean;
  }
  return out;
}

function parsePrice(v) {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : null;
}

// Умови для вибраних фільтрів і ціни. `exclude` — ключ, який не враховуємо
// (щоб у групі вже вибраних значень показувати лічильники інших значень цієї ж групи).
function filterConditions(filters, price, params, exclude) {
  const conds = [];
  for (const [key, vals] of Object.entries(filters)) {
    if (key === exclude) continue;
    if (key === VENDOR_KEY) {
      params.push(vals);
      conds.push(`lower(btrim(p.vendor)) = ANY($${params.length}::text[])`);
    } else {
      params.push(key);
      const kIdx = params.length;
      params.push(vals);
      conds.push(`EXISTS (
        SELECT 1 FROM jsonb_each_text(${POBJ}) fe
        WHERE lower(btrim(fe.key)) = $${kIdx} AND lower(btrim(fe.value)) = ANY($${params.length}::text[])
      )`);
    }
  }
  if (price.min !== null) { params.push(price.min); conds.push(`p.retail_price >= $${params.length}`); }
  if (price.max !== null) { params.push(price.max); conds.push(`p.retail_price <= $${params.length}`); }
  return conds;
}

// Базові умови видимості + категорія/розділ/пошук — те, що не залежить від фільтрів.
function baseConditions(query) {
  const { featured, section, category_id, q, supplier, shop_category_id } = query;
  // Only sell what's available AND from a supplier that's switched on —
  // deactivating a supplier now hides its whole catalogue in one click.
  // For a manual_selection supplier (catalogue updates itself via an API,
  // e.g. Hubber/MyDrop/TradeEvo) a product also has to be admin-included;
  // for an ordinary feed supplier `included` is always true and this
  // condition is a no-op.
  const conditions = ['p.available = true', 's.active = true', '(s.manual_selection = false OR p.included = true)'];
  const params = [];

  if (featured === 'true') conditions.push('p.featured = true');
  if (section === UNCATEGORIZED) conditions.push('p.section IS NULL');
  else if (section) { params.push(section); conditions.push(`p.section = $${params.length}`); }
  if (category_id) { params.push(category_id); conditions.push(`p.category_id = $${params.length}`); }
  if (supplier) { params.push(supplier); conditions.push(`s.code = $${params.length}`); }
  // shop_category_id filters by the admin's own category tree (see
  // routes/adminCategories.js) rather than the raw supplier category —
  // this is what lets manually-curated subcategories appear as normal
  // storefront navigation. Selecting a PARENT category also includes
  // every product filed under any of its subcategories (recursively),
  // so picking a top-level category on the storefront behaves the way
  // shoppers expect ("everything in Electronics", not "only products
  // filed on Electronics itself with nothing in its subcategories").
  if (shop_category_id) {
    params.push(shop_category_id);
    conditions.push(`EXISTS (
        SELECT 1 FROM product_categories pc
        WHERE pc.product_id = p.id
          AND pc.category_id IN (
            WITH RECURSIVE branch AS (
              SELECT id FROM categories WHERE id = $${params.length}
              UNION ALL
              SELECT c.id FROM categories c JOIN branch ON c.parent_id = branch.id
            )
            SELECT id FROM branch
          )
      )`);
  }
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    conditions.push(`(p.name ILIKE $${params.length} OR p.vendor_code ILIKE $${params.length})`);
  }
  return { conditions, params };
}

// Додає до товарів середню оцінку й кількість опублікованих відгуків (rating_avg, rating_count) одним запитом.
async function attachRatings(products) {
  if (!products.length) return products;
  const { rows } = await pool.query(
    `SELECT product_id, ROUND(AVG(rating)::numeric, 1)::float AS avg, COUNT(*)::int AS cnt
       FROM product_reviews
      WHERE status = 'published' AND product_id = ANY($1::bigint[])
      GROUP BY product_id`,
    [products.map((p) => p.id)]
  );
  const byId = new Map(rows.map((r) => [String(r.product_id), r]));
  return products.map((p) => {
    const r = byId.get(String(p.id));
    return { ...p, rating_avg: r ? r.avg : 0, rating_count: r ? r.cnt : 0 };
  });
}

// GET /api/products — list available products, paginated and sortable.
// ?featured=true        -> just your test finalists
// ?section=...          -> filter by top-level section
// ?category_id=...      -> filter by specific category within a section
// ?supplier=code        -> only one supplier's products
// ?q=...                -> search by name or article/vendor_code
// ?sort=... ?page=1&limit=24
router.get('/', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
    const offset = (page - 1) * limit;
    const sortKey = SORT_OPTIONS[req.query.sort] ? req.query.sort : 'newest';
    const orderBy = SORT_OPTIONS[sortKey];

    const { conditions, params } = baseConditions(req.query);
    conditions.push(...filterConditions(
      parseFilters(req.query.filters),
      { min: parsePrice(req.query.price_min), max: parsePrice(req.query.price_max) },
      params
    ));
    const where = conditions.join(' AND ');

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM products p JOIN suppliers s ON s.id = p.supplier_id
        WHERE ${where}`,
      params
    );
    const total = countRows[0].total;

    const dataParams = [...params, limit, offset];
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.description, p.retail_price, p.price, p.picture_url,
              p.vendor, p.category_id, p.category_name, p.section, p.stock,
              p.raw_meta,
              s.code AS supplier_code, s.name AS supplier_name,
              s.fulfillment_type, s.payment_methods,
              COALESCE(oc.order_count, 0) AS order_count
         FROM products p
         JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN (
           SELECT product_id, COUNT(*)::int AS order_count
             FROM orders GROUP BY product_id
         ) oc ON oc.product_id = p.id
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    // seller_name computed here (not in SQL) since it needs our own
    // SHOP_NAME constant; raw_meta dropped afterwards — it was only
    // fetched to pull hubberSupplierName out of it and isn't otherwise
    // meant for public API consumers.
    const products = rows.map(({ raw_meta, fulfillment_type, ...row }) => ({
      ...row,
      seller_name: resolveSeller({ raw_meta, fulfillment_type, supplier_name: row.supplier_name }),
    }));

    res.json({
      products: await attachRatings(products),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      sort: sortKey,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// Службові характеристики, за якими фільтрувати немає сенсу.
const FACET_KEY_BLACKLIST = /^(артикул|код|штрих|штріх|ean|upc|sku|id$|vendorcode|назва|name$|url|посилання|опис|модель|model)/i;

const FACET_CACHE = new Map(); // кеш відповідей на 60 с: каталог змінюється рідко, а запити важкі
const FACET_TTL_MS = 60 * 1000;

// GET /api/products/meta/filters?shop_category_id=...&filters=...&price_min=...&price_max=...
// Будує набір фільтрів із характеристик (params) товарів, що лежать у категорії:
//   - беремо характеристики, які є у помітної частини товарів і мають небагато
//     різних значень (унікальні значення на кшталт артикулів чи ваги відсіюються);
//   - + бренд (products.vendor) та діапазон цін;
//   - лічильники значень враховують уже вибрані фільтри інших груп, тож
//     покупець не потрапляє в порожню видачу.
// Без категорії (shop_category_id) фільтри не будуються — це важкий запит.
router.get('/meta/filters', async (req, res) => {
  try {
    if (!req.query.shop_category_id) return res.json({ total: 0, price: null, filters: [] });

    const cacheKey = req.originalUrl;
    const hit = FACET_CACHE.get(cacheKey);
    if (hit && Date.now() - hit.at < FACET_TTL_MS) return res.json(hit.data);

    const filters = parseFilters(req.query.filters);
    const price = { min: parsePrice(req.query.price_min), max: parsePrice(req.query.price_max) };
    const base = baseConditions(req.query);
    const FROM = 'FROM products p JOIN suppliers s ON s.id = p.supplier_id';

    // --- 1) розмір вибірки та діапазон цін (без фільтрів — для стабільного набору груп) ---
    const { rows: [head] } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              MIN(p.retail_price) AS pmin, MAX(p.retail_price) AS pmax,
              COUNT(*) FILTER (WHERE btrim(COALESCE(p.vendor, '')) <> '')::int AS vendor_cov,
              COUNT(DISTINCT lower(btrim(p.vendor))) FILTER (WHERE btrim(COALESCE(p.vendor, '')) <> '')::int AS vendor_nv
         ${FROM} WHERE ${base.conditions.join(' AND ')}`,
      base.params
    );
    const total = head.total;
    const priceRange = head.pmin === null ? null : { min: Number(head.pmin), max: Number(head.pmax) };
    if (total < 6) {
      const data = { total, price: priceRange, filters: [] };
      return res.json(data);
    }

    // --- 2) які характеристики годяться як фільтри ---
    const { rows: stats } = await pool.query(
      `SELECT lower(btrim(e.key)) AS k,
              mode() WITHIN GROUP (ORDER BY btrim(e.key)) AS label,
              COUNT(DISTINCT p.id)::int AS cov,
              COUNT(DISTINCT lower(btrim(e.value)))::int AS nv
         ${FROM}
         CROSS JOIN LATERAL jsonb_each_text(${POBJ}) e
        WHERE ${base.conditions.join(' AND ')}
          AND btrim(e.key) <> '' AND btrim(e.value) <> '' AND length(e.value) <= 80
        GROUP BY 1`,
      base.params
    );
    const minCov = Math.max(3, Math.ceil(total * 0.05));
    const chosen = stats
      .filter((r) => r.cov >= minCov && r.nv >= 2 && r.nv <= 80 && r.nv <= r.cov * 0.7 && !FACET_KEY_BLACKLIST.test(r.k))
      .sort((a, b) => b.cov - a.cov)
      .slice(0, 12);
    const labels = new Map(chosen.map((r) => [r.k, r.label]));
    const useVendor = head.vendor_cov >= minCov && head.vendor_nv >= 2 && head.vendor_nv <= 80;

    // --- 3) лічильники значень з урахуванням вибраних фільтрів ---
    const counts = new Map(); // key -> Map(value -> { label, count })
    const put = (key, rows) => {
      const m = counts.get(key) || new Map();
      for (const r of rows) m.set(r.v, { label: r.label, count: r.cnt });
      counts.set(key, m);
    };

    const countParams = (exclude) => {
      const params = [...base.params];
      const conds = [...base.conditions, ...filterConditions(filters, price, params, exclude)];
      return { params, where: conds.join(' AND ') };
    };
    const paramCounts = async (keys, exclude) => {
      if (!keys.length) return [];
      const { params, where } = countParams(exclude);
      params.push(keys);
      const { rows } = await pool.query(
        `SELECT lower(btrim(e.key)) AS k, lower(btrim(e.value)) AS v,
                mode() WITHIN GROUP (ORDER BY btrim(e.value)) AS label,
                COUNT(DISTINCT p.id)::int AS cnt
           ${FROM}
           CROSS JOIN LATERAL jsonb_each_text(${POBJ}) e
          WHERE ${where}
            AND lower(btrim(e.key)) = ANY($${params.length}::text[])
            AND btrim(e.value) <> '' AND length(e.value) <= 80
          GROUP BY 1, 2`,
        params
      );
      return rows;
    };
    const vendorCounts = async (exclude) => {
      const { params, where } = countParams(exclude);
      const { rows } = await pool.query(
        `SELECT lower(btrim(p.vendor)) AS v,
                mode() WITHIN GROUP (ORDER BY btrim(p.vendor)) AS label,
                COUNT(*)::int AS cnt
           ${FROM}
          WHERE ${where} AND btrim(COALESCE(p.vendor, '')) <> ''
          GROUP BY 1`,
        params
      );
      return rows;
    };

    // групи без вибору — одним запитом; групи з вибором — окремо, без власного фільтра
    const keys = chosen.map((r) => r.k);
    const unselected = keys.filter((k) => !filters[k]);
    const rowsFree = await paramCounts(unselected);
    for (const k of unselected) put(k, rowsFree.filter((r) => r.k === k));
    for (const k of keys.filter((k) => filters[k])) put(k, await paramCounts([k], k));
    if (useVendor) put(VENDOR_KEY, await vendorCounts(filters[VENDOR_KEY] ? VENDOR_KEY : undefined));

    // --- 4) складаємо відповідь ---
    const build = (key, label) => {
      const selected = new Set(filters[key] || []);
      const m = counts.get(key) || new Map();
      const values = [...m.entries()]
        .filter(([, o]) => o.count > 0)
        .map(([value, o]) => ({ value, label: o.label, count: o.count, selected: selected.has(value) }));
      for (const v of selected) {
        if (!values.some((x) => x.value === v)) values.push({ value: v, label: v, count: 0, selected: true });
      }
      values.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'uk'));
      return { key, label, values: values.slice(0, 60) };
    };
    const out = [];
    if (useVendor) out.push(build(VENDOR_KEY, 'Бренд'));
    for (const k of keys) out.push(build(k, labels.get(k)));
    // група, де після врахування вибору лишилось менше двох значень, нічого не дає — крім групи з вибором
    const result = out.filter((f) => f.values.length >= 2 || f.values.some((v) => v.selected));

    const data = { total, price: priceRange, filters: result };
    if (FACET_CACHE.size > 300) FACET_CACHE.clear();
    FACET_CACHE.set(cacheKey, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load filters' });
  }
});

// GET /api/products/meta/stats — catalogue size for the homepage counter.
router.get('/meta/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM products p JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.available = true AND s.active = true`
    );
    res.json({ totalProducts: rows[0].total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// GET /api/products/meta/sections — top-level sections across ALL active
// suppliers, merged. Two suppliers both selling "Побутова техніка" show
// up as one section, which is what a marketplace should look like.
//
// Each row carries both:
//   section — the raw value stored on products.section (what ?section=
//             filters against; NEVER translated, so filtering keeps working)
//   label   — what to actually show the customer (an admin-set translation
//             via section_translations if one exists, else the raw value)
router.get('/meta/sections', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.section, COALESCE(st.display_name, p.section) AS label, COUNT(*)::int AS count
         FROM products p
         JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN section_translations st ON st.raw_name = p.section
        WHERE p.available = true AND s.active = true AND p.section IS NOT NULL
        GROUP BY p.section, st.display_name
        ORDER BY COALESCE(st.display_name, p.section) ASC`
    );

    // Products with no section (missing categoryId in the feed, or a
    // categoryId that isn't in the feed's own <categories> tree) used to
    // be invisible unless you clicked "Усі товари" — and even there they
    // were mixed in with everything else. Give them their own browsable
    // bucket instead, appended after the real sections.
    const { rows: uncategorized } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM products p JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.available = true AND s.active = true AND p.section IS NULL`
    );
    if (uncategorized[0].count > 0) {
      rows.push({ section: UNCATEGORIZED, label: 'Без категорії', count: uncategorized[0].count });
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load sections' });
  }
});

// GET /api/products/meta/categories — categories with counts. ?section=...
router.get('/meta/categories', async (req, res) => {
  try {
    const { section } = req.query;
    const conditions = ['p.available = true', 's.active = true', 'p.category_id IS NOT NULL'];
    const params = [];
    if (section === UNCATEGORIZED) conditions.push('p.section IS NULL');
    else if (section) { params.push(section); conditions.push(`p.section = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT p.category_id, p.category_name, p.section, COUNT(*)::int AS count
         FROM products p JOIN suppliers s ON s.id = p.supplier_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY p.category_id, p.category_name, p.section
        ORDER BY p.category_name ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// Мозаїка картинок категорії: до 4 фото товарів із її гілки. Беремо по черзі з власних товарів
// категорії та з кожної підкатегорії (round-robin), щоб картинка «об'єднувала» різні частини
// гілки, а не складалась із чотирьох однакових товарів однієї підкатегорії.
function buildCategoryImages(rows, directPics) {
  const children = new Map();
  for (const r of rows) {
    const key = r.parent_id || 'root';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(r);
  }
  const memo = new Map();
  const collect = (id) => {
    if (memo.has(id)) return memo.get(id);
    const lists = [directPics.get(id) || [], ...(children.get(id) || []).map((c) => collect(c.id))].filter((l) => l.length);
    const out = [];
    const seen = new Set();
    for (let i = 0; out.length < 4; i += 1) {
      let progressed = false;
      for (const list of lists) {
        if (i >= list.length) continue;
        progressed = true;
        const url = list[i];
        if (!seen.has(url)) { seen.add(url); out.push(url); if (out.length >= 4) break; }
      }
      if (!progressed) break;
    }
    memo.set(id, out);
    return out;
  };
  return collect;
}

let shopCategoriesCache = null; // відповідь кешуємо на 60 с: дерево змінюється рідко, а запит до нього — на кожне відкриття сайту
const SHOP_CATEGORIES_TTL_MS = 60 * 1000;

// GET /api/products/meta/shop-categories — the admin's own category tree
// (see routes/adminCategories.js), each with how many products currently
// on sale sit in it (or in any of its subcategories). A category with
// zero products anywhere in its branch is left out entirely — an empty
// category is just noise in storefront navigation.
router.get('/meta/shop-categories', async (req, res) => {
  try {
    if (shopCategoriesCache && Date.now() - shopCategoriesCache.at < SHOP_CATEGORIES_TTL_MS) {
      return res.json(shopCategoriesCache.data);
    }
    const { rows } = await pool.query(
      `WITH RECURSIVE direct_counts AS (
         SELECT pc.category_id, COUNT(*)::int AS cnt
           FROM product_categories pc
           JOIN products p ON p.id = pc.product_id
           JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.available = true AND s.active = true
            AND (s.manual_selection = false OR p.included = true)
          GROUP BY pc.category_id
       ),
       -- (ancestor_id, self_or_descendant_id) for every category, itself included —
       -- lets a parent's total tally add up everything under it, any number of levels deep.
       branch AS (
         SELECT id AS ancestor_id, id AS node_id FROM categories
         UNION ALL
         SELECT b.ancestor_id, c.id
           FROM branch b
           JOIN categories c ON c.parent_id = b.node_id
       )
       SELECT c.id, c.parent_id, c.name, c.slug, c.sort_order,
              COALESCE(dc.cnt, 0)::int AS count,
              COALESCE(SUM(bdc.cnt), 0)::int AS total_count
         FROM categories c
         LEFT JOIN direct_counts dc ON dc.category_id = c.id
         LEFT JOIN branch b ON b.ancestor_id = c.id
         LEFT JOIN direct_counts bdc ON bdc.category_id = b.node_id
        GROUP BY c.id, c.parent_id, c.name, c.slug, c.sort_order, dc.cnt
       HAVING COALESCE(SUM(bdc.cnt), 0) > 0
        ORDER BY c.parent_id NULLS FIRST, c.sort_order, c.name`
    );

    // Фото для мозаїки: до 4 товарів із фото на кожну категорію (за власними товарами категорії);
    // для батьківських категорій їх збирає buildCategoryImages по всій гілці.
    const { rows: picRows } = await pool.query(
      `SELECT category_id, picture_url FROM (
         SELECT pc.category_id, p.picture_url,
                ROW_NUMBER() OVER (PARTITION BY pc.category_id ORDER BY p.featured DESC, p.id) AS rn
           FROM product_categories pc
           JOIN products p ON p.id = pc.product_id
           JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.available = true AND s.active = true
            AND (s.manual_selection = false OR p.included = true)
            AND p.picture_url IS NOT NULL AND btrim(p.picture_url) <> ''
       ) t
       WHERE rn <= 4`
    );
    const directPics = new Map();
    for (const r of picRows) {
      if (!directPics.has(r.category_id)) directPics.set(r.category_id, []);
      directPics.get(r.category_id).push(r.picture_url);
    }
    const collect = buildCategoryImages(rows, directPics);
    const data = rows.map((r) => ({ ...r, images: collect(r.id) }));

    shopCategoriesCache = { at: Date.now(), data };
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load shop categories' });
  }
});

// GET /api/products/recommended?limit=10&viewed=12,7,3
// The homepage "for you" list, built from what this shopper has actually
// bought and looked at. Works for both kinds of visitor:
//   - logged in (Bearer token): purchases (from orders) + saved browsing
//     history (product_views)
//   - guest: the `viewed` query param — the ids from the browser's own
//     local history, newest first — so a first-time visitor's list starts
//     adapting after the very first product they open
// How it picks: every signal product votes for its category — its own
// site categories where it has any, otherwise its supplier section — with
// purchases counting 3x a view and more recent views counting more than
// old ones. The top categories each get a share of the slots proportional
// to their weight; anything already bought or viewed is left out (the
// cabinet's "Переглянуті" tab already shows those), and any slots still
// empty are filled with random products so the list is always full. No
// history at all → the plain random list, `personalized: false`.
router.get('/recommended', optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 30);
    const VISIBLE = `p.available = true AND s.active = true AND (s.manual_selection = false OR p.included = true)`;
    const COLS = `p.id, p.name, p.retail_price, p.picture_url, p.vendor`;

    // ---- collect signals: [{ id, weight }] ----
    const signals = new Map(); // product id -> weight
    const bump = (id, w) => signals.set(String(id), (signals.get(String(id)) || 0) + w);
    const purchased = new Set();

    if (req.user) {
      const { rows: bought } = await pool.query('SELECT DISTINCT product_id FROM orders WHERE user_id = $1 AND product_id IS NOT NULL', [req.user.id]);
      bought.forEach((r) => { purchased.add(String(r.product_id)); bump(r.product_id, 3); });
      const { rows: seen } = await pool.query('SELECT product_id FROM product_views WHERE user_id = $1 ORDER BY viewed_at DESC LIMIT 50', [req.user.id]);
      seen.forEach((r, i) => bump(r.product_id, 1 + (seen.length - i) / seen.length));
    } else if (req.query.viewed) {
      const ids = String(req.query.viewed).split(',').filter((v) => /^\d+$/.test(v)).slice(0, 50);
      ids.forEach((id, i) => bump(id, 1 + (ids.length - i) / ids.length));
    }

    const exclude = [...signals.keys()];
    const picked = new Map(); // id -> row
    let personalized = false;

    if (signals.size) {
      // ---- which categories do those products belong to? ----
      const { rows: attrs } = await pool.query(
        `SELECT p.id, p.section,
                COALESCE((SELECT array_agg(pc.category_id) FROM product_categories pc WHERE pc.product_id = p.id), '{}') AS cats
           FROM products p WHERE p.id = ANY($1::bigint[])`,
        [exclude]
      );
      const keyWeight = new Map(); // 'cat:12' | 'sec:Назва' -> weight
      for (const a of attrs) {
        const w = signals.get(String(a.id)) || 0;
        const keys = a.cats.length ? a.cats.map((c) => `cat:${c}`) : (a.section ? [`sec:${a.section}`] : []);
        keys.forEach((k) => keyWeight.set(k, (keyWeight.get(k) || 0) + w / keys.length));
      }

      const top = [...keyWeight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const totalW = top.reduce((sum, [, w]) => sum + w, 0);

      for (const [key, w] of top) {
        const quota = Math.max(1, Math.round(limit * (w / totalW)));
        const cond = key.startsWith('cat:')
          ? `EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id AND pc.category_id = $2)`
          : `p.section = $2`;
        const { rows } = await pool.query(
          `SELECT ${COLS} FROM products p JOIN suppliers s ON s.id = p.supplier_id
            WHERE ${VISIBLE} AND p.id <> ALL($1::bigint[]) AND ${cond}
            ORDER BY random() LIMIT ${quota}`,
          [exclude, key.startsWith('cat:') ? Number(key.slice(4)) : key.slice(4)]
        );
        rows.forEach((r) => picked.set(String(r.id), r));
      }
      personalized = picked.size > 0;
    }

    // ---- top up with random products so the list is always full ----
    if (picked.size < limit) {
      const skip = [...new Set([...purchased, ...picked.keys()])];
      const { rows } = await pool.query(
        `SELECT ${COLS} FROM products p JOIN suppliers s ON s.id = p.supplier_id
          WHERE ${VISIBLE} AND p.id <> ALL($1::bigint[])
          ORDER BY random() LIMIT ${limit - picked.size}`,
        [skip]
      );
      rows.forEach((r) => picked.set(String(r.id), r));
    }

    // shuffle so the personalised picks aren't grouped category by category
    const products = [...picked.values()].slice(0, limit).sort(() => Math.random() - 0.5);
    res.json({ products: await attachRatings(products), personalized });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load recommendations' });
  }
});

// GET /api/products/:id — single product for a product-detail page.
// supplier_product_id and cost price stay server-side; a customer has no
// business knowing what you paid or what the item is called upstream.
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.description, p.retail_price, p.picture_url, p.pictures,
              p.vendor, p.vendor_code, p.params, p.category_id, p.category_name,
              p.section, p.stock, p.available, p.raw_meta,
              s.name AS supplier_name, s.fulfillment_type, s.payment_methods
         FROM products p JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.id = $1 AND s.active = true`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const { rows: cats } = await pool.query(
      `SELECT c.id, c.name, c.parent_id
         FROM product_categories pc JOIN categories c ON c.id = pc.category_id
        WHERE pc.product_id = $1
        ORDER BY c.name`,
      [req.params.id]
    );

    const { raw_meta, fulfillment_type, ...product } = rows[0];
    product.seller_name = resolveSeller({ raw_meta, fulfillment_type, supplier_name: product.supplier_name });

    res.json({ ...product, shop_categories: cats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load product' });
  }
});

// PATCH /api/products/:id/retail-price — owner only (this used to be open
// to anyone, meaning a stranger could set your prices to 1 UAH).
// Setting retail_price marks the product as price_overridden, which is
// what stops the next catalogue sync from resetting it.
router.patch('/:id/retail-price',
  requireAdminAuth, requirePermission('settings'),
  async (req, res) => {
    try {
      const { retail_price, featured, markup_percent } = req.body;
      const { rows } = await pool.query(
        `UPDATE products
            SET retail_price     = COALESCE($2, retail_price),
                price_overridden = CASE WHEN $2::numeric IS NOT NULL THEN true ELSE price_overridden END,
                markup_percent   = COALESCE($4, markup_percent),
                featured         = COALESCE($3, featured),
                updated_at       = now()
          WHERE id = $1 RETURNING *`,
        [req.params.id, retail_price ?? null, featured ?? null, markup_percent ?? null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update product' });
    }
  }
);

// DELETE /api/products/:id/retail-price — drop the manual price and go
// back to automatic markup pricing on the next sync.
router.delete('/:id/retail-price',
  requireAdminAuth, requirePermission('settings'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE products p
            SET price_overridden = false,
                retail_price = ROUND(p.price * (1 + COALESCE(p.markup_percent, s.markup_percent) / 100), 2)
           FROM suppliers s
          WHERE p.id = $1 AND s.id = p.supplier_id
          RETURNING p.*`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to reset price' });
    }
  }
);

module.exports = router;
