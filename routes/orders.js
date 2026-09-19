const express = require('express');
const axios = require('axios');
const { pool } = require('../db');

const router = express.Router();

// Sends you a Telegram message the moment a new order comes in, so you don't
// have to keep refreshing the database. Silently does nothing if you haven't
// set up TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID yet.
async function notifyTelegram(order, productName) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const text =
    `🛒 Нове замовлення #${order.id}\n` +
    `Товар: ${productName}\n` +
    `Клієнт: ${order.customer_name}, ${order.customer_phone}\n` +
    `Місто: ${order.customer_city || '-'}\n` +
    `Відділення НП: ${order.np_branch || '-'}\n` +
    `Коментар: ${order.comment || '-'}`;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
    });
  } catch (err) {
    console.error('[telegram] notify failed:', err.message);
  }
}

// POST /api/orders — the order form on the landing page submits here.
router.post('/', async (req, res) => {
  try {
    const { product_id, customer_name, customer_phone, customer_city, np_branch, comment } = req.body;

    if (!product_id || !customer_name || !customer_phone) {
      return res.status(400).json({ error: 'product_id, customer_name and customer_phone are required' });
    }

    const productResult = await pool.query('SELECT name FROM products WHERE id = $1', [product_id]);
    if (!productResult.rows.length) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO orders (product_id, customer_name, customer_phone, customer_city, np_branch, comment)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [product_id, customer_name, customer_phone, customer_city, np_branch, comment]
    );

    const order = rows[0];
    await notifyTelegram(order, productResult.rows[0].name);

    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// GET /api/orders — for you to check pending orders (protect this route
// before going live — see README security note).
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = 'WHERE status = $1';
    }
    const { rows } = await pool.query(
      `SELECT o.*, p.name AS product_name FROM orders o
       JOIN products p ON p.id = o.product_id
       ${where}
       ORDER BY o.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// PATCH /api/orders/:id — update status as you move the order through the
// pipeline (e.g. once you've manually placed it with the supplier).
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
