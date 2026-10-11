const express = require('express');
const { getCurrentRow, withHtml, renderTerms } = require('../services/termsService');

const router = express.Router();

// GET /api/terms — чинна редакція правил та умов (публічно).
// Віддає готовий безпечний HTML, зміст і метадані.
router.get('/', async (req, res) => {
  try {
    const row = await getCurrentRow();
    if (!row) return res.status(404).json({ error: 'Правила ще не опубліковані' });
    res.set('Cache-Control', 'no-cache');
    res.json(withHtml(row));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити правила' });
  }
});

// GET /api/terms/summary — легка версія для футера сайту: зміст правил (щоб посилатися на
// розділи «Доставка», «Повернення» тощо) і ПУБЛІЧНІ реквізити власника. Без тексту правил.
router.get('/summary', async (req, res) => {
  try {
    const row = await getCurrentRow();
    if (!row) return res.status(404).json({ error: 'Правила ще не опубліковані' });
    const { toc } = renderTerms(row.content, row.owner_snapshot);
    const v = (row.owner_snapshot && row.owner_snapshot.values) || {};
    const owner = {};
    for (const k of ['name', 'edrpou', 'legal_address', 'actual_address', 'email', 'phone', 'phone_extra', 'work_hours', 'website']) {
      if (v[k]) owner[k] = v[k];
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ version: row.version, effective_date: row.effective_date, toc, owner });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити дані' });
  }
});

module.exports = router;
