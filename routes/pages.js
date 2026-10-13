const express = require('express');
const { pool } = require('../db');
const { renderPageRow } = require('../services/sitePages');

const router = express.Router();

// GET /api/pages — список опублікованих сторінок (для футера й меню).
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT slug, title FROM site_pages WHERE published ORDER BY sort_order, slug');
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ pages: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити сторінки' });
  }
});

// GET /api/pages/:slug — сторінка з готовим безпечним HTML.
router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT slug, title, content, updated_at FROM site_pages WHERE slug = $1 AND published', [req.params.slug]);
    if (!rows.length) return res.status(404).json({ error: 'Сторінку не знайдено' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await renderPageRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити сторінку' });
  }
});

module.exports = router;
