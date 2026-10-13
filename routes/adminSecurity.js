const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAdminRole } = require('../middleware/adminRole');
const { channels } = require('../services/alerts');
const { allowedOrigins, cookieSessionsEnabled } = require('../services/security');

const router = express.Router();
router.use(requireAdminAuth, requireAdminRole);

const ok = (id, title, detail) => ({ id, title, status: 'ok', detail });
const warn = (id, title, detail) => ({ id, title, status: 'warn', detail });
const bad = (id, title, detail) => ({ id, title, status: 'bad', detail });
const ageHours = (iso) => (Date.now() - new Date(iso).getTime()) / 3600000;

// GET /api/admin/security/status — самоперевірка конфігурації безпеки: що налаштовано, а що ні.
router.get('/status', async (req, res) => {
  try {
    const checks = [];
    const jwt = process.env.JWT_SECRET || '';
    const ajwt = process.env.ADMIN_JWT_SECRET || '';

    checks.push(allowedOrigins.length
      ? ok('cors', 'CORS: адреса фронтенду задана', allowedOrigins.join(', '))
      : bad('cors', 'CORS відкритий для будь-якого сайту', 'Задайте змінну FRONTEND_ORIGIN (адреса вашого фронтенду).'));
    checks.push(jwt.length >= 32 && ajwt.length >= 32 && jwt !== ajwt
      ? ok('secrets', 'JWT-секрети довгі й різні', 'JWT_SECRET і ADMIN_JWT_SECRET ≥ 32 символів і не збігаються.')
      : bad('secrets', 'Слабкі або однакові JWT-секрети', 'Обидва мають бути випадковими рядками від 32 символів і відрізнятись одне від одного.'));
    checks.push(process.env.NODE_ENV === 'production'
      ? ok('env', 'NODE_ENV=production', 'Режим продакшену (HTTPS-налаштування БД, без зайвих деталей помилок).')
      : warn('env', 'NODE_ENV не production', 'Рекомендовано NODE_ENV=production на Render.'));

    const noMfa = await pool.query(`SELECT COUNT(*)::int AS n FROM admin_users WHERE active AND NOT mfa_enabled`);
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM admin_users WHERE active`);
    checks.push(noMfa.rows[0].n === 0
      ? ok('mfa', '2FA увімкнена в усіх адмінів', `Активних облікових записів: ${total.rows[0].n}.`)
      : warn('mfa', `2FA немає у ${noMfa.rows[0].n} з ${total.rows[0].n} адмінів`, 'Для ролі «Адміністратор» вона обов\'язкова, для працівників — за ADMIN_REQUIRE_MFA=all.'));

    const stale = await pool.query(
      `SELECT COUNT(*)::int AS n FROM admin_users WHERE active AND must_change_password AND created_at < now() - interval '3 days'`);
    if (stale.rows[0].n) checks.push(warn('temp_pw', 'Тимчасові паролі не змінено', `Облікових записів із непоміняним тимчасовим паролем понад 3 дні: ${stale.rows[0].n}.`));

    checks.push(cookieSessionsEnabled()
      ? ok('cookies', 'Cookie-сесії увімкнено', 'Токен у httpOnly-cookie там, де браузер це підтримує.')
      : warn('cookies', 'Cookie-сесії вимкнено', 'Токен лишається в localStorage. Увімкніть COOKIE_SESSIONS=true (див. інструкцію).'));
    checks.push(process.env.TURNSTILE_SECRET
      ? ok('captcha', 'Капча увімкнена', 'Реєстрація, вхід і відновлення пароля захищені Turnstile.')
      : warn('captcha', 'Капча вимкнена', 'Задайте TURNSTILE_SECRET і TURNSTILE_SITE_KEY, щоб відсікти ботів.'));

    if (String(process.env.SQL_CONSOLE || '').toLowerCase() === 'off') checks.push(ok('sql', 'SQL-консоль вимкнена', 'SQL_CONSOLE=off.'));
    else checks.push(process.env.DATABASE_URL_READONLY
      ? ok('sql', 'SQL-читання через окрему роль БД', 'DATABASE_URL_READONLY задано.')
      : warn('sql', 'SQL-консоль без окремої ролі для читання', 'Задайте DATABASE_URL_READONLY або вимкніть консоль (SQL_CONSOLE=off).'));

    const ch = channels();
    const any = ch.telegram || ch.webhook;
    checks.push(any
      ? ok('alerts', 'Сповіщення власнику налаштовані', [ch.telegram && 'Telegram', ch.webhook && 'webhook', ch.email && 'e-mail'].filter(Boolean).join(', '))
      : warn('alerts', 'Швидкі сповіщення не налаштовані', 'Додайте TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (або ALERT_WEBHOOK_URL), щоб миттєво дізнаватись про збої й підозрілі входи.'));

    const b = await pool.query(`SELECT value FROM site_settings WHERE key = 'last_backup'`);
    if (!process.env.BACKUP_HEARTBEAT_TOKEN) {
      checks.push(warn('backup', 'Контроль резервних копій не підключено', 'Налаштуйте GitHub Actions backup і змінну BACKUP_HEARTBEAT_TOKEN (див. інструкцію).'));
    } else if (!b.rows.length) {
      checks.push(bad('backup', 'Резервна копія ще жодного разу не створювалась', 'Запустіть workflow «Backup database» у GitHub Actions.'));
    } else {
      const v = b.rows[0].value; const h = ageHours(v.at);
      checks.push(!v.ok || h > 36
        ? bad('backup', !v.ok ? 'Остання резервна копія — з помилкою' : `Остання резервна копія ${Math.round(h)} год тому`, v.details || 'Перевірте GitHub Actions.')
        : ok('backup', `Резервна копія ${h < 1 ? 'щойно' : Math.round(h) + ' год тому'}`, v.size_bytes ? `Розмір: ${(v.size_bytes / 1048576).toFixed(1)} МБ.` : ''));
      const r = await pool.query(`SELECT value FROM site_settings WHERE key = 'last_restore_test'`);
      if (!r.rows.length) checks.push(warn('restore', 'Відновлення з копії ще не перевірялось', 'Запустіть workflow «Test restore»: копія без перевірки відновлення — не гарантія.'));
      else {
        const rv = r.rows[0].value; const rh = ageHours(rv.at);
        checks.push(!rv.ok ? bad('restore', 'Тест відновлення провалився', rv.details || '')
          : rh > 24 * 40 ? warn('restore', `Відновлення перевірялось ${Math.round(rh / 24)} діб тому`, 'Рекомендовано щомісяця.')
          : ok('restore', 'Відновлення з копії перевірено', `${Math.round(rh / 24)} діб тому.`));
      }
    }

    const errs = await pool.query(`SELECT COUNT(*)::int AS n FROM error_log WHERE NOT resolved AND last_seen > now() - interval '24 hours'`);
    checks.push(errs.rows[0].n === 0
      ? ok('errors', 'Помилок сервера за добу немає', '')
      : warn('errors', `Помилок сервера за добу: ${errs.rows[0].n}`, 'Дивіться «Помилки сервера».'));

    const fails = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 401)::int AS failed, COUNT(*) FILTER (WHERE status = 423)::int AS locked
         FROM admin_audit_log WHERE path LIKE '/api/admin/auth/login%' AND created_at > now() - interval '24 hours'`);
    const f = fails.rows[0];
    checks.push(f.failed + f.locked > 10
      ? warn('logins', `Багато невдалих входів в адмінку за добу: ${f.failed}`, `Блокувань: ${f.locked}. Перегляньте «Журнал дій» → «лише входи».`)
      : ok('logins', 'Невдалих входів в адмінку за добу', `${f.failed}, блокувань: ${f.locked}.`));

    res.json({
      checks,
      summary: { ok: checks.filter((c) => c.status === 'ok').length, warn: checks.filter((c) => c.status === 'warn').length, bad: checks.filter((c) => c.status === 'bad').length },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося виконати перевірку' });
  }
});

module.exports = router;
