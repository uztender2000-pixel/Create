process.env.FRONTEND_ORIGIN = 'https://shop.example,https://www.shop.example';
process.env.COOKIE_SESSIONS = 'true';
process.env.COOKIE_SECURE = 'true';
process.env.COOKIE_SAMESITE = 'None';
const test = require('node:test');
const assert = require('node:assert');
const sec = require('../services/security');

function run(req) {
  let status = null; let called = false;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  sec.csrfGuard({ headers: {}, ...req }, res, () => { called = true; });
  return { status, called };
}

test('parseCookies коректно розбирає заголовок', () => {
  assert.deepStrictEqual(sec.parseCookies('a=1; b=hello%20world; broken'), { a: '1', b: 'hello world' });
});

test('багато адрес фронтенду розбираються з FRONTEND_ORIGIN', () => {
  assert.deepStrictEqual(sec.allowedOrigins, ['https://shop.example', 'https://www.shop.example']);
});

test('CSRF: запит із cookie-сесією без заголовка або з чужим Origin відхиляється', () => {
  const cookie = `${sec.NAMES.user}=abc`;
  assert.strictEqual(run({ method: 'POST', headers: { cookie } }).status, 403);
  assert.strictEqual(run({ method: 'POST', headers: { cookie, 'x-requested-with': 'shop', origin: 'https://evil.example' } }).status, 403);
  assert.ok(run({ method: 'POST', headers: { cookie, 'x-requested-with': 'shop', origin: 'https://shop.example' } }).called);
});

test('CSRF: GET, запити з Bearer і запити без cookie не перевіряються', () => {
  const cookie = `${sec.NAMES.user}=abc`;
  assert.ok(run({ method: 'GET', headers: { cookie } }).called);
  assert.ok(run({ method: 'POST', headers: { cookie, authorization: 'Bearer x' } }).called);
  assert.ok(run({ method: 'POST', headers: {} }).called);
});

test('cookie: __Host-, HttpOnly, Secure, SameSite=None і Partitioned', () => {
  const headers = {};
  const res = { getHeader: (k) => headers[k], setHeader: (k, v) => { headers[k] = v; } };
  const body = sec.sessionBody({ headers: { 'x-session-mode': 'cookie' } }, res, 'user', 'TOKEN', { ok: true });
  assert.strictEqual(body.token, undefined);
  const c = String(headers['Set-Cookie']);
  for (const part of ['__Host-shop_sid=TOKEN', 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Path=/']) assert.ok(c.includes(part), part);
});

test('без заголовка X-Session-Mode токен лишається у відповіді (сумісність зі старим фронтендом)', () => {
  const res = { getHeader() {}, setHeader() { throw new Error('cookie не має ставитись'); } };
  assert.strictEqual(sec.sessionBody({ headers: {} }, res, 'user', 'TOKEN', {}).token, 'TOKEN');
});
