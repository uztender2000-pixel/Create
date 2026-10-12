const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { getToken } = require('../services/security');

// Токен покупця: { userId, email, tv }. tv — «версія токенів» користувача (users.token_version).
// Зміна пароля або «Вийти на всіх пристроях» збільшує її, і всі раніше видані токени стають
// недійсними одразу, а не через 30 днів. Перевірка також ловить видалених користувачів.
// Старі токени без tv вважаються версією 0 (як у нових користувачів), тому після оновлення
// ніхто не розлогінюється.
async function resolveUser(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload.purpose) throw new Error('wrong token type');
  const userId = Number(payload.userId);
  if (!Number.isInteger(userId)) throw new Error('bad payload');
  const { rows } = await pool.query('SELECT token_version FROM users WHERE id = $1', [userId]);
  if (!rows.length || (payload.tv || 0) !== rows[0].token_version) throw new Error('revoked');
  return { id: userId, email: payload.email };
}

// Reads "Authorization: Bearer <token>", verifies it, and attaches
// req.user = { id, email } if valid. Use on any route that needs to know
// who's calling (cart, checkout, profile).
async function requireAuth(req, res, next) {
  const token = getToken(req, 'user');   // заголовок Authorization або httpOnly-cookie

  if (!token) {
    return res.status(401).json({ error: 'Потрібна авторизація' });
  }

  try {
    req.user = await resolveUser(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недійсний або прострочений токен' });
  }
}

// Same as requireAuth, but never rejects: a valid token attaches req.user,
// anything else (no token, expired, garbage) just leaves req.user unset and
// carries on as a guest. For public endpoints that behave better when they
// know who's asking — e.g. homepage recommendations.
async function optionalAuth(req, res, next) {
  const token = getToken(req, 'user');
  if (token) {
    try {
      req.user = await resolveUser(token);
    } catch (err) { /* treat as guest */ }
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
