const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { dispatchGroup } = require('../services/orderDispatcher');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();

// POST /api/orders — one-click order straight from a product page.
// Public on purpose: this is the guest checkout. It creates a single-row
// order group, so it goes through exactly the same supplier dispatch as
// a multi-item cart checkout.
router.post('/', async (req, res) => {
  try {
    const {
      product_id, quantity,
      customer_name, customer_phone, customer_city,
      np_branch, delivery_method, courier_address, comment,
    } = req.body;

    if (!product_id || !customer_name || !customer_phone) {
      return res.status(400).json({ error: "product_id, ім'я та телефон обов'язкові" });
    }
    const qty = Math.max(parseInt(quantity, 10) || 1, 1);

    const { rows: productRows } = await pool.query(
      'SELECT id, name, supplier_id, price, retail_price, available FROM products WHERE id = $1',
      [product_id]
    );
    if (!productRows.length) return res.status(404).json({ error: 'Товар не знайдено' });

    const product = productRows[0];
    if (!product.available) return res.status(409).json({ error: 'Товару немає в наявності' });

    const groupId = crypto.randomUUID();

    const { rows } = await pool.query(
      `INSERT INTO orders (
         group_id, product_id, supplier_id, quantity,
         customer_name, customer_phone, customer_city,
         np_branch, delivery_method, courier_address, comment,
         unit_price, cost_price
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        groupId, product.id, product.supplier_id, qty,
        customer_name, customer_phone, customer_city,
        np_branch, delivery_method || 'branch', courier_address, comment,
        product.retail_price, product.price,
      ]
    );

    // Notify + try to place the order with the supplier automatically.
    // Deliberately not awaited into the response path beyond this point:
    // if a supplier API is slow, the customer still gets a fast reply.
    const dispatch = await dispatchGroup(groupId);

    res.status(201).json({ ...rows[0], group_id: groupId, dispatch });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося оформити замовлення' });
  }
});

// Everything below is owner-only. Previously these two routes were open
// to the internet, which meant anyone could read every customer's name,
// phone and address, or change order statuses.
router.use(requireAdminAuth, requirePermission('orders'));

// GET /api/orders — order rows, newest first. ?status=... ?supplier_id=...
router.get('/', async (req, res) => {
  try {
    const { status, supplier_id } = req.query;
    const conditions = [];
    const params = [];

    if (status) { params.push(status); conditions.push(`o.status = $${params.length}`); }
    if (supplier_id) { params.push(supplier_id); conditions.push(`o.supplier_id = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT o.*, p.name AS product_name, s.name AS supplier_name, s.code AS supplier_code
         FROM orders o
         JOIN products p ON p.id = o.product_id
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         ${where}
        ORDER BY o.created_at DESC
        LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// PATCH /api/orders/:id — move an order row through the pipeline.
router.patch('/:id', async (req, res) => {
  try {
    const { status, ttn } = req.body;
    const { rows } = await pool.query(
      `UPDATE orders SET status = COALESCE($2, status), ttn = COALESCE($3, ttn)
        WHERE id = $1 RETURNING *`,
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
