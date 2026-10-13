const axios = require('axios');
const { sendEmail } = require('./emailClient');
const { SHOP_NAME } = require('./brand');

// ---------------------------------------------------------------------------
// Сповіщення власнику про важливі події: помилки сервера, блокування акаунтів, входи з нових
// пристроїв, скидання 2FA. Канали (кожен вмикається своїми змінними, можна кілька разів):
//   • Telegram:  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  (бот від @BotFather)
//   • Webhook:   ALERT_WEBHOOK_URL  (Slack/Discord/Make/Zapier — POST JSON { text })
//   • Email:     ALERT_EMAIL (або ADMIN_EMAIL), якщо налаштовано SendPulse/SMTP
// Функція НІКОЛИ не кидає помилку: збій сповіщення не повинен ламати основну операцію.
// ---------------------------------------------------------------------------

const lastSent = new Map();   // dedupeKey -> timestamp, щоб не засипати повідомленнями

function channels() {
  return {
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    webhook: Boolean(process.env.ALERT_WEBHOOK_URL),
    email: Boolean(process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL),
  };
}

async function sendAlert({ title, text, dedupeKey = null, dedupeMinutes = 60, email = true }) {
  try {
    if (dedupeKey) {
      const prev = lastSent.get(dedupeKey);
      if (prev && Date.now() - prev < dedupeMinutes * 60 * 1000) return { skipped: 'dedupe' };
      lastSent.set(dedupeKey, Date.now());
    }
    const message = `🔔 ${SHOP_NAME}: ${title}\n\n${text}`.slice(0, 3500);
    const used = [];
    const jobs = [];

    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      jobs.push(axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        { chat_id: process.env.TELEGRAM_CHAT_ID, text: message, disable_web_page_preview: true }, { timeout: 5000 })
        .then(() => used.push('telegram')).catch((e) => console.error('[alert] telegram:', e.message)));
    }
    if (process.env.ALERT_WEBHOOK_URL) {
      jobs.push(axios.post(process.env.ALERT_WEBHOOK_URL, { text: message, content: message }, { timeout: 5000 })
        .then(() => used.push('webhook')).catch((e) => console.error('[alert] webhook:', e.message)));
    }
    const to = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL;
    if (email && to) {
      jobs.push(sendEmail(to, `${SHOP_NAME}: ${title}`, text)
        .then((r) => { if (r && r.sent) used.push('email'); }).catch((e) => console.error('[alert] email:', e.message)));
    }
    await Promise.all(jobs);
    return { sent: used };
  } catch (err) {
    console.error('[alert] помилка сповіщення:', err.message);
    return { sent: [] };
  }
}

module.exports = { sendAlert, channels };
