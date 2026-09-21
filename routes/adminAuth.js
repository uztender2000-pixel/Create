const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

function signAdminToken(admin) {
  return jwt.sign({ adminId: admin.id }, process.env.ADMIN_JWT_SECRET, { expiresIn: '12h' });
}

function publicAdmin(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, permissions: row.permissions, mustChangePassword: row.must_change_password };
}

// POST /api/admin/auth/login — { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email і пароль обов'язкові" });

    const { rows } = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email.toLowerCase()]);
    const admin = rows[0];
    if (!admin || !admin.active) return res.status(401).json({ error: 'Невірний email або пароль' });

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Невірний email або пароль' });

    res.json({ admin: publicAdmin(admin), token: signAdminToken(admin) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося увійти' });
  }
});

// GET /api/admin/auth/me
router.get('/me', requireAdminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [req.admin.id]);
  res.json({ admin: publicAdmin(rows[0]) });
});

// POST /api/admin/auth/change-password — { currentPassword, newPassword }
// Required on first login (must_change_password=true), also usable any time after.
router.post('/change-password', requireAdminAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Новий пароль має бути щонайменше 8 символів' });
    }

    const { rows } = await pool.query('SELECT password_hash FROM admin_users WHERE id = $1', [req.admin.id]);
    const valid = await bcrypt.compare(currentPassword || '', rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Поточний пароль невірний' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE admin_users SET password_hash = $1, must_change_password = false WHERE id = $2', [newHash, req.admin.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося змінити пароль' });
  }
});

module.exports = router;
