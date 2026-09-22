const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();

// Whitelist of sort options -> SQL ORDER BY clause. Never interpolate the
// sort value directly into SQL — always go through this map.
const SORT_OPTIONS = {
  price_asc: 'p.retail_price ASC NULLS LAST',
  price_desc: 'p.retail_price DESC NULLS LAST',
  name_asc: 'p.name ASC',
  name_desc: 'p.name DESC',
  popular: 'order_count DESC, p.updated_at DESC',
  newest: 'p.updated_at DESC',
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
    const { featured, section, category_id, q, supplier } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
    const offset = (page - 1) * limit;
    const sortKey = SORT_OPTIONS[req.query.sort] ? req.query.sort : 'newest';
    const orderBy = SORT_OPTIONS[sortKey];

    // Only sell what's available AND from a supplier that's switched on —
    // deactivating a supplier now hides its whole catalogue in one click.
    const conditions = ['p.available = true', 's.active = true'];
    const params = [];

    if (featured === 'true') conditions.push('p.featured = true');
    if (section) { params.push(section); conditions.push(`p.section = $${params.length}`); }
    if (category_id) { params.push(category_id); conditions.push(`p.category_id = $${params.length}`); }
    if (supplier) { params.push(supplier); conditions.push(`s.code = $${params.length}`); }
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
router.get('/meta/sections', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.section, COUNT(*)::int AS count
         FROM products p JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.available = true AND s.active = true AND p.section IS NOT NULL
        GROUP BY p.section
        ORDER BY p.section ASC`
    );
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
    if (section) { params.push(section); conditions.push(`p.section = $${params.length}`); }

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
    res.json(rows[0]);
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
