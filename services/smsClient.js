const axios = require('axios');
const { pool } = require('../db');

// Відправка SMS через AlphaSMS (alphasms.ua) — JSON API.
// Документація: https://docs.alphasms.ua/ (розділ JSON API → Відправка SMS)
//
// Змінні середовища:
//   SMS_API_KEY — API-ключ з особистого кабінету AlphaSMS
//   SMS_SENDER  — альфа-ім'я відправника (латиниця/цифри, до 11 символів)
//   SMS_API_URL — (необов'язково) адреса API. За замовчуванням
//                 https://alphasms.ua/api/json.php
//
// Поки ключ і ім'я відправника не задані — клієнт нічого не відправляє
// (no-op), щоб сервер не падав на середовищах без SMS.

const DEFAULT_API_URL = 'https://alphasms.ua/api/json.php';

const getKey = () => process.env.SMS_API_KEY || process.env.SMS_API_TOKEN;

// Один рядок у логах при старті сервера: видно, чи підхопились змінні (самі значення ключа не логуються).
console.log(
  `[sms] AlphaSMS: ключ ${getKey() ? 'задано' : 'НЕ ЗАДАНО'}, відправник ${process.env.SMS_SENDER ? `"${process.env.SMS_SENDER}"` : 'НЕ ЗАДАНО'}, адреса ${process.env.SMS_API_URL || DEFAULT_API_URL}`
);

const shortBody = (data) => {
  if (data === undefined || data === null) return '';
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return text.replace(/\s+/g, ' ').slice(0, 300);
};
const maskPhone = (to) => `***${String(to).slice(-4)}`;

// Приводить номер до міжнародного формату 380XXXXXXXXX.
// Приймає: +380501234567, 380501234567, 0501234567, 80501234567,
// а також номери з пробілами, дужками й дефісами.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('380')) return digits;
  if (digits.length === 11 && digits.startsWith('80')) return `3${digits}`;
  if (digits.length === 10 && digits.startsWith('0')) return `38${digits}`;
  if (digits.length === 9) return `380${digits}`;
  return null;
}

// Унікальний числовий id повідомлення в нашій системі (обов'язкове поле API).
// Вкладаємось у 32-бітне ціле: час із кроком 100 мс (повтор — не раніше ніж
// через ~6.8 року), а в межах одного процесу id завжди строго зростає.
let lastId = 0;
function nextMessageId() {
  let id = Math.floor(Date.now() / 100) % 2147483647;
  if (id <= lastId) id = lastId + 1;
  lastId = id;
  return id;
}

// Розбір відповіді шлюзу. Успіх:
//   { success: true, data: [ { success: true, data: { id, msg_id, parts } } ] }
// Помилка запиту:        { success: false, error: "Access denied" }
// Помилка по повідомленню: data[0].success === false, data[0].error
function parseResponse(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'empty or non-JSON response' };
  }
  if (body.success === false) {
    return { ok: false, error: body.error || 'request failed' };
  }
  const item = Array.isArray(body.data) ? body.data[0] : null;
  if (!item) return { ok: false, error: 'no result in response' };
  if (item.success === false) return { ok: false, error: item.error || 'message rejected' };
  return { ok: true, id: item.data?.msg_id, parts: item.data?.parts };
}

// true, якщо SMS-шлюз налаштований (є ключ і ім'я відправника).
function isConfigured() {
  return Boolean(getKey() && process.env.SMS_SENDER);
}

// Код підтвердження в тексті не зберігаємо в журналі: адміністратор бачить, що саме
// відправлялось, але не може підгледіти чужий код входу.
function maskCodes(text) {
  return String(text || '').replace(/\d{4,8}/g, '••••••');
}

// ---- Допоміжні запити до AlphaSMS (для адмін-сторінки «SMS») ----
const apiUrl = () => process.env.SMS_API_URL || DEFAULT_API_URL;

async function jsonCall(dataItems) {
  const key = getKey();
  if (!key) throw new Error('SMS_API_KEY не задано');
  const res = await axios.post(
    apiUrl(),
    { auth: key, data: dataItems },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  const body = res.data;
  if (!body || body.success === false) throw new Error((body && body.error) || 'порожня відповідь шлюзу');
  return body.data || [];
}

// Залишок на рахунку: { amount, currency }.
async function getBalance() {
  const [item] = await jsonCall([{ type: 'balance' }]);
  if (!item || item.success === false) throw new Error((item && item.error) || 'не вдалося отримати баланс');
  return { amount: Number(item.data.amount), currency: item.data.currency || 'UAH' };
}

// Статуси доставки за нашими id: Map(clientId -> { status, updated }).
async function getStatuses(clientIds) {
  const out = new Map();
  if (!clientIds.length) return out;
  const items = await jsonCall(clientIds.map((id) => ({ type: 'status', id: Number(id) })));
  for (const it of items) {
    if (it && it.success !== false && it.data && it.data.id !== undefined) {
      out.set(String(it.data.id), { status: it.data.status, updated: it.data.updated });
    }
  }
  return out;
}

// Ціна однієї частини SMS на номер (HTTP API, відповідь «price:1.2 currency:UAH»).
// Кешуємо за префіксом номера (код оператора) на добу — щоб не робити зайвих запитів.
const priceCache = new Map();
async function getPrice(phone) {
  const to = normalizePhone(phone);
  const key = getKey();
  if (!to || !key) return null;
  const prefix = to.slice(0, 5);
  const hit = priceCache.get(prefix);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.value;
  const base = apiUrl().replace(/json\.php$/, 'http.php');
  const res = await axios.get(base, {
    params: { version: 'http', key, command: 'price', to },
    timeout: 10000,
    responseType: 'text',
    transformResponse: (r) => r,
  });
  const m = String(res.data).match(/price:\s*([\d.,]+)\s+currency:\s*(\w+)/i);
  if (!m) return null;
  const value = { price: Number(m[1].replace(',', '.')), currency: m[2] };
  priceCache.set(prefix, { at: Date.now(), value });
  return value;
}

// Записує спробу відправки в sms_log (помилки журналу ніколи не ламають відправку).
async function logSms({ meta, phone, text, result, clientId, parts }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO sms_log (user_id, purpose, phone, text, sent, error, client_id, gateway_id, parts, delivery_status, status_updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()) RETURNING id`,
      [
        meta.userId || null, meta.purpose || null, normalizePhone(phone) || String(phone), maskCodes(text),
        Boolean(result.sent), result.sent ? null : (result.detail || result.reason || 'error'),
        clientId || null, result.id ? String(result.id) : null, parts || null,
        result.sent ? 'ACCEPTED' : 'NOT_SENT',
      ]
    );
    // Ціну підтягуємо у фоні — на швидкість відповіді користувачу не впливає.
    if (result.sent) {
      getPrice(phone).then((p) => p && pool.query('UPDATE sms_log SET price = $1, currency = $2 WHERE id = $3', [p.price, p.currency, rows[0].id]))
        .catch((e) => console.error('[sms] не вдалося отримати ціну:', e.message));
    }
  } catch (err) {
    console.error('[sms] не вдалося записати в журнал:', err.message);
  }
}

// meta (необов'язково): { purpose: 'phone_code', userId: 12 } — лише для журналу.
async function sendSms(phone, text, meta = {}) {
  if (!isConfigured()) {
    console.warn('[sms] SMS_API_KEY/SMS_SENDER not configured — skipping SMS to', phone);
    return { sent: false, reason: 'not_configured' };
  }

  const to = normalizePhone(phone);
  if (!to) {
    console.error('[sms] invalid phone number:', phone);
    const result = { sent: false, reason: 'invalid_phone' };
    await logSms({ meta, phone, text, result });
    return result;
  }

  const clientId = nextMessageId();
  console.log('[sms] відправка на', maskPhone(to));
  let result; let parts;
  try {
    const response = await axios.post(
      apiUrl(),
      {
        auth: getKey(),
        data: [
          {
            type: 'sms',
            id: clientId,
            phone: Number(to),
            sms_signature: process.env.SMS_SENDER,
            sms_message: text,
          },
        ],
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    const parsed = parseResponse(response.data);
    if (!parsed.ok) {
      console.error('[sms] gateway error:', parsed.error, '| відповідь шлюзу:', shortBody(response.data));
      result = { sent: false, reason: 'api_error', detail: parsed.error };
    } else {
      console.log('[sms] прийнято шлюзом, id =', parsed.id);
      result = { sent: true, id: parsed.id };
      parts = parsed.parts;
    }
  } catch (err) {
    const status = err.response?.status ? `HTTP ${err.response.status}` : 'без відповіді';
    console.error('[sms] send failed:', status, '|', err.message, '|', shortBody(err.response?.data));
    result = { sent: false, reason: 'api_error', detail: `${status}: ${err.message}` };
  }

  await logSms({ meta, phone, text, result, clientId, parts });
  return result;
}

module.exports = { sendSms, isConfigured, normalizePhone, parseResponse, getBalance, getStatuses, getPrice, maskCodes };
