const nodemailer = require('nodemailer');

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

// Sends an email via SMTP. Does nothing until SMTP_HOST/SMTP_USER/SMTP_PASS
// are configured — e.g. with a free transactional provider (Brevo,
// SendGrid) or even a Gmail account with an app password.
async function sendEmail(to, subject, text) {
  const t = getTransporter();
  if (!t) {
    console.warn('[email] SMTP not configured — skipping email to', to);
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
