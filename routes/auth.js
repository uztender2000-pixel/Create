const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function signToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// POST /api/auth/register — { name, email, phone, password }
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Ім'я, email і пароль обов'язкові" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль має бути щонайменше 6 символів' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Користувач з таким email вже зареєстрований' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, phone`,
      [name, email.toLowerCase(), phone || null, passwordHash]
    );

    const user = rows[0];
    res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося зареєструватись' });
  }
});

// POST /api/auth/login — { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email і пароль обов'язкові" });
    }

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }

    const publicUser = { id: user.id, name: user.name, email: user.email, phone: user.phone };
    res.json({ user: publicUser, token: signToken(publicUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося увійти' });
  }
});

// GET /api/auth/me — returns the logged-in user (for restoring session on page load)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, email, phone FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

module.exports = router;
