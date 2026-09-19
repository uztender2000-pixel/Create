const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/products — list available products. Add ?featured=true to get
// just your 3 test finalists (mark them with the SQL snippet in README).
router.get('/', async (req, res) => {
  try {
    const { featured, category_id } = req.query;
    const conditions = ['available = true'];
    const params = [];

    if (featured === 'true') {
      conditions.push('featured = true');
    }
    if (category_id) {
      params.push(category_id);
      conditions.push(`category_id = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT id, name, description, retail_price, price, picture_url, vendor, category_id
       FROM products
       WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load products' });
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
