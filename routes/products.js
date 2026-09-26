const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();

// Sentinel value for "products with no section" — chosen unlikely to
// collide with a real category name from any feed. The frontend maps
// this exact string to the label "Без категорії"; nothing else about it
// is special to the database.
const UNCATEGORIZED = '__uncategorized__';

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

// GET /api/products — list available products, paginated and sortable.
// ?featured=true        -> just your test finalists
// ?section=...          -> filter by top-level section
// ?category_id=...      -> filter by specific category within a section
// ?supplier=code        -> only one supplier's products
// ?q=...                -> search by name or article/vendor_code
// ?sort=... ?page=1&limit=24
router.get('/', async (req, res) => {
  try {
    const { featured, section, category_id, q, supplier, shop_category_id } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
    const offset = (page - 1) * limit;
    const sortKey = SORT_OPTIONS[req.query.sort] ? req.query.sort : 'newest';
    const orderBy = SORT_OPTIONS[sortKey];

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
              s.code AS supplier_code, s.name AS supplier_name,
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

    res.json({
      products: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      sort: sortKey,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load products' });
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

// GET /api/products/meta/shop-categories — the admin's own category tree
// (see routes/adminCategories.js), each with how many products currently
// on sale sit in it (or in any of its subcategories). A category with
// zero products anywhere in its branch is left out entirely — an empty
// category is just noise in storefront navigation.
router.get('/meta/shop-categories', async (req, res) => {
  try {
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
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load shop categories' });
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
              p.section, p.stock, p.available,
              s.name AS supplier_name
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

    res.json({ ...rows[0], shop_categories: cats });
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
