const jwt = require('jsonwebtoken');
const { pool } = require('../db');

// Журнал дій в адмінці: хто, коли, що змінив і з яким результатом. Пишуться всі запити, що
// змінюють дані (POST/PUT/PATCH/DELETE), а також усі спроби входу. Паролі, коди й токени
// у журнал не потрапляють. Помилка запису в журнал ніколи не ламає сам запит.
const SENSITIVE = /pass|token|code|secret|otp|key/i;
const SKIP_BODY = /^\/sql/;   // тексти SQL-запитів уже пишуться окремим журналом SQL

function sanitize(value, depth = 0) {
  if (value == null || depth > 3) return value == null ? value : '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = SENSITIVE.test(k) ? '[приховано]' : sanitize(v, depth + 1);
    return out;
  }
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  return value;
}

function auditLog(req, res, next) {
  const isLogin = /^\/auth\/login/.test(req.path);
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!mutating && !isLogin) return next();

  res.on('finish', async () => {
    try {
      let adminId = null;
      let email = null;
      const h = req.headers.authorization || '';
      if (h.startsWith('Bearer ')) {
        try { adminId = jwt.verify(h.slice(7), process.env.ADMIN_JWT_SECRET).adminId || null; } catch (e) { /* без сесії */ }
      }
      if (adminId) {
        const r = await pool.query('SELECT email FROM admin_users WHERE id = $1', [adminId]);
        email = r.rows[0] ? r.rows[0].email : null;
      } else if (isLogin && req.body && typeof req.body.email === 'string') {
        email = req.body.email.toLowerCase().slice(0, 200);   // спроба входу: email з форми
      }
      const body = SKIP_BODY.test(req.path) ? null : JSON.stringify(sanitize(req.body || {})).slice(0, 4000);
      await pool.query(
        `INSERT INTO admin_audit_log (admin_id, admin_email, method, path, status, ip, user_agent, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [adminId, email, req.method, `/api/admin${req.path}`.slice(0, 300), res.statusCode,
          String(req.ip || '').slice(0, 100), String(req.headers['user-agent'] || '').slice(0, 300), body]
      );
    } catch (err) {
      console.error('[audit] не вдалося записати:', err.message);
    }
  });
  next();
}

async function purgeOldAuditLog(days = 365) {
  await pool.query(`DELETE FROM admin_audit_log WHERE created_at < now() - make_interval(days => $1)`, [days]);
}

module.exports = { auditLog, purgeOldAuditLog };
