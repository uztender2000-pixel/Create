const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/products — list available products, paginated.
// ?featured=true       -> just your 3 test finalists
// ?category_id=...     -> filter by category
// ?page=1&limit=24     -> pagination (defaults: page 1, 24 per page, max 100 per page)
router.get('/', async (req, res) => {
  try {
    const { featured, category_id } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
    const offset = (page - 1) * limit;

    const conditions = ['available = true'];
    const params = [];

    if (featured === 'true') {
      conditions.push('featured = true');
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

    const dataParams = [...params, limit, offset];
    const { rows } = await pool.query(
      `SELECT id, name, description, retail_price, price, picture_url, vendor, category_id
       FROM products
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({
      products: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// GET /api/products/categories — distinct category ids currently in stock,
// with a product count each. Useful for building a category filter menu.
router.get('/meta/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT category_id, COUNT(*)::int AS count
       FROM products
       WHERE available = true AND category_id IS NOT NULL
       GROUP BY category_id
       ORDER BY count DESC`
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

// PATCH /api/products/:id/retail-price — set your own selling price on top
// of the supplier's cost price. Call this once per finalist before going live.
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
