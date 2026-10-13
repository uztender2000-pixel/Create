const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAdminRole } = require('../middleware/adminRole');
const { renderTerms } = require('../services/termsService');
const { DEFAULT_PAGES, liveSnapshot } = require('../services/sitePages');

const router = express.Router();
router.use(requireAdminAuth, requireAdminRole);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const DEFAULT_SLUGS = new Set(DEFAULT_PAGES.map((p) => p.slug));
const MAX_CONTENT = 100000;

// GET /api/admin/pages — усі сторінки з вихідним текстом
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT slug, title, content, published, sort_order, updated_at, updated_by FROM site_pages ORDER BY sort_order, slug');
  res.json({ pages: rows.map((r) => ({ ...r, builtin: DEFAULT_SLUGS.has(r.slug) })), defaults: DEFAULT_PAGES.map((p) => ({ slug: p.slug, content: p.content })) });
});

// POST /api/admin/pages/preview — { content } → HTML так, як побачать відвідувачі
router.post('/preview', async (req, res) => {
  const content = String(req.body.content ?? '');
  if (content.length > MAX_CONTENT) return res.status(400).json({ error: 'Текст занадто довгий' });
  res.json(renderTerms(content, await liveSnapshot()));
});

// PUT /api/admin/pages/:slug — створити або оновити сторінку { title, content, published }
router.put('/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug);
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Адреса сторінки: латиниця, цифри й дефіс, 2–40 символів' });
    const title = String(req.body.title ?? '').trim();
    const content = String(req.body.content ?? '').replace(/\r\n/g, '\n').trim();
    if (!title || title.length > 200) return res.status(400).json({ error: 'Вкажіть назву сторінки (до 200 символів)' });
    if (!content) return res.status(400).json({ error: 'Текст сторінки не може бути порожнім' });
    if (content.length > MAX_CONTENT) return res.status(400).json({ error: 'Текст занадто довгий' });
    const published = req.body.published !== false;
    const { rows } = await pool.query(
      `INSERT INTO site_pages (slug, title, content, published, sort_order, updated_by)
       VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort_order) + 10 FROM site_pages), 10), $5)
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, published = EXCLUDED.published,
              updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING slug`, [slug, title, content, published, req.admin.email]);
    res.json({ ok: true, slug: rows[0].slug });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося зберегти сторінку' });
  }
});

// DELETE /api/admin/pages/:slug — лише власні сторінки (вбудовані можна лише приховати)
router.delete('/:slug', async (req, res) => {
  if (DEFAULT_SLUGS.has(req.params.slug)) return res.status(400).json({ error: 'Вбудовану сторінку не можна видалити — приховайте її' });
  const { rowCount } = await pool.query('DELETE FROM site_pages WHERE slug = $1', [req.params.slug]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
