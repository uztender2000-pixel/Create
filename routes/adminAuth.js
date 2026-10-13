const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { pool } = require('../db');
const { requireAdminAuthBasic, mfaRequiredFor } = require('../middleware/adminAuth');
const { validatePassword } = require('../services/passwordPolicy');
const totp = require('../services/totp');
const { SHOP_NAME } = require('../services/brand');
const crypto = require('crypto');
const { sendAlert } = require('../services/alerts');
const { sendEmail } = require('../services/emailClient');
const { sessionBody, clearSession } = require('../services/security');

const router = express.Router();

const MAX_FAILS = 5;       // стільки невдалих спроб підряд — і акаунт блокується
const LOCK_MINUTES = 15;
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-equalisation', 10);

// Окремий ліміт саме на вхід в адмінку (додатково до загального ліміту на /api).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Забагато спроб входу. Спробуйте за кілька хвилин.' },
});

function signAdminToken(admin) {
  return jwt.sign({ adminId: admin.id, tv: admin.token_version || 0 }, process.env.ADMIN_JWT_SECRET, { expiresIn: '12h' });
}

// Проміжний токен між «пароль вірний» і «введено код 2FA»: живе 5 хвилин і НЕ дає доступу до API.
function signMfaToken(admin) {
  return jwt.sign({ adminId: admin.id, purpose: 'mfa' }, process.env.ADMIN_JWT_SECRET, { expiresIn: '5m' });
}

function publicAdmin(row) {
  return {
    id: row.id, name: row.name, email: row.email, role: row.role, permissions: row.permissions,
    mustChangePassword: row.must_change_password,
    mfaEnabled: Boolean(row.mfa_enabled),
    mfaRequired: mfaRequiredFor(row),
    mfaSetupRequired: mfaRequiredFor(row) && !row.mfa_enabled,
  };
}

function lockedResponse(res, until) {
  const t = new Date(until).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
  return res.status(423).json({ error: `Забагато невдалих спроб. Вхід заблоковано до ${t}.`, lockedUntil: until });
}

// Коротко про браузер/систему з User-Agent — для листів і списку пристроїв.
function describeAgent(ua) {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Невідомий браузер';
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad|iOS/.test(s) ? 'iOS' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

// Після 5 невдалих спроб акаунт блокується — про це одразу повідомляємо і власника акаунта, і канали сповіщень.
async function registerFailure(adminId, req) {
  const { rows } = await pool.query(
    `UPDATE admin_users SET
        locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
        failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
      WHERE id = $1
      RETURNING email, failed_logins, locked_until`,
    [adminId, MAX_FAILS, LOCK_MINUTES]
  );
  const a = rows[0];
  if (a && a.failed_logins === 0 && a.locked_until && new Date(a.locked_until) > new Date()) {
    const text = `Обліковий запис ${a.email} заблоковано на ${LOCK_MINUTES} хв після ${MAX_FAILS} невдалих спроб входу.\nIP: ${req && req.ip}\nБраузер: ${describeAgent(req && req.headers['user-agent'])}\n\nЯкщо це були не ви — хтось підбирає пароль. Перевірте «Журнал дій» й за потреби змініть пароль.`;
    sendAlert({ title: 'Блокування акаунта адміністратора', text, dedupeKey: `lock-${adminId}`, dedupeMinutes: LOCK_MINUTES });
  }
}

// Запам'ятовує пристрій (за User-Agent). Повертає true, якщо це НОВИЙ пристрій для акаунта, який уже мав
// відомі пристрої (найперший вхід після оновлення нікого не лякає).
async function touchDevice(admin, req) {
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const fp = crypto.createHash('sha256').update(ua).digest('hex');
  const ip = String(req.ip || '').slice(0, 100);
  const known = await pool.query('SELECT COUNT(*)::int AS n FROM admin_devices WHERE admin_id = $1', [admin.id]);
  const up = await pool.query(
    `INSERT INTO admin_devices (admin_id, fingerprint, user_agent, first_ip, last_ip) VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (admin_id, fingerprint) DO UPDATE SET last_seen = now(), last_ip = EXCLUDED.last_ip
     RETURNING (xmax = 0) AS inserted`, [admin.id, fp, ua, ip]);
  return up.rows[0].inserted && known.rows[0].n > 0;
}

async function completeLogin(req, res, admin) {
  await pool.query('UPDATE admin_users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [admin.id]);
  try {
    if (await touchDevice(admin, req)) {
      const when = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
      const text = `У ваш обліковий запис адмінки ${admin.email} щойно увійшли з НОВОГО пристрою.\n\nЧас: ${when}\nIP: ${req.ip}\nБраузер: ${describeAgent(req.headers['user-agent'])}\n\nЯкщо це були ви — нічого робити не потрібно. Якщо ні — негайно змініть пароль і натисніть «Вийти на всіх інших пристроях» у розділі «Безпека».`;
      sendEmail(admin.email, 'Новий вхід в адмінку', text).catch(() => {});
      sendAlert({ title: `Вхід з нового пристрою: ${admin.email}`, text, email: false });
    }
  } catch (e) { console.error('[admin] перевірка пристрою:', e.message); }
  res.json(sessionBody(req, res, 'admin', signAdminToken(admin), { admin: publicAdmin(admin) }));
}

// POST /api/admin/auth/login — { email, password }
// Якщо в акаунта увімкнена 2FA — відповідає { mfaRequired: true, mfaToken }, а сесію видає
// лише POST /login/mfa після коду.
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: "Email і пароль обов'язкові" });
    }

    const { rows } = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email.toLowerCase()]);
    const admin = rows[0];
    // Порівнюємо хеш і для неіснуючого email, щоб за часом відповіді не можна було вгадати, чи є акаунт.
    const valid = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_HASH);
    if (!admin || !admin.active) return res.status(401).json({ error: 'Невірний email або пароль' });

    if (admin.locked_until && new Date(admin.locked_until) > new Date()) return lockedResponse(res, admin.locked_until);
    if (!valid) {
      await registerFailure(admin.id, req);
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }

    if (admin.mfa_enabled) return res.json({ mfaRequired: true, mfaToken: signMfaToken(admin) });
    await completeLogin(req, res, admin);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося увійти' });
  }
});

// POST /api/admin/auth/login/mfa — { mfaToken, code }. code — 6 цифр із застосунку або резервний код.
router.post('/login/mfa', loginLimiter, async (req, res) => {
  try {
    const { mfaToken, code } = req.body;
    let payload;
    try { payload = jwt.verify(String(mfaToken || ''), process.env.ADMIN_JWT_SECRET); } catch (e) { payload = null; }
    if (!payload || payload.purpose !== 'mfa') return res.status(401).json({ error: 'Сесію входу завершено. Введіть пароль ще раз.', restart: true });

    const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [payload.adminId]);
    const admin = rows[0];
    if (!admin || !admin.active || !admin.mfa_enabled || !admin.mfa_secret) return res.status(401).json({ error: 'Вхід неможливий', restart: true });
    if (admin.locked_until && new Date(admin.locked_until) > new Date()) return lockedResponse(res, admin.locked_until);

    const input = String(code || '').trim();
    let ok = false;
    if (/^\d{3}\s?\d{3}$/.test(input)) {
      const step = totp.verifyTotp(totp.decryptSecret(admin.mfa_secret), input, admin.mfa_last_step);
      if (step !== null) {
        // Атомарно: один код можна використати лише раз (захист від повторного використання).
        const upd = await pool.query(
          'UPDATE admin_users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)', [admin.id, step]
        );
        ok = upd.rowCount === 1;
      }
    } else if (input) {
      const left = totp.consumeBackupCode(admin.mfa_backup_codes, input);
      if (left) {
        const upd = await pool.query(
          'UPDATE admin_users SET mfa_backup_codes = $2::jsonb WHERE id = $1 AND mfa_backup_codes = $3::jsonb',
          [admin.id, JSON.stringify(left), JSON.stringify(admin.mfa_backup_codes)]
        );
        ok = upd.rowCount === 1;
      }
    }
    if (!ok) {
      await registerFailure(admin.id, req);
      return res.status(401).json({ error: 'Невірний код' });
    }
    await completeLogin(req, res, admin);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося підтвердити код' });
  }
});

// Далі — доступно і акаунту, який ще мусить налаштувати 2FA (requireAdminAuthBasic).

// POST /api/admin/auth/logout — прибирає httpOnly-cookie сесії.
router.post('/logout', (req, res) => {
  clearSession(res, 'admin');
  res.json({ ok: true });
});

// GET /api/admin/auth/me
router.get('/me', requireAdminAuthBasic, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [req.admin.id]);
  res.json({ admin: publicAdmin(rows[0]) });
});

// POST /api/admin/auth/change-password — { currentPassword, newPassword }
// Required on first login (must_change_password=true), also usable any time after.
// Усі інші сесії цього адміна завершуються; у відповіді — свіжий токен для поточної.
router.post('/change-password', requireAdminAuthBasic, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [req.admin.id]);
    const admin = rows[0];

    const policyError = validatePassword(newPassword, { email: admin.email, name: admin.name, isAdmin: true });
    if (policyError) return res.status(400).json({ error: policyError });

    const valid = await bcrypt.compare(currentPassword || '', admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Поточний пароль невірний' });
    if (await bcrypt.compare(newPassword, admin.password_hash)) return res.status(400).json({ error: 'Новий пароль має відрізнятися від поточного' });

    const newHash = await bcrypt.hash(newPassword, 12);
    const upd = await pool.query(
      'UPDATE admin_users SET password_hash = $1, must_change_password = false, token_version = token_version + 1 WHERE id = $2 RETURNING *',
      [newHash, req.admin.id]
    );
    res.json(sessionBody(req, res, 'admin', signAdminToken(upd.rows[0]), { ok: true }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося змінити пароль' });
  }
});

// GET /api/admin/auth/devices — пристрої, з яких заходили в ваш обліковий запис.
router.get('/devices', requireAdminAuthBasic, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT user_agent, first_ip, last_ip, first_seen, last_seen FROM admin_devices WHERE admin_id = $1 ORDER BY last_seen DESC LIMIT 20', [req.admin.id]);
  res.json({ devices: rows.map((r) => ({ ...r, label: describeAgent(r.user_agent) })) });
});

// POST /api/admin/auth/logout-all — завершує ВСІ сесії цього адміна, крім поточної.
router.post('/logout-all', requireAdminAuthBasic, async (req, res) => {
  const upd = await pool.query('UPDATE admin_users SET token_version = token_version + 1 WHERE id = $1 RETURNING *', [req.admin.id]);
  res.json(sessionBody(req, res, 'admin', signAdminToken(upd.rows[0]), { ok: true }));
});

// ---------- Двофакторна автентифікація ----------

async function passwordOk(adminId, password) {
  const { rows } = await pool.query('SELECT password_hash FROM admin_users WHERE id = $1', [adminId]);
  return Boolean(rows[0]) && bcrypt.compare(String(password || ''), rows[0].password_hash);
}

// GET /api/admin/auth/mfa/status
router.get('/mfa/status', requireAdminAuthBasic, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [req.admin.id]);
  const a = rows[0];
  res.json({ enabled: a.mfa_enabled, required: mfaRequiredFor(a), backupCodesLeft: Array.isArray(a.mfa_backup_codes) ? a.mfa_backup_codes.length : 0 });
});

// POST /api/admin/auth/mfa/setup — { password }. Генерує секрет (поки НЕ активний) і QR-код.
router.post('/mfa/setup', requireAdminAuthBasic, loginLimiter, async (req, res) => {
  try {
    if (!(await passwordOk(req.admin.id, req.body.password))) return res.status(401).json({ error: 'Невірний пароль' });
    const { rows } = await pool.query('SELECT email, mfa_enabled FROM admin_users WHERE id = $1', [req.admin.id]);
    if (rows[0].mfa_enabled) return res.status(400).json({ error: 'Двофакторну автентифікацію вже увімкнено' });

    const secret = totp.generateSecret();
    await pool.query('UPDATE admin_users SET mfa_secret = $2 WHERE id = $1', [req.admin.id, totp.encryptSecret(secret)]);
    const url = totp.otpauthUrl(secret, rows[0].email, SHOP_NAME || 'Shop');
    res.json({ secret, otpauthUrl: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося підготувати 2FA' });
  }
});

// POST /api/admin/auth/mfa/enable — { code }. Підтверджує, що застосунок налаштовано, і вмикає 2FA.
// Повертає 8 резервних кодів (показуються ОДИН раз).
router.post('/mfa/enable', requireAdminAuthBasic, loginLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT mfa_secret, mfa_enabled FROM admin_users WHERE id = $1', [req.admin.id]);
    const a = rows[0];
    if (a.mfa_enabled) return res.status(400).json({ error: 'Двофакторну автентифікацію вже увімкнено' });
    if (!a.mfa_secret) return res.status(400).json({ error: 'Спершу згенеруйте QR-код' });

    const step = totp.verifyTotp(totp.decryptSecret(a.mfa_secret), req.body.code);
    if (step === null) return res.status(400).json({ error: 'Невірний код. Перевірте час на телефоні й спробуйте ще раз' });

    const backup = totp.generateBackupCodes(8);
    await pool.query(
      'UPDATE admin_users SET mfa_enabled = true, mfa_last_step = $2, mfa_backup_codes = $3::jsonb WHERE id = $1',
      [req.admin.id, step, JSON.stringify(backup.hashes)]
    );
    res.json({ ok: true, backupCodes: backup.plain });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося увімкнути 2FA' });
  }
});

// POST /api/admin/auth/mfa/disable — { password, code }. Недоступно, якщо 2FA обов'язкова для ролі.
router.post('/mfa/disable', requireAdminAuthBasic, loginLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [req.admin.id]);
    const a = rows[0];
    if (mfaRequiredFor(a)) return res.status(403).json({ error: 'Для вашої ролі двофакторна автентифікація обов\'язкова' });
    if (!a.mfa_enabled) return res.status(400).json({ error: '2FA не увімкнена' });
    if (!(await passwordOk(a.id, req.body.password))) return res.status(401).json({ error: 'Невірний пароль' });
    if (totp.verifyTotp(totp.decryptSecret(a.mfa_secret), req.body.code, a.mfa_last_step) === null) return res.status(401).json({ error: 'Невірний код' });

    await pool.query(
      `UPDATE admin_users SET mfa_enabled = false, mfa_secret = NULL, mfa_backup_codes = '[]'::jsonb, mfa_last_step = NULL,
              token_version = token_version + 1 WHERE id = $1`, [a.id]);
    res.json({ ok: true, relogin: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося вимкнути 2FA' });
  }
});

module.exports = router;
