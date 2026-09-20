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
      `SELECT o.id, o.status, o.ttn, o.delivery_method, o.np_branch, o.courier_address,
              o.customer_city, o.created_at, p.name AS product_name, p.picture_url, p.retail_price
       FROM orders o
       JOIN products p ON p.id = o.product_id
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC`,
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

module.exports = router;
