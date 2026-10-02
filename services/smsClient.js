const axios = require('axios');

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

async function sendSms(phone, text) {
  if (!isConfigured()) {
    console.warn('[sms] SMS_API_KEY/SMS_SENDER not configured — skipping SMS to', phone);
    return { sent: false, reason: 'not_configured' };
  }

  const to = normalizePhone(phone);
  if (!to) {
    console.error('[sms] invalid phone number:', phone);
    return { sent: false, reason: 'invalid_phone' };
  }

  console.log('[sms] відправка на', maskPhone(to));
  try {
    const response = await axios.post(
      process.env.SMS_API_URL || DEFAULT_API_URL,
      {
        auth: getKey(),
        data: [
          {
            type: 'sms',
            id: nextMessageId(),
            phone: Number(to),
            sms_signature: process.env.SMS_SENDER,
            sms_message: text,
          },
        ],
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    const result = parseResponse(response.data);
    if (!result.ok) {
      console.error('[sms] gateway error:', result.error, '| відповідь шлюзу:', shortBody(response.data));
      return { sent: false, reason: 'api_error', detail: result.error };
    }
    console.log('[sms] прийнято шлюзом, id =', result.id);
    return { sent: true, id: result.id };
  } catch (err) {
    const status = err.response?.status ? `HTTP ${err.response.status}` : 'без відповіді';
    console.error('[sms] send failed:', status, '|', err.message, '|', shortBody(err.response?.data));
    return { sent: false, reason: 'api_error' };
  }
}

module.exports = { sendSms, isConfigured, normalizePhone, parseResponse };
