const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAdminRole } = require('../middleware/adminRole');

const router = express.Router();
router.use(requireAdminAuth, requireAdminRole);

// GET /api/admin/audit?limit=50&offset=0&q=текст&status=fail|ok&logins=1
// Журнал дій в адмінці — лише для ролі «Адміністратор».
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const where = [];
    const params = [];
    if (req.query.q) {
      params.push(`%${String(req.query.q).slice(0, 100)}%`);
      where.push(`(admin_email ILIKE $${params.length} OR path ILIKE $${params.length} OR ip ILIKE $${params.length})`);
    }
    if (req.query.status === 'fail') where.push('status >= 400');
    if (req.query.status === 'ok') where.push('status < 400');
    if (req.query.logins === '1') where.push("path LIKE '/api/admin/auth/login%'");
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM admin_audit_log ${w}`, params);
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT id, admin_email, method, path, status, ip, user_agent, detail, created_at
         FROM admin_audit_log ${w} ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json({ total: total.rows[0].n, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити журнал' });
  }
});

module.exports = router;
