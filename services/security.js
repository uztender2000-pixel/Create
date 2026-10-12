// ---------------------------------------------------------------------------
// Спільні налаштування безпеки: дозволені адреси фронтенду, cookie-сесії, CSRF.
//
// Cookie-сесії (COOKIE_SESSIONS=true) переносять токен із localStorage (звідки його може
// вкрасти будь-який шкідливий скрипт) в httpOnly-cookie, недоступну для JavaScript.
//
// Режим сесії обирає САМ БРАУЗЕР, а не сервер:
//  • фронтенд перевіряє, чи доходять cookie від API (GET /api/session/probe → /check);
//  • якщо так — шле заголовок X-Session-Mode: cookie, і сервер видає httpOnly-cookie без токена
//    у відповіді;
//  • якщо ні (Safari/iOS та інші браузери, що блокують сторонні cookie) — сесія працює через токен
//    у заголовку, як і раніше. Вхід не ламається ніде.
//
// Фронтенд і API на ОДНОМУ сайті (shop.ua + api.shop.ua): COOKIE_SAMESITE=Lax (за замовчуванням) —
// cookie працюють в усіх браузерах.
// На РІЗНИХ сайтах (frontend.com + xxx.onrender.com): COOKIE_SAMESITE=None. Cookie ставляться з
// атрибутом Partitioned (CHIPS) і працюють у Chrome/Edge навіть при блокуванні сторонніх cookie;
// там, де їх блокують повністю (Safari), автоматично діє токен.
// ---------------------------------------------------------------------------

const allowedOrigins = String(process.env.FRONTEND_ORIGIN || '')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

// Без явного списку адрес cookie-режим небезпечний (CORS з credentials не можна відкривати для всіх).
function cookieSessionsEnabled() {
  return String(process.env.COOKIE_SESSIONS || '').toLowerCase() === 'true' && allowedOrigins.length > 0;
}

const SECURE = String(process.env.COOKIE_SECURE || 'true').toLowerCase() !== 'false';
const SAMESITE = ['Strict', 'Lax', 'None'].includes(process.env.COOKIE_SAMESITE) ? process.env.COOKIE_SAMESITE : 'Lax';
const PARTITIONED = SAMESITE === 'None' && String(process.env.COOKIE_PARTITIONED || 'true').toLowerCase() !== 'false';
const PREFIX = SECURE ? '__Host-' : '';   // __Host-: cookie лише для цього хоста, лише по HTTPS
const NAMES = { user: `${PREFIX}shop_sid`, admin: `${PREFIX}shop_asid`, probe: `${PREFIX}shop_probe` };
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
  if (PARTITIONED) a.push('Partitioned');   // CHIPS: cookie «прив'язана» до сайту фронтенду і працює без сторонніх cookie
  if (maxAgeMs != null) a.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return a.join('; ');
}

function appendCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, value) : value);
}

// Браузер сам повідомляє, що cookie в ньому працюють (після успішної перевірки probe/check).
function clientWantsCookie(req) {
  return String(req.headers['x-session-mode'] || '').toLowerCase() === 'cookie';
}

// Повертає тіло відповіді: якщо cookie доступні і браузер їх підтримує — токен кладемо в
// httpOnly-cookie (а не у відповідь), інакше — у поле token, як і раніше.
function sessionBody(req, res, kind, token, extra = {}) {
  if (!cookieSessionsEnabled() || !clientWantsCookie(req)) return { ...extra, token };
  appendCookie(res, `${NAMES[kind]}=${encodeURIComponent(token)}; ${cookieAttrs(MAX_AGE[kind])}`);
  return { ...extra, cookieSession: true };
}

// Перевірка «чи доходять cookie від API до цього браузера»: probe ставить тестову cookie,
// check каже, чи повернув її браузер.
function setProbeCookie(res) {
  appendCookie(res, `${NAMES.probe}=1; ${cookieAttrs(300 * 1000)}`);
}
function probeSeen(req) {
  return Boolean(parseCookies(req.headers.cookie)[NAMES.probe]);
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
  setProbeCookie, probeSeen,
};
