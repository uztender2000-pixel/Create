const express = require('express');
const axios = require('axios');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { submitOrderToSupplier } = require('../services/supplierClient');

const router = express.Router();
router.use(requireAuth); // every cart route requires login

// GET /api/cart — items with product details (name, price, picture)
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.product_id, c.quantity, p.name, p.retail_price, p.picture_url, p.vendor
       FROM cart_items c
       JOIN products p ON p.id = c.product_id
       WHERE c.user_id = $1
       ORDER BY c.added_at DESC`,
      [req.user.id]
    );
    const total = rows.reduce((sum, item) => sum + (item.retail_price || 0) * item.quantity, 0);
    res.json({ items: rows, total });
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

// Sends you a Telegram message for a cart checkout (multiple items at once).
async function notifyTelegram(orderIds, items, customer) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const itemLines = items.map((i) => `• ${i.name} x${i.quantity}`).join('\n');
  const deliveryLine = customer.delivery_method === 'courier'
    ? `Кур'єром: ${customer.courier_address || '-'}`
    : `Відділення НП: ${customer.np_branch || '-'}`;
  const text =
    `🛒 Нове замовлення з кошика (#${orderIds.join(', #')})\n` +
    `Товари:\n${itemLines}\n` +
    `Клієнт: ${customer.customer_name}, ${customer.customer_phone}\n` +
    `Місто: ${customer.customer_city || '-'}\n` +
    `${deliveryLine}\n` +
    `Коментар: ${customer.comment || '-'}`;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
    });
  } catch (err) {
    console.error('[telegram] cart notify failed:', err.message);
  }
}

// POST /api/cart/checkout — turns every item in the cart into an order
// (one order row per product, same customer info), then empties the cart.
router.post('/checkout', async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, customer_phone, customer_city, np_branch, delivery_method, courier_address, comment } = req.body;
    if (!customer_name || !customer_phone) {
      return res.status(400).json({ error: "Ім'я та телефон обов'язкові" });
    }

    const { rows: cartRows } = await client.query(
      `SELECT c.product_id, c.quantity, p.name
       FROM cart_items c JOIN products p ON p.id = c.product_id
       WHERE c.user_id = $1`,
      [req.user.id]
    );
    if (!cartRows.length) {
      return res.status(400).json({ error: 'Кошик порожній' });
    }

    await client.query('BEGIN');
    const orderIds = [];
    for (const item of cartRows) {
      const { rows } = await client.query(
        `INSERT INTO orders (product_id, customer_name, customer_phone, customer_city, np_branch, delivery_method, courier_address, comment, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [item.product_id, customer_name, customer_phone, customer_city, np_branch, delivery_method || 'branch', courier_address, comment, req.user.id]
      );
      orderIds.push(rows[0].id);
    }
    await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.user.id]);
    await client.query('COMMIT');

    await notifyTelegram(orderIds, cartRows, { customer_name, customer_phone, customer_city, np_branch, delivery_method, courier_address, comment });

    // Attempt automatic submission to the supplier for the whole cart at
    // once. Does nothing until SUPPLIER_API_URL / SUPPLIER_API_KEY are
    // configured — see services/supplierClient.js.
    const supplierResult = await submitOrderToSupplier({
      customerName: customer_name,
      customerPhone: customer_phone,
      city: customer_city,
      npBranch: np_branch,
      comment,
      items: cartRows.map((item) => ({ productId: item.product_id, quantity: item.quantity })),
    });
    if (supplierResult.submitted) {
      await pool.query('UPDATE orders SET supplier_submitted = true WHERE id = ANY($1)', [orderIds]);
    }

    res.status(201).json({ ok: true, orderIds, supplierSubmitted: supplierResult.submitted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Не вдалося оформити замовлення' });
  } finally {
    client.release();
  }
});

module.exports = router;
