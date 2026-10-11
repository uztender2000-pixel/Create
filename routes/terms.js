const express = require('express');
const { getCurrentRow, withHtml } = require('../services/termsService');

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

module.exports = router;
