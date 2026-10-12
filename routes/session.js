const express = require('express');
const { cookieSessionsEnabled, setProbeCookie, probeSeen } = require('../services/security');

const router = express.Router();

// GET /api/session/probe — ставить тестову cookie. Фронтенд викликає її з credentials: 'include'.
router.get('/probe', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (cookieSessionsEnabled()) setProbeCookie(res);
  res.json({ ok: true });
});

// GET /api/session/check — { cookie: true }, якщо браузер повернув тестову cookie, тобто cookie-сесії
// в цьому браузері працюватимуть. Інакше фронтенд лишається на токені в заголовку.
router.get('/check', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ cookie: cookieSessionsEnabled() && probeSeen(req) });
});

module.exports = router;
