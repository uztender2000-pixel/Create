const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('settings'));

// GET /api/admin/logs — recent operational problems (sync failures,
// orders that didn't go through, webhook errors), newest first.
// ?source=sync|order|webhook  ?supplier_id=...  ?level=error|warn
router.get('/', async (req, res) => {
  try {
    const { source, supplier_id, level } = req.query;
    const conditions = [];
    const params = [];

    if (source) { params.push(source); conditions.push(`e.source = $${params.length}`); }
    if (supplier_id) { params.push(supplier_id); conditions.push(`e.supplier_id = $${params.length}`); }
    if (level) { params.push(level); conditions.push(`e.level = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT e.id, e.level, e.source, e.message, e.detail, e.created_at,
              s.name AS supplier_name, s.code AS supplier_code
         FROM event_log e
         LEFT JOIN suppliers s ON s.id = e.supplier_id
         ${where}
        ORDER BY e.created_at DESC
        LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load logs' });
  }
});

// GET /api/admin/logs/summary — counts per source over the last 24h, for
// a quick "is anything currently broken" glance on the logs page.
router.get('/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT source, COUNT(*)::int AS count, MAX(created_at) AS last_at
        FROM event_log
       WHERE created_at >= now() - interval '24 hours'
       GROUP BY source
       ORDER BY count DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load log summary' });
  }
});

// DELETE /api/admin/logs — clears the log (owner cleanup, e.g. after
// fixing something and confirming it's resolved).
router.delete('/', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM event_log');
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear logs' });
  }
});

module.exports = router;
