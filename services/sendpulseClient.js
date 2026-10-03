'use strict';

// Мінімальна інтеграція з SendPulse SMTP API (транзакційні листи).
// Авторизація — статичний API-ключ у заголовку `Authorization: Bearer <ключ>` (без OAuth).
// Документація: https://sendpulse.com/integrations/api/smtp
//
// Конфігурація — лише зі змінних середовища (див. .env.example):
//   SENDPULSE_API_KEY         (обов'язково)  API-ключ: Налаштування → API → API-ключі
//   SENDPULSE_API_FROM_EMAIL  (обов'язково)  підтверджений відправник
//   SENDPULSE_API_FROM_NAME   (необов'язково) ім'я відправника
//   SENDPULSE_API_BASE_URL    (необов'язково) за замовчуванням https://api.sendpulse.com

const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.sendpulse.com';
const REQUEST_TIMEOUT_MS = 15000;
const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

// Помилка, яку кидають усі методи модуля. Не містить секретів (ключ ніколи не потрапляє в message).
class SendPulseError extends Error {
  constructor(message, { code = 'ERROR', status = null, details = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'SendPulseError';
    this.code = code;           // CONFIG | VALIDATION | NETWORK | AUTH | FORBIDDEN | INVALID_SENDER | RATE_LIMITED | SERVER | HTTP
    this.status = status;       // HTTP-статус, якщо відповідь була
    this.details = details;     // тіло відповіді SendPulse (для діагностики)
    this.retryAfter = retryAfter; // секунди до повтору (для 429), якщо сервіс підказав
  }
}

function getConfig() {
  const env = process.env;
  return {
    apiKey: (env.SENDPULSE_API_KEY || '').trim(),
    fromEmail: (env.SENDPULSE_API_FROM_EMAIL || '').trim(),
    fromName: (env.SENDPULSE_API_FROM_NAME || '').trim(),
    baseUrl: ((env.SENDPULSE_API_BASE_URL || '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

// true, якщо задано і ключ, і відправника.
function isConfigured() {
  const c = getConfig();
  return Boolean(c.apiKey && c.fromEmail);
}

function requireConfig({ needFrom }) {
  const c = getConfig();
  const missing = [];
  if (!c.apiKey) missing.push('SENDPULSE_API_KEY');
  if (needFrom && !c.fromEmail) missing.push('SENDPULSE_API_FROM_EMAIL');
  if (missing.length) {
    throw new SendPulseError(`Не задано змінні середовища: ${missing.join(', ')}`, { code: 'CONFIG' });
  }
  return c;
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// Приймає 'a@b.c', { email, name } або масив таких значень → [{ email, name? }].
function normalizeRecipients(input, field) {
  const list = Array.isArray(input) ? input : [input];
  const out = list.filter((x) => x !== undefined && x !== null && x !== '').map((x) => {
    const item = typeof x === 'string' ? { email: x } : { email: x && x.email, name: x && x.name };
    const email = String(item.email || '').trim();
    if (!EMAIL_RE.test(email)) {
      throw new SendPulseError(`Некоректна адреса у полі "${field}": ${email || '(порожньо)'}`, { code: 'VALIDATION' });
    }
    return item.name ? { email, name: String(item.name) } : { email };
  });
  if (!out.length) throw new SendPulseError(`Не вказано жодного отримувача (поле "${field}")`, { code: 'VALIDATION' });
  return out;
}

// Дістає людський опис помилки з тіла відповіді SendPulse (формат тіла у різних методів різний).
function extractMessage(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.replace(/\s+/g, ' ').slice(0, 300);
  const candidate = body.message || body.error_description || body.error || body.errors;
  if (!candidate) return '';
  const text = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
  return text.slice(0, 300);
}

// Перетворює не-2xx відповідь на SendPulseError з зрозумілим повідомленням.
function toHttpError(res) {
  const { status, data, headers } = res;
  const detail = extractMessage(data);
  const suffix = detail ? `: ${detail}` : '';
  const retryAfterRaw = headers && (headers['retry-after'] || headers['Retry-After']);
  const retryAfter = retryAfterRaw && Number.isFinite(Number(retryAfterRaw)) ? Number(retryAfterRaw) : null;
  const base = { status, details: data, retryAfter };

  if (status === 401) {
    return new SendPulseError(`SendPulse відхилив авторизацію (HTTP 401): ключ невірний, відкликаний або не заданий${suffix}`, { ...base, code: 'AUTH' });
  }
  if (status === 403) {
    return new SendPulseError(`Доступ заборонено (HTTP 403): перевірте права API-ключа та обмеження за IP${suffix}`, { ...base, code: 'FORBIDDEN' });
  }
  if (status === 422) {
    const senderIssue = /sender/i.test(detail);
    return new SendPulseError(
      senderIssue
        ? `Відправник недійсний (HTTP 422): SENDPULSE_API_FROM_EMAIL не підтверджено в SendPulse${suffix}`
        : `SendPulse не прийняв дані листа (HTTP 422)${suffix}`,
      { ...base, code: senderIssue ? 'INVALID_SENDER' : 'VALIDATION' }
    );
  }
  if (status === 429) {
    return new SendPulseError(
      `Перевищено ліміт або квоту відправки (HTTP 429)${retryAfter ? `, повторіть через ${retryAfter} с` : ''}${suffix}`,
      { ...base, code: 'RATE_LIMITED' }
    );
  }
  if (status >= 500) {
    return new SendPulseError(`Помилка на боці SendPulse (HTTP ${status})${suffix}`, { ...base, code: 'SERVER' });
  }
  return new SendPulseError(`Несподівана відповідь SendPulse (HTTP ${status})${suffix}`, { ...base, code: 'HTTP' });
}

// Єдина точка HTTP-викликів: повертає тіло відповіді для 2xx, інакше кидає SendPulseError.
async function request(method, path, { apiKey, baseUrl }, data) {
  let res;
  try {
    res = await axios.request({
      method,
      url: `${baseUrl}${path}`,
      data,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true, // статуси обробляємо самі, щоб віддати очищену помилку
    });
  } catch (err) {
    // Повідомлення axios не містить заголовків із ключем, але підстрахуємось і не додаємо err.config.
    throw new SendPulseError(`Не вдалося з'єднатися з SendPulse: ${err.code || err.message}`, { code: 'NETWORK' });
  }
  if (res.status < 200 || res.status >= 300) throw toHttpError(res);
  return res.data;
}

/**
 * Надсилає лист (POST /smtp/emails).
 *
 * @param {object} msg
 * @param {string|object|Array} msg.to       'a@b.c' | { email, name } | масив таких значень
 * @param {string} msg.subject               тема
 * @param {string} [msg.html]                HTML-версія (до SendPulse йде в Base64 — цього вимагає API)
 * @param {string} [msg.text]                текстова версія (потрібен хоча б html або text)
 * @param {string} [msg.from]                переважує SENDPULSE_API_FROM_EMAIL
 * @param {string} [msg.fromName]            переважує SENDPULSE_API_FROM_NAME
 * @param {string|object} [msg.replyTo]      адреса для відповіді
 * @returns {Promise<{ id: string|null, result: boolean }>}
 * @throws {SendPulseError}
 */
async function sendEmail(msg = {}) {
  const cfg = requireConfig({ needFrom: !msg.from });

  const subject = String(msg.subject || '').trim();
  if (!subject) throw new SendPulseError('Не вказано тему листа (subject)', { code: 'VALIDATION' });
  if (!msg.html && !msg.text) throw new SendPulseError('Потрібен хоча б один із варіантів: html або text', { code: 'VALIDATION' });

  const fromEmail = String(msg.from || cfg.fromEmail).trim();
  if (!EMAIL_RE.test(fromEmail)) {
    throw new SendPulseError(`Некоректна адреса відправника: ${fromEmail}`, { code: 'VALIDATION' });
  }
  const fromName = msg.fromName || cfg.fromName;

  const email = {
    subject,
    from: fromName ? { email: fromEmail, name: fromName } : { email: fromEmail },
    to: normalizeRecipients(msg.to, 'to'),
  };
  if (msg.html) email.html = b64(msg.html); // SendPulse очікує html у Base64
  if (msg.text) email.text = String(msg.text);
  if (msg.replyTo) email.reply_to = normalizeRecipients(msg.replyTo, 'replyTo')[0];

  const body = await request('POST', '/smtp/emails', cfg, { email });

  // Успішна відповідь: { result: true, id: "..." }. Якщо result: false — це теж помилка.
  if (body && body.result === false) {
    throw new SendPulseError(`SendPulse не прийняв лист${extractMessage(body) ? `: ${extractMessage(body)}` : ''}`, { code: 'HTTP', details: body });
  }
  return { result: true, id: (body && body.id) || null };
}

/**
 * Перевіряє ключ (GET /user/info). Повертає дані акаунта або кидає SendPulseError.
 * Корисно викликати при старті / з CLI, щоб відразу побачити неправильний ключ.
 */
async function verifyAuth() {
  const cfg = requireConfig({ needFrom: false });
  const data = await request('GET', '/user/info', cfg);
  return { ok: true, user: data };
}

module.exports = { sendEmail, verifyAuth, isConfigured, SendPulseError };
