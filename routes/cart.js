const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { dispatchGroup } = require('../services/orderDispatcher');

const router = express.Router();
router.use(requireAuth); // every cart route requires login

// GET /api/cart — items with product details. Now also tells the customer
// which supplier each item ships from, because a multi-supplier basket
// arrives in more than one parcel and that shouldn't be a surprise.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.product_id, c.quantity,
              p.name, p.retail_price, p.picture_url, p.vendor, p.available,
              p.supplier_id, s.name AS supplier_name
         FROM cart_items c
         JOIN products p ON p.id = c.product_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE c.user_id = $1
        ORDER BY c.added_at DESC`,
      [req.user.id]
    );
    const total = rows.reduce((sum, item) => sum + Number(item.retail_price || 0) * item.quantity, 0);
    const parcels = new Set(rows.map((r) => r.supplier_id)).size;
    res.json({ items: rows, total, parcels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load cart' });
  }
});

// POST /api/cart — { product_id, quantity? } — add or increase quantity
router.post('/', async (req, res) => {
  try {
    const { product_id, quantity } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });
    const qty = Math.max(parseInt(quantity, 10) || 1, 1);

    const product = await pool.query('SELECT id FROM products WHERE id = $1 AND available = true', [product_id]);
    if (!product.rows.length) return res.status(404).json({ error: 'Товар не знайдено або недоступний' });

    await pool.query(
      `INSERT INTO cart_items (user_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`,
      [req.user.id, product_id, qty]
    );

    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM cart_items WHERE user_id = $1', [req.user.id]);
    res.status(201).json({ ok: true, cartCount: rows[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add to cart' });
  }
});

// PATCH /api/cart/:productId — { quantity } — set an exact quantity (0 removes it)
router.patch('/:productId', async (req, res) => {
  try {
    const { quantity } = req.body;
    const qty = parseInt(quantity, 10);

    if (qty <= 0) {
      await pool.query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [req.user.id, req.params.productId]);
      return res.json({ ok: true, removed: true });
    }

    const { rows } = await pool.query(
      `UPDATE cart_items SET quantity = $3 WHERE user_id = $1 AND product_id = $2 RETURNING *`,
      [req.user.id, req.params.productId, qty]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not in cart' });
    res.json({ ok: true, item: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update cart item' });
  }
});

// DELETE /api/cart/:productId — remove one item from the cart
router.delete('/:productId', async (req, res) => {
  try {
    await pool.query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [req.user.id, req.params.productId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove cart item' });
  }
});

// POST /api/cart/checkout — turns the cart into one order group: one row
// per product, all sharing a group_id, each tagged with its supplier.
// The dispatcher then splits that group by supplier and submits each
// share separately.
router.post('/checkout', async (req, res) => {
  const client = await pool.connect();
  let groupId;
  try {
    const { customer_name, customer_phone, customer_city, np_branch, delivery_method, courier_address, comment } = req.body;
    if (!customer_name || !customer_phone) {
      return res.status(400).json({ error: "Ім'я та телефон обов'язкові" });
    }

    const { rows: cartRows } = await client.query(
      `SELECT c.product_id, c.quantity, p.name, p.supplier_id, p.price, p.retail_price, p.available
         FROM cart_items c JOIN products p ON p.id = c.product_id
        WHERE c.user_id = $1`,
      [req.user.id]
    );
    if (!cartRows.length) {
      return res.status(400).json({ error: 'Кошик порожній' });
    }

    // A product can go out of stock between adding it and checking out —
    // with several suppliers syncing on their own schedules this happens
    // more often than with one feed, so check at the last moment.
    const unavailable = cartRows.filter((r) => !r.available);
    if (unavailable.length) {
      return res.status(409).json({
        error: 'Деякі товари вже недоступні — приберіть їх з кошика',
        items: unavailable.map((r) => ({ product_id: r.product_id, name: r.name })),
      });
    }

    groupId = crypto.randomUUID();

    await client.query('BEGIN');
    const orderIds = [];
    for (const item of cartRows) {
      const { rows } = await client.query(
        `INSERT INTO orders (
           group_id, product_id, supplier_id, quantity,
           customer_name, customer_phone, customer_city,
           np_branch, delivery_method, courier_address, comment,
           user_id, unit_price, cost_price
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          groupId, item.product_id, item.supplier_id, item.quantity,
          customer_name, customer_phone, customer_city,
          np_branch, delivery_method || 'branch', courier_address, comment,
          req.user.id, item.retail_price, item.price,
        ]
      );
      orderIds.push(rows[0].id);
    }
    await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.user.id]);
    await client.query('COMMIT');

    const dispatch = await dispatchGroup(groupId);

    res.status(201).json({ ok: true, groupId, orderIds, dispatch });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Не вдалося оформити замовлення' });
  } finally {
    client.release();
  }
});

module.exports = router;
