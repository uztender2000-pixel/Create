const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendSms, isConfigured: smsConfigured, normalizePhone } = require('../services/smsClient');
const { sendEmail } = require('../services/emailClient');
const { SHOP_NAME, SMS_BRAND } = require('../services/brand');
const { getCurrentRow, recordAcceptance } = require('../services/termsService');
const { validatePassword } = require('../services/passwordPolicy');
const crypto = require('crypto');
const { sessionBody, clearSession } = require('../services/security');
const { requireCaptcha } = require('../middleware/captcha');

const router = express.Router();

// tv — версія токенів користувача (users.token_version): зміна пароля чи «вийти на всіх пристроях»
// робить усі старі токени недійсними (див. middleware/auth.js). Термін дії скорочено з 30 до 14 днів.
function signToken(user, tokenVersion = user.token_version || 0) {
  return jwt.sign({ userId: user.id, email: user.email, tv: tokenVersion }, process.env.JWT_SECRET, { expiresIn: '14d' });
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000)); // 6-digit code, криптостійкий генератор
}

const MAX_CODE_ATTEMPTS = 5;   // стільки хибних кодів — і код анулюється (треба запросити новий)

function codeExpiry() {
  return new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
}

async function issuePhoneCode(userId, phone) {
  const code = generateCode();
  await pool.query('UPDATE users SET phone_code = $1, phone_code_expires = $2 WHERE id = $3', [code, codeExpiry(), userId]);
  return sendSms(phone, `${SMS_BRAND}: ваш код підтвердження телефону — ${code}`, { purpose: 'phone_code', userId });
}

// Код надіслано менше хвилини тому? (код живе 15 хв, тож значення
// phone_code_expires - 15 хв = момент відправки). Захист від спаму SMS.
function phoneCodeSentRecently(user) {
  if (!user.phone_code || !user.phone_code_expires) return false;
  const sentAt = new Date(user.phone_code_expires).getTime() - 15 * 60 * 1000;
  return Date.now() - sentAt < 60 * 1000;
}

function phoneHint(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `…${digits.slice(-4)}` : '';
}

// Перевіряє email+пароль; повертає користувача або null.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-equalisation', 10);

async function authenticate(email, password) {
  if (!email || !password) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
  const user = rows[0];
  // Хеш порівнюємо і для неіснуючого email — за часом відповіді не видно, чи зареєстровано пошту.
  const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  return user && valid ? user : null;
}

async function issueEmailCode(userId, email) {
  const code = generateCode();
  await pool.query('UPDATE users SET email_code = $1, email_code_expires = $2 WHERE id = $3', [code, codeExpiry(), userId]);
  return sendEmail(email, `Підтвердження email — ${SHOP_NAME}`, `Ваш код підтвердження email: ${code}\n\nКод дійсний 15 хвилин.`);
}

// Правила та умови тепер зберігаються в базі (terms_versions) і редагуються в адмін-кабінеті;
// при реєстрації фіксується згода з чинною на цей момент редакцією.

// POST /api/auth/register — { name, email, phone, password, acceptTerms: true }. Phone is
// required. Якщо SMS-шлюз налаштований, акаунт створюється, але токен
// видається лише після підтвердження телефону кодом із SMS
// (POST /verify-login-phone). Без налаштованого SMS — як раніше.
router.post('/register', requireCaptcha, async (req, res) => {
  try {
    const { name, email, phone, password, acceptTerms } = req.body;
    if (!name || !email || !password || !phone) {
      return res.status(400).json({ error: "Ім'я, email, телефон і пароль обов'язкові" });
    }
    if (acceptTerms !== true) {
      return res.status(400).json({ error: 'Підтвердіть, що ви ознайомились із правилами та умовами' });
    }
    const policyError = validatePassword(password, { email, name });
    if (policyError) {
      return res.status(400).json({ error: policyError });
    }

    if (smsConfigured() && !normalizePhone(phone)) {
      return res.status(400).json({ error: 'Введіть український номер телефону у форматі +380XXXXXXXXX' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Користувач з таким email вже зареєстрований' });
    }

    const currentTerms = await getCurrentRow();
    if (!currentTerms) return res.status(503).json({ error: 'Правила та умови тимчасово недоступні. Спробуйте пізніше.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, terms_accepted_at, terms_version) VALUES ($1, $2, $3, $4, now(), $5)
       RETURNING id, name, email, phone`,
      [name, email.toLowerCase(), phone, passwordHash, currentTerms.version]
    );

    const user = rows[0];
    await recordAcceptance(user.id, currentTerms, req).catch((err) => console.error('[register] журнал згоди:', err.message));

    issueEmailCode(user.id, user.email).catch((err) => console.error('[register] email code failed:', err.message));

    if (smsConfigured()) {
      // Токен не видаємо: спершу треба підтвердити номер.
      const sms = await issuePhoneCode(user.id, user.phone).catch((err) => {
        console.error('[register] phone code failed:', err.message);
        return { sent: false };
      });
      return res.status(201).json({
        needsVerification: true,
        email: user.email,
        phoneHint: phoneHint(user.phone),
        smsSent: Boolean(sms.sent),
      });
    }

    issuePhoneCode(user.id, user.phone).catch((err) => console.error('[register] phone code failed:', err.message));
    res.status(201).json(sessionBody(req, res, 'user', signToken(user), { user }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося зареєструватись' });
  }
});

// POST /api/auth/login — { email, password }. Якщо SMS налаштовано, а номер
// ще не підтверджений — токен не видається: надсилаємо код і відповідаємо
// 403 { needsVerification: true }.
router.post('/login', requireCaptcha, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email і пароль обов'язкові" });
    }

    const user = await authenticate(email, password);
    if (!user) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }

    if (smsConfigured() && !user.phone_verified) {
      let smsSent = true;
      if (!phoneCodeSentRecently(user)) {
        const sms = await issuePhoneCode(user.id, user.phone).catch((err) => {
          console.error('[login] phone code failed:', err.message);
          return { sent: false };
        });
        smsSent = Boolean(sms.sent);
      }
      return res.status(403).json({
        needsVerification: true,
        email: user.email,
        phoneHint: phoneHint(user.phone),
        smsSent,
        error: 'Підтвердіть номер телефону кодом із SMS',
      });
    }

    const publicUser = { id: user.id, name: user.name, email: user.email, phone: user.phone, phone_verified: user.phone_verified };
    res.json(sessionBody(req, res, 'user', signToken(publicUser, user.token_version), { user: publicUser }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося увійти' });
  }
});

// POST /api/auth/resend-login-phone-code — { email, password }. Повторно
// надсилає код підтвердження (не частіше ніж раз на хвилину).
router.post('/resend-login-phone-code', async (req, res) => {
  try {
    const user = await authenticate(req.body.email, req.body.password);
    if (!user) return res.status(401).json({ error: 'Невірний email або пароль' });
    if (user.phone_verified) return res.json({ ok: true, alreadyVerified: true });
    if (phoneCodeSentRecently(user)) {
      return res.status(429).json({ error: 'Код уже надіслано. Зачекайте хвилину перед повторною відправкою.' });
    }

    const sms = await issuePhoneCode(user.id, user.phone);
    if (!sms.sent) {
      return res.status(503).json({ error: 'Не вдалося надіслати SMS. Спробуйте пізніше.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося надіслати код' });
  }
});

// POST /api/auth/verify-login-phone — { email, password, code }. Підтверджує
// номер і одразу видає токен (завершує вхід або реєстрацію).
router.post('/verify-login-phone', async (req, res) => {
  try {
    const { email, password, code } = req.body;
    const user = await authenticate(email, password);
    if (!user) return res.status(401).json({ error: 'Невірний email або пароль' });

    if (!user.phone_verified) {
      const given = String(code || '').trim();
      const valid = user.phone_code && given.length === user.phone_code.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(user.phone_code)) &&
        new Date(user.phone_code_expires) >= new Date();
      if (!valid) {
        // Перебір 6-значного коду: після MAX_CODE_ATTEMPTS помилок код анулюється.
        if (user.phone_code) {
          await pool.query(
            `UPDATE users SET phone_code_attempts = phone_code_attempts + 1,
                    phone_code = CASE WHEN phone_code_attempts + 1 >= $2 THEN NULL ELSE phone_code END WHERE id = $1`,
            [user.id, MAX_CODE_ATTEMPTS]);
        }
        return res.status(400).json({ error: 'Невірний або прострочений код' });
      }
      await pool.query('UPDATE users SET phone_verified = true, phone_code = NULL, phone_code_attempts = 0 WHERE id = $1', [user.id]);
    }

    const publicUser = { id: user.id, name: user.name, email: user.email, phone: user.phone, phone_verified: true };
    res.json(sessionBody(req, res, 'user', signToken(publicUser, user.token_version), { user: publicUser }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося підтвердити телефон' });
  }
});

// GET /api/auth/me — returns the logged-in user (for restoring session on page load)
// POST /api/auth/logout — прибирає httpOnly-cookie сесії (у режимі з токеном нічого не робить).
router.post('/logout', (req, res) => {
  clearSession(res, 'user');
  res.json({ ok: true });
});

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

    const result = await issuePhoneCode(req.user.id, rows[0].phone);
    if (!result.sent) {
      return res.status(503).json({
        error: result.reason === 'not_configured'
          ? 'Надсилання SMS не налаштовано на сервері. Зверніться до адміністратора.'
          : 'Не вдалося надіслати SMS. Спробуйте пізніше.',
      });
    }
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

    const result = await issueEmailCode(req.user.id, rows[0].email);
    if (!result.sent) {
      // The code WAS generated and saved — verify-email will still work if
      // someone finds it out of band — but no email actually went out, so
      // telling the user "ok" here would just leave them staring at an
      // inbox that's never going to get anything. SMTP_HOST/SMTP_USER/
      // SMTP_PASS aren't set in this environment; see services/emailClient.js.
      return res.status(503).json({
        error: result.reason === 'not_configured'
          ? 'Надсилання листів не налаштовано на сервері. Зверніться до адміністратора.'
          : 'Не вдалося надіслати лист. Спробуйте пізніше.',
      });
    }
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
router.post('/forgot-password', requireCaptcha, async (req, res) => {
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
        `Скидання пароля — ${SHOP_NAME}`,
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
    const policyError = validatePassword(newPassword, { email });
    if (policyError) {
      return res.status(400).json({ error: policyError });
    }

    const { rows } = await pool.query(
      'SELECT id, password_reset_code, password_reset_code_expires FROM users WHERE email = $1',
      [String(email).toLowerCase()]
    );
    const user = rows[0];
    const given = String(code).trim();
    const codeOk = user && user.password_reset_code && given.length === user.password_reset_code.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(user.password_reset_code)) &&
      new Date(user.password_reset_code_expires) >= new Date();
    if (!codeOk) {
      // Перебір коду: після MAX_CODE_ATTEMPTS помилок код анулюється.
      if (user && user.password_reset_code) {
        await pool.query(
          `UPDATE users SET reset_attempts = reset_attempts + 1,
                  password_reset_code = CASE WHEN reset_attempts + 1 >= $2 THEN NULL ELSE password_reset_code END WHERE id = $1`,
          [user.id, MAX_CODE_ATTEMPTS]);
      }
      return res.status(400).json({ error: 'Невірний або прострочений код' });
    }

    // Новий пароль → усі раніше видані токени цього користувача стають недійсними.
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      `UPDATE users SET password_hash = $1, password_reset_code = NULL, password_reset_code_expires = NULL,
              reset_attempts = 0, token_version = token_version + 1 WHERE id = $2`,
      [passwordHash, user.id]
    );
    sendEmail(String(email).toLowerCase(), 'Ваш пароль змінено',
      'Пароль до вашого облікового запису щойно змінено через відновлення пароля, а всі сесії завершено.\n\nЯкщо це були не ви — зверніться до нас негайно.').catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося скинути пароль' });
  }
});

module.exports = router;
