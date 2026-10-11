const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAdminRole } = require('../middleware/adminRole');
const { mfaRequiredFor } = require('../middleware/adminAuth');
const { sendEmail } = require('../services/emailClient');
const { SHOP_NAME } = require('../services/brand');

const router = express.Router();
// Лише роль «Адміністратор». Раніше сюди пускало будь-кого з правом settings — такий працівник міг
// призначити собі роль admin або скинути пароль власника. Тепер це неможливо.
router.use(requireAdminAuth, requireAdminRole);

// GET /api/admin/users — list every admin/staff account
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, role, permissions, active, must_change_password, created_at, mfa_enabled, locked_until FROM admin_users ORDER BY created_at ASC'
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
      `Доступ до панелі керування ${SHOP_NAME}`,
      `Вітаємо! Вам створено доступ до адмін-панелі ${SHOP_NAME}.\n\nEmail: ${email}\nТимчасовий пароль: ${tempPassword}\n\nПри першому вході систему попросить змінити пароль.`
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

    // Щоб випадково не залишитися без адміністратора: себе не можна деактивувати чи понизити.
    if (String(req.params.id) === String(req.admin.id) && (active === false || (role && role !== 'admin'))) {
      return res.status(400).json({ error: 'Не можна деактивувати або понизити власний обліковий запис' });
    }

    if (role) { params.push(role === 'admin' ? 'admin' : 'staff'); updates.push(`role = $${params.length}`); }
    if (permissions) { params.push(JSON.stringify(permissions)); updates.push(`permissions = $${params.length}`); }
    if (active !== undefined) { params.push(active); updates.push(`active = $${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Немає що оновлювати' });
    updates.push('token_version = token_version + 1');   // зміна ролі/прав/активності завершує його поточні сесії

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
      'UPDATE admin_users SET password_hash = $1, must_change_password = true, token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = $2 RETURNING email',
      [passwordHash, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const emailResult = await sendEmail(rows[0].email, `Новий пароль для панелі ${SHOP_NAME}`, `Ваш новий тимчасовий пароль: ${tempPassword}\n\nПри вході систему попросить його змінити.`);
    res.json({ tempPassword, emailSent: emailResult.sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося скинути пароль' });
  }
});

// POST /api/admin/users/:id/unlock — знімає тимчасове блокування після невдалих спроб входу
router.post('/:id/unlock', async (req, res) => {
  const { rowCount } = await pool.query('UPDATE admin_users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// POST /api/admin/users/:id/reset-mfa — скидає 2FA (втрачено телефон і резервні коди) та завершує
// всі його сесії. Якщо 2FA для ролі обов'язкова, людина налаштує її знову при наступному вході.
router.post('/:id/reset-mfa', async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE admin_users SET mfa_enabled = false, mfa_secret = NULL, mfa_backup_codes = '[]'::jsonb, mfa_last_step = NULL,
            token_version = token_version + 1 WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// POST /api/admin/users/:id/revoke-sessions — завершує всі активні сесії користувача
router.post('/:id/revoke-sessions', async (req, res) => {
  const { rowCount } = await pool.query('UPDATE admin_users SET token_version = token_version + 1 WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
