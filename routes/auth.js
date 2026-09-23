const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendSms } = require('../services/smsClient');
const { sendEmail } = require('../services/emailClient');

const router = express.Router();

function signToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit code
}

function codeExpiry() {
  return new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
}

async function issuePhoneCode(userId, phone) {
  const code = generateCode();
  await pool.query('UPDATE users SET phone_code = $1, phone_code_expires = $2 WHERE id = $3', [code, codeExpiry(), userId]);
  await sendSms(phone, `OllShop: ваш код підтвердження телефону — ${code}`);
}

async function issueEmailCode(userId, email) {
  const code = generateCode();
  await pool.query('UPDATE users SET email_code = $1, email_code_expires = $2 WHERE id = $3', [code, codeExpiry(), userId]);
  await sendEmail(email, 'Підтвердження email — OllShop', `Ваш код підтвердження email: ${code}\n\nКод дійсний 15 хвилин.`);
}

// POST /api/auth/register — { name, email, phone, password }. Phone is
// required. Sends verification codes for both phone and email right after
// signup — verifying them is optional and happens later from the account
// page, it does not block registration or login.
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password || !phone) {
      return res.status(400).json({ error: "Ім'я, email, телефон і пароль обов'язкові" });
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
      [name, email.toLowerCase(), phone, passwordHash]
    );

    const user = rows[0];

    // Fire-and-forget: don't let a slow/failed SMS or email delay or break
    // registration itself.
    issuePhoneCode(user.id, user.phone).catch((err) => console.error('[register] phone code failed:', err.message));
    issueEmailCode(user.id, user.email).catch((err) => console.error('[register] email code failed:', err.message));

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
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, phone_verified, email_verified,
              saved_delivery_method, saved_city, saved_city_ref, saved_branch, saved_courier_address
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// POST /api/auth/send-phone-code — (re)send the SMS verification code
router.post('/send-phone-code', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT phone, phone_verified FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].phone_verified) return res.json({ ok: true, alreadyVerified: true });

    await issuePhoneCode(req.user.id, rows[0].phone);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося надіслати код' });
  }
});

// POST /api/auth/verify-phone — { code }
router.post('/verify-phone', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const { rows } = await pool.query('SELECT phone_code, phone_code_expires FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const record = rows[0];
    if (!record.phone_code || record.phone_code !== code || new Date(record.phone_code_expires) < new Date()) {
      return res.status(400).json({ error: 'Невірний або прострочений код' });
    }

    await pool.query('UPDATE users SET phone_verified = true, phone_code = NULL WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося підтвердити телефон' });
  }
});

// POST /api/auth/send-email-code — (re)send the email verification code
router.post('/send-email-code', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT email, email_verified FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].email_verified) return res.json({ ok: true, alreadyVerified: true });

    await issueEmailCode(req.user.id, rows[0].email);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося надіслати код' });
  }
});

// POST /api/auth/verify-email — { code }
router.post('/verify-email', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const { rows } = await pool.query('SELECT email_code, email_code_expires FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const record = rows[0];
    if (!record.email_code || record.email_code !== code || new Date(record.email_code_expires) < new Date()) {
      return res.status(400).json({ error: 'Невірний або прострочений код' });
    }

    await pool.query('UPDATE users SET email_verified = true, email_code = NULL WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося підтвердити email' });
  }
});

// POST /api/auth/forgot-password — { email }. Always responds ok:true
// (even if the email isn't registered) so a caller can't use this to
// check which emails exist in the database. If the email IS registered,
// a 6-digit code is emailed — same code/expiry mechanism as the email
// verification codes above, just stored in its own column so a pending
// "verify my email" code and a pending "reset my password" code never
// clash with each other.
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email обов\'язковий' });

    const { rows } = await pool.query('SELECT id, email FROM users WHERE email = $1', [email.toLowerCase()]);
    if (rows.length) {
      const user = rows[0];
      const code = generateCode();
      await pool.query(
        'UPDATE users SET password_reset_code = $1, password_reset_code_expires = $2 WHERE id = $3',
        [code, codeExpiry(), user.id]
      );
      sendEmail(
        user.email,
        'Скидання пароля — OllShop',
        `Ваш код для скидання пароля: ${code}\n\nКод дійсний 15 хвилин. Якщо ви не запитували скидання пароля, просто проігноруйте цей лист.`
      ).catch((err) => console.error('[forgot-password] email failed:', err.message));
    }

    // Same response whether or not the email exists.
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося надіслати код' });
  }
});

// POST /api/auth/reset-password — { email, code, newPassword }
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: "Email, код і новий пароль обов'язкові" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Пароль має бути щонайменше 6 символів' });
    }

    const { rows } = await pool.query(
      'SELECT id, password_reset_code, password_reset_code_expires FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    const user = rows[0];
    if (!user || !user.password_reset_code || user.password_reset_code !== code ||
        new Date(user.password_reset_code_expires) < new Date()) {
      return res.status(400).json({ error: 'Невірний або прострочений код' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, password_reset_code = NULL, password_reset_code_expires = NULL WHERE id = $2',
      [passwordHash, user.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося скинути пароль' });
  }
});

module.exports = router;
