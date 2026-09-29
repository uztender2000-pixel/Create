const express = require('express');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendSms } = require('../services/smsClient');
const { sendEmail } = require('../services/emailClient');

const router = express.Router();
router.use(requireAuth); // every account route requires login

// GET /api/account/orders — this user's order history with status
router.get('/orders', async (req, res) => {
  try {
    const { rows } = await pool.query(
      // unit_price is the price the customer actually paid, frozen at
      // checkout — p.retail_price may have changed since, and with several
      // suppliers repricing daily it usually has. Falls back to the current
      // price for orders placed before unit_price existed.
      // group_id lets the account page show one checkout as one order even
      // when it was split across suppliers into several shipments.
      `SELECT o.id, o.group_id, o.status, o.ttn, o.quantity,
              o.delivery_method, o.np_branch, o.courier_address,
              o.customer_city, o.created_at,
              p.name AS product_name, p.picture_url,
              COALESCE(o.unit_price, p.retail_price) AS retail_price
       FROM orders o
       JOIN products p ON p.id = o.product_id
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC, o.id`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// PATCH /api/account — update name / saved delivery info. Changing email or
// phone resets its verified flag and requires re-confirming with a new code.
router.patch('/', async (req, res) => {
  try {
    const { name, email, phone, saved_delivery_method, saved_city, saved_city_ref, saved_branch, saved_courier_address } = req.body;
    const updates = [];
    const params = [];
    let resetEmailVerified = false;
    let resetPhoneVerified = false;

    if (name) { params.push(name); updates.push(`name = $${params.length}`); }
    if (saved_delivery_method !== undefined) { params.push(saved_delivery_method); updates.push(`saved_delivery_method = $${params.length}`); }
    if (saved_city !== undefined) { params.push(saved_city); updates.push(`saved_city = $${params.length}`); }
    if (saved_city_ref !== undefined) { params.push(saved_city_ref); updates.push(`saved_city_ref = $${params.length}`); }
    if (saved_branch !== undefined) { params.push(saved_branch); updates.push(`saved_branch = $${params.length}`); }
    if (saved_courier_address !== undefined) { params.push(saved_courier_address); updates.push(`saved_courier_address = $${params.length}`); }

    if (email) {
      const existing = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email.toLowerCase(), req.user.id]);
      if (existing.rows.length) return res.status(409).json({ error: 'Цей email вже використовується' });
      params.push(email.toLowerCase()); updates.push(`email = $${params.length}`);
      updates.push('email_verified = false');
      resetEmailVerified = true;
    }
    if (phone) {
      params.push(phone); updates.push(`phone = $${params.length}`);
      updates.push('phone_verified = false');
      resetPhoneVerified = true;
    }

    if (!updates.length) return res.status(400).json({ error: 'Немає що оновлювати' });

    params.push(req.user.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, email, phone, phone_verified, email_verified,
                 saved_delivery_method, saved_city, saved_city_ref, saved_branch, saved_courier_address`,
      params
    );

    const user = rows[0];
    if (resetEmailVerified) sendEmail(user.email, 'Підтвердьте новий email — OllShop', 'Зайдіть у свій кабінет OllShop, щоб надіслати новий код підтвердження.').catch(() => {});
    if (resetPhoneVerified) sendSms(user.phone, 'OllShop: підтвердіть новий номер телефону у своєму кабінеті.').catch(() => {});

    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося оновити профіль' });
  }
});

// PATCH /api/account/password — { currentPassword, newPassword }
router.patch('/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Потрібні поточний і новий пароль (мінімум 6 символів)' });
    }

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Поточний пароль невірний' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося змінити пароль' });
  }
});

// POST /api/account/message — { message } — sends a note to you (the shop
// owner) via Telegram, and keeps a copy in the database.
router.post('/message', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Повідомлення не може бути порожнім' });

    await pool.query('INSERT INTO support_messages (user_id, message) VALUES ($1, $2)', [req.user.id, message.trim()]);

    const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const { rows } = await pool.query('SELECT name, email, phone FROM users WHERE id = $1', [req.user.id]);
      const u = rows[0];
      const text = `✉️ Повідомлення від клієнта\n${u.name} (${u.email}, ${u.phone})\n\n${message.trim()}`;
      axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text }).catch(() => {});
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося надіслати повідомлення' });
  }
});

// ---------------------------------------------------------------------
// Customer cabinet: order history grouped by checkout, re-ordering, and
// the browsing history (last 50 distinct products).
// ---------------------------------------------------------------------

// Same rule as the public catalogue: a product is only shown/offered if it's
// in stock, its supplier is switched on, and (for manual-selection
// suppliers) you've explicitly put it on sale.
const VISIBLE = `p.available = true AND s.active = true AND (s.manual_selection = false OR p.included = true)`;

// Order lifecycle, in order. Anything not listed here (e.g. a status added
// later by hand, like "cancelled") is passed through untouched and just
// doesn't take part in the progress calculation.
const STATUS_RANK = { new: 0, confirmed: 1, ordered_from_supplier: 2, shipped: 3, done: 4 };

// GET /api/account/orders/grouped — one entry per CHECKOUT (a basket that
// was split across suppliers into several shipments is still one order to
// the customer), newest first, each with its line items, total, delivery
// details and an overall status. The overall status is that of the
// slowest-moving shipment — "shipped" only once everything has shipped —
// while each line still carries its own status and TTN.
router.get('/orders/grouped', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id, COALESCE(o.group_id::text, 'o' || o.id) AS group_key,
              o.status, o.ttn, o.quantity, o.product_id,
              o.delivery_method, o.customer_city, o.np_branch, o.courier_address, o.comment,
              o.created_at,
              p.name AS product_name, p.picture_url,
              COALESCE(o.unit_price, p.retail_price) AS unit_price
         FROM orders o
         LEFT JOIN products p ON p.id = o.product_id
        WHERE o.user_id = $1
        ORDER BY o.created_at DESC, o.id`,
      [req.user.id]
    );

    const groups = new Map();
    for (const r of rows) {
      let g = groups.get(r.group_key);
      if (!g) {
        g = {
          group_key: r.group_key,
          number: r.id,
          created_at: r.created_at,
          delivery_method: r.delivery_method,
          city: r.customer_city,
          np_branch: r.np_branch,
          courier_address: r.courier_address,
          comment: r.comment,
          items: [],
          total: 0,
        };
        groups.set(r.group_key, g);
      }
      g.number = Math.min(g.number, r.id);
      const unit = Number(r.unit_price) || 0;
      g.items.push({
        order_id: r.id,
        product_id: r.product_id,
        name: r.product_name || 'Товар більше недоступний',
        picture_url: r.picture_url,
        quantity: r.quantity,
        unit_price: unit,
        status: r.status,
        ttn: r.ttn,
      });
      g.total += unit * (r.quantity || 1);
    }

    const result = [...groups.values()].map((g) => {
      const inFlow = g.items.filter((i) => i.status in STATUS_RANK);
      g.status = inFlow.length
        ? inFlow.reduce((a, b) => (STATUS_RANK[b.status] < STATUS_RANK[a.status] ? b : a)).status
        : g.items[0].status; // all lines outside the normal flow (e.g. cancelled)
      g.ttns = [...new Set(g.items.map((i) => i.ttn).filter(Boolean))];
      return g;
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити замовлення' });
  }
});

// POST /api/account/orders/:groupKey/reorder — puts every still-available
// item of a past order back into the cart. Items that can no longer be
// bought are skipped and reported by name instead of failing the lot.
router.post('/orders/:groupKey/reorder', async (req, res) => {
  const client = await pool.connect();
  try {
    const key = req.params.groupKey;
    const byLineId = /^o(\d+)$/.exec(key);
    const { rows: lines } = await client.query(
      `SELECT o.product_id, o.quantity, p.name, (${VISIBLE}) AS buyable
         FROM orders o
         JOIN products p ON p.id = o.product_id
         JOIN suppliers s ON s.id = p.supplier_id
        WHERE o.user_id = $1 AND ${byLineId ? 'o.id = $2' : 'o.group_id::text = $2'}`,
      [req.user.id, byLineId ? Number(byLineId[1]) : key]
    );
    if (!lines.length) return res.status(404).json({ error: 'Замовлення не знайдено' });

    const added = [];
    const skipped = [];
    await client.query('BEGIN');
    for (const l of lines) {
      if (!l.buyable) { skipped.push(l.name); continue; }
      await client.query(
        `INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`,
        [req.user.id, l.product_id, Math.max(l.quantity || 1, 1)]
      );
      added.push(l.name);
    }
    await client.query('COMMIT');

    const { rows } = await pool.query('SELECT COALESCE(SUM(quantity), 0)::int AS count FROM cart_items WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true, added: added.length, skipped, cartCount: rows[0].count });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Не вдалося повторити замовлення' });
  } finally {
    client.release();
  }
});

// ----- Browsing history (last 50 products) -----
const VIEW_LIMIT = 50;

async function trimViews(userId) {
  await pool.query(
    `DELETE FROM product_views
      WHERE user_id = $1
        AND product_id NOT IN (
          SELECT product_id FROM product_views WHERE user_id = $1 ORDER BY viewed_at DESC LIMIT ${VIEW_LIMIT}
        )`,
    [userId]
  );
}

// GET /api/account/views — newest first. Products that have since gone out
// of stock or been taken off sale are kept in the history but not listed
// (nothing to click through to); they reappear if they come back.
router.get('/views', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.retail_price, p.picture_url, p.vendor, v.viewed_at
         FROM product_views v
         JOIN products p ON p.id = v.product_id
         JOIN suppliers s ON s.id = p.supplier_id
        WHERE v.user_id = $1 AND ${VISIBLE}
        ORDER BY v.viewed_at DESC
        LIMIT ${VIEW_LIMIT}`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити історію переглядів' });
  }
});

// POST /api/account/views — { product_id } — record that this product was opened
router.post('/views', async (req, res) => {
  try {
    const productId = String(req.body.product_id || '');
    if (!/^\d+$/.test(productId)) return res.status(400).json({ error: 'product_id обов\'язковий' });

    const { rowCount } = await pool.query(
      `INSERT INTO product_views (user_id, product_id)
       SELECT $1, id FROM products WHERE id = $2
       ON CONFLICT (user_id, product_id) DO UPDATE SET viewed_at = now()`,
      [req.user.id, productId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Товар не знайдено' });
    await trimViews(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося зберегти перегляд' });
  }
});

// POST /api/account/views/sync — { product_ids: [newest, ..., oldest] }
// Merges what a visitor browsed BEFORE logging in (kept in their browser)
// into their account history, so a fresh login doesn't start from zero.
router.post('/views/sync', async (req, res) => {
  try {
    // De-duplicated keeping the FIRST occurrence (= the most recent view):
    // a single INSERT ... ON CONFLICT can't touch the same row twice.
    const ids = [...new Set((Array.isArray(req.body.product_ids) ? req.body.product_ids : [])
      .map(String).filter((v) => /^\d+$/.test(v)))].slice(0, VIEW_LIMIT);
    if (!ids.length) return res.json({ ok: true, merged: 0 });

    await pool.query(
      `INSERT INTO product_views (user_id, product_id, viewed_at)
       SELECT $1, p.id, now() - (t.ord * interval '1 second')
         FROM unnest($2::bigint[]) WITH ORDINALITY AS t(pid, ord)
         JOIN products p ON p.id = t.pid
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET viewed_at = GREATEST(product_views.viewed_at, EXCLUDED.viewed_at)`,
      [req.user.id, ids]
    );
    await trimViews(req.user.id);
    res.json({ ok: true, merged: ids.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося синхронізувати історію' });
  }
});

// DELETE /api/account/views — clear the whole history
router.delete('/views', async (req, res) => {
  try {
    await pool.query('DELETE FROM product_views WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося очистити історію' });
  }
});

// DELETE /api/account/views/:productId — drop a single item from the history
router.delete('/views/:productId', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.productId)) return res.status(400).json({ error: 'Невірний id' });
    await pool.query('DELETE FROM product_views WHERE user_id = $1 AND product_id = $2', [req.user.id, req.params.productId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося видалити' });
  }
});

module.exports = router;
