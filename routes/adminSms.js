const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');
const { getBalance, getStatuses, isConfigured } = require('../services/smsClient');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('settings'));

// Статуси, після яких доставка вже не зміниться — їх повторно не опитуємо.
const FINAL_STATUSES = ['DELIVERED', 'EXPIRED', 'FILTERED', 'INVALID DESTINATION ADDRESS', 'INVALID SOURCE ADDRESS',
  'NO ROUTE', 'REJECTED', 'UNDELIVERABLE', 'DELETED', 'NOT_SENT'];

// Баланс кешуємо на 20 с, щоб не смикати шлюз при кожному оновленні сторінки.
let balanceCache = null;
async function cachedBalance(force) {
  if (!force && balanceCache && Date.now() - balanceCache.at < 20 * 1000) return balanceCache.value;
  const value = await getBalance();
  balanceCache = { at: Date.now(), value };
  return value;
}

// GET /api/admin/sms/balance — лише залишок (для дашборда; без важких запитів до бази).
router.get('/balance', async (req, res) => {
  if (!isConfigured()) return res.json({ configured: false });
  try {
    res.json({ configured: true, balance: await cachedBalance(false) });
  } catch (err) {
    res.json({ configured: true, error: err.message });
  }
});

// GET /api/admin/sms/summary — залишок на рахунку + підсумки за 24 год / 7 / 30 днів.
router.get('/summary', async (req, res) => {
  try {
    let balance = null;
    let balanceError = null;
    if (!isConfigured()) {
      balanceError = 'SMS не налаштовано (SMS_API_KEY / SMS_SENDER)';
    } else {
      try { balance = await cachedBalance(req.query.refresh === '1'); }
      catch (err) { balanceError = err.message; }
    }

    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int                         AS total_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND sent)::int                AS sent_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int                           AS total_7d,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days' AND sent)::int                  AS sent_7d,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int                          AS total_30d,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND sent)::int                 AS sent_30d,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND NOT sent)::int             AS failed_30d,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND delivery_status = 'DELIVERED')::int AS delivered_30d,
        COALESCE(SUM(price * COALESCE(parts, 1)) FILTER (WHERE created_at >= now() - interval '30 days' AND sent), 0)::float AS cost_30d,
        COALESCE(SUM(price * COALESCE(parts, 1)) FILTER (WHERE created_at >= now() - interval '7 days' AND sent), 0)::float  AS cost_7d,
        COUNT(*) FILTER (WHERE sent AND price IS NULL AND created_at >= now() - interval '30 days')::int AS without_price_30d
      FROM sms_log
    `);
    res.json({ balance, balanceError, stats: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити підсумки SMS' });
  }
});

// GET /api/admin/sms — журнал, новіші зверху.
// ?status=failed|delivered|pending  ?q=частина номера  ?limit=100&offset=0
router.get('/', async (req, res) => {
  try {
    const { status, q } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const conditions = [];
    const params = [];

    if (status === 'failed') conditions.push('l.sent = false');
    else if (status === 'delivered') conditions.push("l.delivery_status = 'DELIVERED'");
    else if (status === 'pending') conditions.push("l.sent = true AND l.delivery_status IN ('ACCEPTED','QUEUED','ROUTING')");
    if (q && q.trim()) {
      params.push(`%${q.replace(/\D/g, '') || q.trim()}%`);
      conditions.push(`l.phone ILIKE $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM sms_log l ${where}`, params);
    const listParams = [...params, limit, offset];
    const { rows } = await pool.query(
      `SELECT l.id, l.created_at, l.purpose, l.phone, l.text, l.sent, l.error, l.parts, l.gateway_id,
              l.price::float AS price, l.currency, l.delivery_status, l.status_updated,
              CASE WHEN l.price IS NULL THEN NULL ELSE (l.price * COALESCE(l.parts, 1))::float END AS cost,
              u.name AS user_name, u.email AS user_email
         FROM sms_log l
         LEFT JOIN users u ON u.id = l.user_id
         ${where}
        ORDER BY l.created_at DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    res.json({ total: count.rows[0].n, items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити журнал SMS' });
  }
});

// POST /api/admin/sms/refresh-statuses — запитує у шлюзу актуальні статуси доставки
// для відправлених за останні 3 доби повідомлень, статус яких ще може змінитись.
router.post('/refresh-statuses', async (req, res) => {
  try {
    if (!isConfigured()) return res.status(400).json({ error: 'SMS не налаштовано' });
    const { rows } = await pool.query(
      `SELECT id, client_id FROM sms_log
        WHERE sent = true AND client_id IS NOT NULL
          AND created_at >= now() - interval '3 days'
          AND (delivery_status IS NULL OR delivery_status <> ALL($1::text[]))
        ORDER BY created_at DESC
        LIMIT 100`,
      [FINAL_STATUSES]
    );
    if (!rows.length) return res.json({ checked: 0, updated: 0 });

    const statuses = await getStatuses(rows.map((r) => r.client_id));
    let updated = 0;
    for (const r of rows) {
      const st = statuses.get(String(r.client_id));
      if (!st || !st.status) continue;
      await pool.query(
        'UPDATE sms_log SET delivery_status = $1, status_updated = COALESCE($2::timestamptz, now()) WHERE id = $3',
        [st.status, st.updated || null, r.id]
      );
      updated += 1;
    }
    res.json({ checked: rows.length, updated });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Шлюз не відповів: ${err.message}` });
  }
});

module.exports = router;
