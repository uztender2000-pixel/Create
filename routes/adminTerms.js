const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAdminRole } = require('../middleware/adminRole');
const { getOwner, buildSnapshot } = require('../services/ownerInfo');
const {
  LIMITS, renderTerms, getCurrentRow, getRowByVersion, publishVersion,
} = require('../services/termsService');

const router = express.Router();
router.use(requireAdminAuth, requireAdminRole);

// GET /api/admin/terms — чинна редакція (з сирим текстом для редагування),
// історія редакцій і статистика згод.
router.get('/', async (req, res) => {
  try {
    const current = await getCurrentRow();
    const { rows: versions } = await pool.query(
      `SELECT tv.id, tv.version, tv.title, tv.change_summary, tv.require_acceptance, tv.published_by, tv.created_at,
              to_char(tv.effective_date, 'YYYY-MM-DD') AS effective_date,
              (SELECT COUNT(*)::int FROM terms_acceptances a WHERE a.terms_version_id = tv.id) AS acceptances
         FROM terms_versions tv ORDER BY tv.id DESC LIMIT 100`
    );
    const { rows: stats } = await pool.query(
      `SELECT COUNT(*)::int AS total_users,
              COUNT(*) FILTER (WHERE u.terms_version = (SELECT version FROM terms_versions ORDER BY id DESC LIMIT 1))::int AS on_current,
              COUNT(*) FILTER (WHERE av.id IS NULL OR av.id < COALESCE((SELECT id FROM terms_versions WHERE require_acceptance ORDER BY id DESC LIMIT 1), 0))::int AS pending
         FROM users u LEFT JOIN terms_versions av ON av.version = u.terms_version`
    );
    res.json({
      limits: LIMITS,
      current: current && {
        version: current.version, title: current.title, content: current.content,
        effective_date: current.effective_date, change_summary: current.change_summary,
        published_by: current.published_by, created_at: current.created_at,
      },
      versions,
      stats: stats[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити правила' });
  }
});

// GET /api/admin/terms/versions/:version — будь-яка стара редакція (текст + готовий HTML).
router.get('/versions/:version', async (req, res) => {
  try {
    const row = await getRowByVersion(req.params.version);
    if (!row) return res.status(404).json({ error: 'Редакцію не знайдено' });
    const { html } = renderTerms(row.content, row.owner_snapshot);
    res.json({
      version: row.version, title: row.title, content: row.content, html,
      effective_date: row.effective_date, change_summary: row.change_summary,
      require_acceptance: row.require_acceptance, published_by: row.published_by, created_at: row.created_at,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити редакцію' });
  }
});

// POST /api/admin/terms/preview — { content } → HTML так, як його побачать покупці
// (з поточними реквізитами власника).
router.post('/preview', async (req, res) => {
  try {
    const content = String(req.body.content ?? '');
    if (content.length > LIMITS.content) return res.status(400).json({ error: 'Текст занадто довгий' });
    const owner = await getOwner();
    const { html, toc } = renderTerms(content, buildSnapshot(owner.value));
    res.json({ html, toc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося побудувати попередній перегляд' });
  }
});

// POST /api/admin/terms/publish — { title, content, effective_date?, change_summary, require_acceptance }
// Створює НОВУ редакцію (стара лишається в історії). Якщо require_acceptance = true,
// кожен покупець мусить прийняти її при наступному вході; без цього прапорця
// (дрібні правки) покупці нічого не підтверджують, але бачать актуальний текст.
router.post('/publish', async (req, res) => {
  try {
    const title = String(req.body.title ?? '').trim();
    const content = String(req.body.content ?? '').replace(/\r\n/g, '\n').trim();
    const summary = String(req.body.change_summary ?? '').trim();
    const requireAcceptance = req.body.require_acceptance !== false;
    const effectiveDate = req.body.effective_date ? String(req.body.effective_date) : null;

    if (!title) return res.status(400).json({ error: 'Вкажіть назву документа' });
    if (title.length > LIMITS.title) return res.status(400).json({ error: 'Назва занадто довга' });
    if (!content) return res.status(400).json({ error: 'Текст правил не може бути порожнім' });
    if (content.length > LIMITS.content) return res.status(400).json({ error: 'Текст занадто довгий' });
    if (summary.length > LIMITS.summary) return res.status(400).json({ error: `Опис змін — не більше ${LIMITS.summary} символів` });
    if (effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return res.status(400).json({ error: 'Некоректна дата редакції' });

    const current = await getCurrentRow();
    if (current && current.title === title && current.content.trim() === content) {
      return res.status(400).json({ error: 'Текст і назва не змінились — нічого публікувати' });
    }
    if (current && requireAcceptance && !summary) {
      return res.status(400).json({ error: 'Коротко опишіть, що змінилось: цей текст побачать покупці перед підтвердженням' });
    }

    const owner = await getOwner();
    const created = await publishVersion({
      title, content, effectiveDate, changeSummary: summary || null,
      requireAcceptance, ownerSnapshot: buildSnapshot(owner.value), adminLabel: req.admin.email,
    });
    res.status(201).json({ ok: true, version: created.version, require_acceptance: created.require_acceptance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося опублікувати редакцію' });
  }
});

module.exports = router;
