const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('settings'));

// GET /api/admin/section-translations — every raw section name currently
// used by any product (regardless of supplier active/available status,
// so a translation can be prepared ahead of time), how many products use
// it, and its current translation if one has been set.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.section AS raw_name, COUNT(*)::int AS count, st.display_name
         FROM products p
         LEFT JOIN section_translations st ON st.raw_name = p.section
        WHERE p.section IS NOT NULL
        GROUP BY p.section, st.display_name
        ORDER BY count DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load section translations' });
  }
});

// PUT /api/admin/section-translations — set or clear one translation.
// Body: { raw_name, display_name }. An empty/blank display_name removes
// the override (the storefront falls back to showing raw_name again).
router.put('/', async (req, res) => {
  try {
    const { raw_name, display_name } = req.body;
    if (!raw_name) return res.status(400).json({ error: 'raw_name обов\'язковий' });

    const trimmed = (display_name || '').trim();
    if (!trimmed) {
      await pool.query('DELETE FROM section_translations WHERE raw_name = $1', [raw_name]);
      return res.json({ ok: true, cleared: true });
    }

    await pool.query(
      `INSERT INTO section_translations (raw_name, display_name, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (raw_name) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
      [raw_name, trimmed]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save translation' });
  }
});

module.exports = router;
