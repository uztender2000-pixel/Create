const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');
const { sendEmail } = require('../services/emailClient');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('settings')); // owner-only page in practice

// GET /api/admin/users — list every admin/staff account
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, role, permissions, active, must_change_password, created_at FROM admin_users ORDER BY created_at ASC'
  );
  res.json(rows);
});

// POST /api/admin/users — { name, email, role, permissions } — creates a
// new staff account with a random temporary password, forced to change it
// on first login. Emails the temp password if SMTP is configured.
router.post('/', async (req, res) => {
  try {
    const { name, email, role, permissions } = req.body;
    if (!name || !email) return res.status(400).json({ error: "Ім'я та email обов'язкові" });

    const existing = await pool.query('SELECT id FROM admin_users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Такий email вже є серед адмінів' });

    const tempPassword = crypto.randomBytes(6).toString('base64url'); // e.g. "aZ3kQ9mN"
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const finalPermissions = role === 'admin'
      ? { orders: true, stats: true, settings: true }
      : { orders: true, stats: false, settings: false, ...(permissions || {}) };

    const { rows } = await pool.query(
      `INSERT INTO admin_users (name, email, password_hash, role, permissions, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, name, email, role, permissions, active, must_change_password, created_at`,
      [name, email.toLowerCase(), passwordHash, role === 'admin' ? 'admin' : 'staff', finalPermissions]
    );

    const emailResult = await sendEmail(
      email,
      'Доступ до панелі керування OllShop',
      `Вітаємо! Вам створено доступ до адмін-панелі OllShop.\n\nEmail: ${email}\nТимчасовий пароль: ${tempPassword}\n\nПри першому вході систему попросить змінити пароль.`
    );

    res.status(201).json({ user: rows[0], tempPassword, emailSent: emailResult.sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося створити користувача' });
  }
});

// PATCH /api/admin/users/:id — update role/permissions/active status
router.patch('/:id', async (req, res) => {
  try {
    const { role, permissions, active } = req.body;
    const updates = [];
    const params = [];

    if (role) { params.push(role === 'admin' ? 'admin' : 'staff'); updates.push(`role = $${params.length}`); }
    if (permissions) { params.push(JSON.stringify(permissions)); updates.push(`permissions = $${params.length}`); }
    if (active !== undefined) { params.push(active); updates.push(`active = $${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Немає що оновлювати' });

    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE admin_users SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, email, role, permissions, active, must_change_password`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося оновити користувача' });
  }
});

// POST /api/admin/users/:id/reset-password — issues a new temp password
router.post('/:id/reset-password', async (req, res) => {
  try {
    const tempPassword = crypto.randomBytes(6).toString('base64url');
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const { rows } = await pool.query(
      'UPDATE admin_users SET password_hash = $1, must_change_password = true WHERE id = $2 RETURNING email',
      [passwordHash, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const emailResult = await sendEmail(rows[0].email, 'Новий пароль для панелі OllShop', `Ваш новий тимчасовий пароль: ${tempPassword}\n\nПри вході систему попросить його змінити.`);
    res.json({ tempPassword, emailSent: emailResult.sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося скинути пароль' });
  }
});

module.exports = router;
