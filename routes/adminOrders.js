const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('orders'));

// GET /api/admin/orders — all orders, newest first. ?status=... to filter.
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = 'WHERE o.status = $1'; }

    const { rows } = await pool.query(
      `SELECT o.*, p.name AS product_name, p.picture_url, p.retail_price
       FROM orders o
       JOIN products p ON p.id = o.product_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// PATCH /api/admin/orders/:id — update status / ttn
router.patch('/:id', async (req, res) => {
  try {
    const { status, ttn } = req.body;
    const { rows } = await pool.query(
      `UPDATE orders SET status = COALESCE($2, status), ttn = COALESCE($3, ttn) WHERE id = $1 RETURNING *`,
      [req.params.id, status ?? null, ttn ?? null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

module.exports = router;
