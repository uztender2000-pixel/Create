const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAdminRole } = require('../middleware/adminRole');

const router = express.Router();
router.use(requireAdminAuth, requireAdminRole);

// GET /api/admin/errors — помилки сервера: спершу невирішені, за останньою появою.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, kind, message, stack, method, path, count, first_seen, last_seen, resolved
         FROM error_log ORDER BY resolved ASC, last_seen DESC LIMIT 200`);
    const open = await pool.query(`SELECT COUNT(*)::int AS n FROM error_log WHERE NOT resolved`);
    res.json({ rows, open: open.rows[0].n });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити помилки' });
  }
});

// POST /api/admin/errors/:id/resolve — позначити помилку виправленою (якщо повториться — знову стане активною)
router.post('/:id/resolve', async (req, res) => {
  const { rowCount } = await pool.query('UPDATE error_log SET resolved = true WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/resolve-all', async (req, res) => {
  await pool.query('UPDATE error_log SET resolved = true WHERE NOT resolved');
  res.json({ ok: true });
});

module.exports = router;
