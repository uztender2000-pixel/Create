const crypto = require('crypto');
const { pool } = require('../db');
const { sendAlert, channels } = require('./alerts');

// ---------------------------------------------------------------------------
// Моніторинг помилок без сторонніх сервісів. Усі необроблені винятки та відповіді 5xx
// зводяться в таблицю error_log (однакові помилки — один рядок із лічильником), нова помилка
// одразу надсилається власнику (див. services/alerts.js), повторні — не частіше разу на годину.
// Тіла запитів, токени й паролі не зберігаються — лише метод, шлях і стек.
// ---------------------------------------------------------------------------

const ALERT_EVERY_MINUTES = 60;

// /api/products/123 → /api/products/:id (щоб помилки одного маршруту групувались)
function normalizePath(p) {
  return String(p || '').split('?')[0]
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/:uuid')
    .slice(0, 200);
}

function fingerprintOf(kind, message, where) {
  return crypto.createHash('sha1').update(`${kind}|${message}|${where}`).digest('hex');
}

async function record({ kind, message, stack = null, method = null, path = null }) {
  try {
    const msg = String(message || 'Unknown error').slice(0, 500);
    const where = stack ? String(stack).split('\n').slice(1, 2).join('').trim() : `${method} ${path}`;
    const fp = fingerprintOf(kind, msg, where);
    const { rows } = await pool.query(
      `INSERT INTO error_log (fingerprint, kind, message, stack, method, path)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (fingerprint) DO UPDATE
         SET count = error_log.count + 1, last_seen = now(), resolved = false
       RETURNING id, count, last_alerted_at`,
      [fp, kind, msg, stack ? String(stack).slice(0, 4000) : null, method, path]
    );
    const row = rows[0];
    const due = !row.last_alerted_at || Date.now() - new Date(row.last_alerted_at).getTime() > ALERT_EVERY_MINUTES * 60 * 1000;
    if (due) {
      await pool.query('UPDATE error_log SET last_alerted_at = now() WHERE id = $1', [row.id]);
      const ch = channels();
      sendAlert({
        title: kind === 'http5xx' ? 'Помилка сервера (5xx)' : 'Помилка в коді сервера',
        text: `${msg}\n${method ? `${method} ${path}\n` : ''}Повторів: ${row.count}\n\nДеталі: адмінка → Налаштування → «Помилки сервера».`,
        email: !ch.telegram && !ch.webhook,   // на пошту — лише якщо немає швидшого каналу (Telegram/webhook)
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[errorReporter] не вдалося записати помилку:', err.message);   // сама система помилок не має падати
  }
}

function captureException(err, ctx = {}) {
  return record({
    kind: ctx.kind || 'exception',
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack,
    method: ctx.method || null,
    path: ctx.path ? normalizePath(ctx.path) : null,
  });
}

// Фіксує КОЖНУ відповідь 5xx, навіть якщо маршрут сам її обробив у try/catch і лише написав console.error.
function trackServerErrors(req, res, next) {
  res.on('finish', () => {
    if (res.statusCode >= 500 && !res.locals.errorCaptured) {
      record({ kind: 'http5xx', message: `HTTP ${res.statusCode}`, method: req.method, path: normalizePath(req.originalUrl) });
    }
  });
  next();
}

// Фінальний обробник Express: ніколи не віддає клієнту стек чи внутрішні деталі.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err && (err.status || err.statusCode);
  if (status && status >= 400 && status < 500) {   // некоректний JSON, завеликий запит тощо — не наша помилка
    return res.status(status).json({ error: status === 413 ? 'Запит занадто великий' : 'Некоректний запит' });
  }
  res.locals.errorCaptured = true;
  captureException(err, { method: req.method, path: req.originalUrl });
  console.error('[error]', req.method, req.originalUrl, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
}

function notFoundApi(req, res) {
  res.status(404).json({ error: 'Не знайдено' });
}

function installProcessHandlers() {
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    captureException(reason instanceof Error ? reason : new Error(String(reason)), { kind: 'unhandled' });
  });
  process.on('uncaughtException', async (err) => {
    console.error('[uncaughtException]', err);
    await captureException(err, { kind: 'unhandled' });
    setTimeout(() => process.exit(1), 800);   // Render перезапустить сервіс
  });
}

async function purgeResolvedErrors(days = 90) {
  await pool.query(`DELETE FROM error_log WHERE resolved AND last_seen < now() - make_interval(days => $1)`, [days]);
}

module.exports = { captureException, trackServerErrors, errorHandler, notFoundApi, installProcessHandlers, purgeResolvedErrors, normalizePath };
