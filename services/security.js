// ---------------------------------------------------------------------------
// Спільні налаштування безпеки: дозволені адреси фронтенду, cookie-сесії, CSRF.
//
// Cookie-сесії (COOKIE_SESSIONS=true) переносять токен із localStorage (звідки його може
// вкрасти будь-який шкідливий скрипт) в httpOnly-cookie, недоступну для JavaScript.
//
// УВАГА: працює надійно, лише коли фронтенд і API на одному «сайті» (одному домені верхнього
// рівня), напр. shop.ua і api.shop.ua. Якщо вони на різних доменах (frontend.com і
// xxx.onrender.com), Safari та частина браузерів блокують сторонні cookie — вхід ламається.
// Тоді залишайте COOKIE_SESSIONS вимкненим (токен у заголовку, як і раніше).
// ---------------------------------------------------------------------------

const allowedOrigins = String(process.env.FRONTEND_ORIGIN || '')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

// Без явного списку адрес cookie-режим небезпечний (CORS з credentials не можна відкривати для всіх).
function cookieSessionsEnabled() {
  return String(process.env.COOKIE_SESSIONS || '').toLowerCase() === 'true' && allowedOrigins.length > 0;
}

const SECURE = String(process.env.COOKIE_SECURE || 'true').toLowerCase() !== 'false';
const SAMESITE = ['Strict', 'Lax', 'None'].includes(process.env.COOKIE_SAMESITE) ? process.env.COOKIE_SAMESITE : 'Lax';
const PREFIX = SECURE && SAMESITE !== 'None' ? '__Host-' : '';   // __Host-: cookie лише для цього хоста, лише по HTTPS
const NAMES = { user: `${PREFIX}shop_sid`, admin: `${PREFIX}shop_asid` };
const MAX_AGE = { user: 14 * 24 * 3600 * 1000, admin: 12 * 3600 * 1000 };

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* пошкоджена cookie */ }
  }
  return out;
}

// Токен із заголовка Authorization або, якщо його немає, з httpOnly-cookie.
function getToken(req, kind) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return parseCookies(req.headers.cookie)[NAMES[kind]] || null;
}

function cookieAttrs(maxAgeMs) {
  const a = ['Path=/', 'HttpOnly', `SameSite=${SAMESITE}`];
  if (SECURE || SAMESITE === 'None') a.push('Secure');
  if (maxAgeMs != null) a.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return a.join('; ');
}

function appendCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, value) : value);
}

// Повертає тіло відповіді: у cookie-режимі токен кладемо в cookie (а не у відповідь),
// інакше — у поле token, як і раніше.
function sessionBody(res, kind, token, extra = {}) {
  if (!cookieSessionsEnabled()) return { ...extra, token };
  appendCookie(res, `${NAMES[kind]}=${encodeURIComponent(token)}; ${cookieAttrs(MAX_AGE[kind])}`);
  return { ...extra, cookieSession: true };
}

function clearSession(res, kind) {
  appendCookie(res, `${NAMES[kind]}=; ${cookieAttrs(0)}`);
}

// CSRF-захист для запитів, авторизованих cookie: браузер сам додає cookie до будь-якого запиту,
// навіть ініційованого чужим сайтом. Тому змінюючі запити мають:
//  1) прийти з дозволеної адреси фронтенду (заголовок Origin), та
//  2) містити спеціальний заголовок X-Requested-With — чужий сайт не може його додати без
//     дозволу CORS, а ми дозволяємо лише наш фронтенд.
// Запити з Authorization: Bearer від CSRF не страждають і не перевіряються.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if ((req.headers.authorization || '').startsWith('Bearer ')) return next();
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies[NAMES.user] && !cookies[NAMES.admin]) return next();
  const origin = req.headers.origin;
  const originOk = origin ? allowedOrigins.includes(origin.replace(/\/$/, '')) : true;
  if (!originOk || req.headers['x-requested-with'] !== 'shop') {
    return res.status(403).json({ error: 'Запит відхилено (захист від підробки запитів)' });
  }
  next();
}

module.exports = {
  allowedOrigins, cookieSessionsEnabled, NAMES, parseCookies, getToken, sessionBody, clearSession, csrfGuard,
};
