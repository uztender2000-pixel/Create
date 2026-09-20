const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Whitelist of sort options -> SQL ORDER BY clause. Never interpolate the
// sort value directly into SQL — always go through this map.
const SORT_OPTIONS = {
  price_asc: 'retail_price ASC NULLS LAST',
  price_desc: 'retail_price DESC NULLS LAST',
  name_asc: 'name ASC',
  name_desc: 'name DESC',
  popular: 'order_count DESC, updated_at DESC',
  newest: 'updated_at DESC',
};

// GET /api/products — list available products, paginated and sortable.
// ?featured=true       -> just your test finalists
// ?section=...          -> filter by top-level section (e.g. "Зоотовари")
// ?category_id=...      -> filter by specific category within a section
// ?sort=price_asc|price_desc|name_asc|name_desc|popular|newest (default newest)
// ?page=1&limit=24      -> pagination (defaults: page 1, 24 per page, max 100 per page)
router.get('/', async (req, res) => {
  try {
    const { featured, section, category_id } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
    const offset = (page - 1) * limit;
    const sortKey = SORT_OPTIONS[req.query.sort] ? req.query.sort : 'newest';
    const orderBy = SORT_OPTIONS[sortKey];

    const conditions = ['available = true'];
    const params = [];

    if (featured === 'true') {
      conditions.push('featured = true');
    }
    if (section) {
      params.push(section);
      conditions.push(`section = $${params.length}`);
    }
    if (category_id) {
      params.push(category_id);
      conditions.push(`category_id = $${params.length}`);
    }
    const where = conditions.join(' AND ');

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM products WHERE ${where}`,
      params
    );
    const total = countRows[0].total;

    // order_count is only computed when sorting by popularity — the LEFT
    // JOIN is cheap to include always, but only matters for that one sort.
    const dataParams = [...params, limit, offset];
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.description, p.retail_price, p.price, p.picture_url,
              p.vendor, p.category_id, p.category_name, p.section,
              COALESCE(oc.order_count, 0) AS order_count
       FROM products p
       LEFT JOIN (
         SELECT product_id, COUNT(*)::int AS order_count
         FROM orders
         GROUP BY product_id
       ) oc ON oc.product_id = p.id
       WHERE ${where.replace(/\bavailable\b/g, 'p.available').replace(/\bfeatured\b/g, 'p.featured').replace(/\bsection\b/g, 'p.section').replace(/\bcategory_id\b/g, 'p.category_id')}
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

// GET /api/products/meta/stats — total product count, for the homepage's
// "40 000+ товарів"-style counter so it never goes stale.
router.get('/meta/stats', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM products WHERE available = true');
    res.json({ totalProducts: rows[0].total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// GET /api/products/meta/sections — top-level sections, alphabetical, with
// a product count each. Powers the sidebar's top level.
router.get('/meta/sections', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT section, COUNT(*)::int AS count
       FROM products
       WHERE available = true AND section IS NOT NULL
       GROUP BY section
       ORDER BY section ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load sections' });
  }
});

// GET /api/products/meta/categories — categories with product counts,
// alphabetical. Add ?section=... to scope to one section (sidebar's
// second level, shown when a section is expanded).
router.get('/meta/categories', async (req, res) => {
  try {
    const { section } = req.query;
    const conditions = ['available = true', 'category_id IS NOT NULL'];
    const params = [];
    if (section) {
      params.push(section);
      conditions.push(`section = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT category_id, category_name, section, COUNT(*)::int AS count
       FROM products
       WHERE ${conditions.join(' AND ')}
       GROUP BY category_id, category_name, section
       ORDER BY category_name ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// GET /api/products/:id — single product for a product-detail page
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load product' });
  }
});

// PATCH /api/products/:id/retail-price — set your own selling price.
router.patch('/:id/retail-price', async (req, res) => {
  try {
    const { retail_price, featured } = req.body;
    const { rows } = await pool.query(
      `UPDATE products SET retail_price = COALESCE($2, retail_price),
                            featured = COALESCE($3, featured)
       WHERE id = $1 RETURNING *`,
      [req.params.id, retail_price ?? null, featured ?? null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

module.exports = router;
