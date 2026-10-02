const axios = require('axios');

// Відправка SMS через TurboSMS (turbosms.ua) — HTTP API.
// Документація: https://turbosms.ua/en/api.html
//
// Змінні середовища:
//   SMS_API_TOKEN — ключ авторизації (кабінет → API → «HTTP API»)
//   SMS_SENDER    — альфа-ім'я відправника, активоване у вашому акаунті
//   SMS_API_URL   — (необов'язково) адреса методу відправки. За замовчуванням
//                   https://api.turbosms.ua/message/send.json
//
// Поки SMS_API_TOKEN/SMS_SENDER не задані — клієнт нічого не відправляє
// (no-op), щоб сервер не падав на середовищах без SMS.

const DEFAULT_API_URL = 'https://api.turbosms.ua/message/send.json';

// Відповіді верхнього рівня, які означають, що запит прийнято
// (0 — OK, 800/801 — створено/відправлено, 802/803 — частково).
const OK_REQUEST_CODES = new Set([0, 800, 801, 802, 803]);

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

// Розбір відповіді. Приклад успіху:
//   { response_code: 800, response_status: "SUCCESS_MESSAGE_ACCEPTED",
//     response_result: [ { phone, response_code: 0, message_id: "…", response_status: "OK" } ] }
// Приклад помилки запиту: { response_code: 105, response_status: "REQUIRED_AUTH", ... }
// Помилка по отримувачу: response_result[0].response_code != 0 (message_id = null).
function parseResponse(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'empty or non-JSON response' };
  }
  if (!OK_REQUEST_CODES.has(Number(body.response_code))) {
    return { ok: false, error: `${body.response_status || 'ERROR'} (${body.response_code})` };
  }
  const item = Array.isArray(body.response_result) ? body.response_result[0] : null;
  if (!item) return { ok: false, error: 'no result in response' };
  if (Number(item.response_code) !== 0 || !item.message_id) {
    return { ok: false, error: `${item.response_status || 'ERROR'} (${item.response_code})` };
  }
  return { ok: true, id: item.message_id };
}

// true, якщо SMS-шлюз налаштований (є ключ і ім'я відправника).
function isConfigured() {
  return Boolean(process.env.SMS_API_TOKEN && process.env.SMS_SENDER);
}

async function sendSms(phone, text) {
  if (!isConfigured()) {
    console.warn('[sms] SMS_API_TOKEN/SMS_SENDER not configured — skipping SMS to', phone);
    return { sent: false, reason: 'not_configured' };
  }

  const to = normalizePhone(phone);
  if (!to) {
    console.error('[sms] invalid phone number:', phone);
    return { sent: false, reason: 'invalid_phone' };
  }

  try {
    // TurboSMS радить не ставити короткий таймаут на відправку: сервер
    // обробляє запит повністю, і повтор після обриву дасть дубль SMS.
    // Тому таймаут великий, а повторів ми не робимо.
    const response = await axios.post(
      process.env.SMS_API_URL || DEFAULT_API_URL,
      {
        recipients: [to],
        sms: { sender: process.env.SMS_SENDER, text },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.SMS_API_TOKEN}`,
        },
        timeout: 30000,
      }
    );

    const result = parseResponse(response.data);
    if (!result.ok) {
      console.error('[sms] gateway error:', result.error);
      return { sent: false, reason: 'api_error', detail: result.error };
    }
    return { sent: true, id: result.id };
  } catch (err) {
    console.error('[sms] send failed:', err.response?.data || err.message);
    return { sent: false, reason: 'api_error' };
  }
}

module.exports = { sendSms, isConfigured, normalizePhone, parseResponse };
