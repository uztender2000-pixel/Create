const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');
const { retrySupplierInGroup } = require('../services/orderDispatcher');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('orders'));

// GET /api/admin/orders — order rows, newest first.
// ?status=... ?supplier_id=... ?failed=true (only failed submissions)
router.get('/', async (req, res) => {
  try {
    const { status, supplier_id, failed } = req.query;
    const conditions = [];
    const params = [];

    if (status) { params.push(status); conditions.push(`o.status = $${params.length}`); }
    if (supplier_id) { params.push(supplier_id); conditions.push(`o.supplier_id = $${params.length}`); }
    if (failed === 'true') conditions.push(`o.supplier_status = 'failed'`);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT o.*, p.name AS product_name, p.picture_url,
              p.supplier_product_id,
              s.name AS supplier_name, s.code AS supplier_code, s.auto_order
         FROM orders o
         JOIN products p ON p.id = o.product_id
         LEFT JOIN suppliers s ON s.id = o.supplier_id
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

// GET /api/admin/orders/groups — orders as the customer placed them: one
// entry per checkout, with its lines grouped by supplier. This is the view
// that actually makes sense once a basket can span several suppliers.
router.get('/groups', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.group_id,
              MIN(o.created_at)                         AS created_at,
              MIN(o.customer_name)                      AS customer_name,
              MIN(o.customer_phone)                     AS customer_phone,
              MIN(o.customer_city)                      AS customer_city,
              COUNT(*)::int                             AS line_count,
              COUNT(DISTINCT o.supplier_id)::int        AS supplier_count,
              SUM(o.quantity * COALESCE(o.unit_price, 0)) AS total,
              SUM(o.quantity * COALESCE(o.cost_price, 0)) AS cost,
              BOOL_AND(o.supplier_submitted)            AS fully_submitted,
              ARRAY_AGG(DISTINCT o.status)              AS statuses
         FROM orders o
        WHERE o.group_id IS NOT NULL
        GROUP BY o.group_id
        ORDER BY created_at DESC
        LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load order groups' });
  }
});

// GET /api/admin/orders/groups/:groupId — every line of one checkout
router.get('/groups/:groupId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, p.name AS product_name, p.picture_url, p.supplier_product_id,
              s.name AS supplier_name, s.code AS supplier_code
         FROM orders o
         JOIN products p ON p.id = o.product_id
         LEFT JOIN suppliers s ON s.id = o.supplier_id
        WHERE o.group_id = $1
        ORDER BY s.name, o.id`,
      [req.params.groupId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load order group' });
  }
});

// POST /api/admin/orders/groups/:groupId/retry/:supplierId — resend one
// supplier's share after their API was down or a key was fixed.
router.post('/groups/:groupId/retry/:supplierId', async (req, res) => {
  try {
    const result = await retrySupplierInGroup(req.params.groupId, parseInt(req.params.supplierId, 10));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/orders/:id — update status / ttn for one line
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
