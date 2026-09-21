const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

// ---------------------------------------------------------------------
// SQL console. Owner only (role = 'admin') — a staff member with the
// "settings" permission does NOT get this, however the permissions are set.
//
// Two modes:
//
//   READ (default). Runs immediately. The query is executed inside a
//   READ ONLY transaction that is always rolled back, so even a query
//   that tries to change something simply fails. Sent through the
//   extended protocol, which accepts exactly ONE statement — that closes
//   the "COMMIT; DELETE ..." trick that would otherwise escape the
//   read-only transaction.
//
//   WRITE. Needs allowWrite=true AND the owner's password, re-checked on
//   every single run (a stolen login token alone is not enough to change
//   data). Several statements are allowed and run as one transaction:
//   if any of them fails, none of them is applied.
// ---------------------------------------------------------------------

const MAX_QUERY_LENGTH = 50000;
const MAX_ROWS_RETURNED = 500;
const READ_TIMEOUT_MS = 15000;
const WRITE_TIMEOUT_MS = 60000;

function requireOwner(req, res, next) {
  if (req.admin.role !== 'admin') {
    return res.status(403).json({ error: 'SQL-консоль доступна лише адміністратору' });
  }
  next();
}

router.use(requireAdminAuth, requireOwner);

// Password guessing protection: 10 write attempts per 15 minutes per admin.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `admin-${req.admin.id}`,
  validate: false,
  handler: (req, res) =>
    res.status(429).json({ error: 'Забагато спроб змін даних. Зачекайте 15 хвилин.' }),
});

// Shapes one pg result into something the browser can render.
function shapeResult(r) {
  const rows = Array.isArray(r.rows) ? r.rows : [];
  return {
    command: r.command || null,
    rowCount: r.rowCount ?? rows.length,
    columns: (r.fields || []).map((f) => f.name),
    rows: rows.slice(0, MAX_ROWS_RETURNED),
    truncated: rows.length > MAX_ROWS_RETURNED,
    totalRows: rows.length,
  };
}

async function logWrite(admin, query, outcome, detail) {
  try {
    await pool.query(
      `INSERT INTO admin_sql_log (admin_id, admin_email, query, outcome, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [admin.id, admin.email, query.slice(0, 20000), outcome, detail ? String(detail).slice(0, 1000) : null]
    );
  } catch (err) {
    console.error('[sql-log] failed to write journal:', err.message);
  }
}

async function runRead(query) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${READ_TIMEOUT_MS}`);
    // Take a snapshot now. After this, "SET TRANSACTION READ WRITE" is
    // refused by PostgreSQL ("must be set before any query").
    await client.query('SELECT 1');

    // A named (prepared) statement always goes through the extended
    // protocol, which accepts exactly ONE statement. That closes the
    // "COMMIT; DELETE ..." trick that would otherwise escape the
    // read-only transaction. The name must be unique per query.
    const result = await client.query({ name: `adminsql_${crypto.randomUUID()}`, text: query });
    return [shapeResult(result)];
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    // release(true) closes this connection instead of returning it to the
    // pool, so the prepared statement and any SET the user ran die with it.
    client.release(true);
  }
}

async function runWrite(query) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${WRITE_TIMEOUT_MS}`);
    // No parameters => simple protocol => several statements allowed.
    const result = await client.query(query);
    await client.query('COMMIT');
    const list = Array.isArray(result) ? result : [result];
    return list.map(shapeResult);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// POST /api/admin/sql — { query, allowWrite?, password? }
router.post('/', (req, res, next) => {
  // Only write attempts are rate limited; reading stays instant.
  if (req.body && req.body.allowWrite) return writeLimiter(req, res, next);
  next();
}, async (req, res) => {
  const { query, allowWrite, password } = req.body || {};

  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Введіть SQL-запит' });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ error: 'Запит задовгий' });
  }

  const started = Date.now();

  // ---------- WRITE MODE ----------
  if (allowWrite) {
    if (!password) {
      return res.status(400).json({ error: 'Для зміни даних введіть пароль адміністратора', code: 'password_required' });
    }

    const { rows } = await pool.query('SELECT password_hash FROM admin_users WHERE id = $1', [req.admin.id]);
    const ok = rows.length && (await bcrypt.compare(String(password), rows[0].password_hash));
    if (!ok) {
      await logWrite(req.admin, query, 'bad_password', 'Невірний пароль');
      return res.status(403).json({ error: 'Невірний пароль', code: 'bad_password' });
    }

    try {
      const results = await runWrite(query);
      const summary = results.map((r) => `${r.command || '?'} ${r.rowCount}`).join('; ');
      await logWrite(req.admin, query, 'ok', summary);
      return res.json({ mode: 'write', results, ms: Date.now() - started });
    } catch (err) {
      await logWrite(req.admin, query, 'error', err.message);
      return res.status(400).json({
        error: err.message,
        position: err.position ? Number(err.position) : null,
        rolledBack: true,
      });
    }
  }

  // ---------- READ MODE ----------
  try {
    const results = await runRead(query);
    return res.json({ mode: 'read', results, ms: Date.now() - started });
  } catch (err) {
    // 25006 = read_only_sql_transaction: the query tried to change data.
    if (err.code === '25006') {
      return res.status(409).json({
        code: 'write_required',
        error: 'Цей запит змінює дані. Поставте галочку «Дозволити змінювати дані» і введіть пароль адміністратора.',
      });
    }
    // 42601 with this text = several statements sent in read mode.
    if (/cannot insert multiple commands/i.test(err.message)) {
      return res.status(400).json({
        code: 'multi_statement',
        error: 'У режимі читання можна виконати лише один запит за раз. Кілька запитів підряд — тільки з дозволом на зміну даних.',
      });
    }
    return res.status(400).json({
      error: err.message,
      position: err.position ? Number(err.position) : null,
    });
  }
});

// GET /api/admin/sql/history — the last 30 write attempts
router.get('/history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, admin_email, query, outcome, detail, created_at
         FROM admin_sql_log ORDER BY id DESC LIMIT 30`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити журнал' });
  }
});

module.exports = router;
