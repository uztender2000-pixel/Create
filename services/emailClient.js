const nodemailer = require('nodemailer');
const sendpulse = require('./sendpulseClient');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: SMTP_PORT === '465',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Текстовий лист → простий HTML (абзаци й переноси рядків зберігаються).
const textToHtml = (text) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;">${
  escapeHtml(text).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}</div>`;

// Sends an email. Provider order:
//   1) SendPulse API — якщо задані SENDPULSE_API_KEY і SENDPULSE_API_FROM_EMAIL;
//   2) SMTP — якщо задані SMTP_HOST/SMTP_USER/SMTP_PASS (e.g. Brevo, SendGrid,
//      Gmail із app password);
//   3) інакше нічого не робить і повертає reason: 'not_configured'.
// Результат: { sent: boolean, reason?: 'not_configured' | 'rate_limited' | 'api_error' }.
async function sendEmail(to, subject, text) {
  if (sendpulse.isConfigured()) {
    try {
      await sendpulse.sendEmail({ to, subject, text, html: textToHtml(text) });
      return { sent: true, provider: 'sendpulse' };
    } catch (err) {
      console.error('[email] SendPulse:', err.message);
      return { sent: false, reason: err.code === 'RATE_LIMITED' ? 'rate_limited' : 'api_error', detail: err.message };
    }
  }

  const t = getTransporter();
  if (!t) {
    console.warn('[email] ні SendPulse, ні SMTP не налаштовано — лист не надіслано:', to);
    return { sent: false, reason: 'not_configured' };
  }
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return { sent: true };
  } catch (err) {
    console.error('[email] send failed:', err.message);
    return { sent: false, reason: 'api_error' };
  }
}

module.exports = { sendEmail };
