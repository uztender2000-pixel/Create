const jwt = require('jsonwebtoken');

// Reads "Authorization: Bearer <token>", verifies it, and attaches
// req.user = { id, email } if valid. Use on any route that needs to know
// who's calling (cart, checkout, profile).
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Потрібна авторизація' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.userId, email: payload.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недійсний або прострочений токен' });
  }
}

// Same as requireAuth, but never rejects: a valid token attaches req.user,
// anything else (no token, expired, garbage) just leaves req.user unset and
// carries on as a guest. For public endpoints that behave better when they
// know who's asking — e.g. homepage recommendations.
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.user = { id: payload.userId, email: payload.email };
    } catch (err) { /* treat as guest */ }
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
