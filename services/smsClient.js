const axios = require('axios');

// Sends an SMS via TurboSMS (popular Ukrainian SMS gateway — turbosms.ua).
// Does nothing until SMS_API_TOKEN and SMS_SENDER are configured, same
// no-op-until-configured pattern as the Nova Poshta and supplier clients.
async function sendSms(phone, text) {
  const token = process.env.SMS_API_TOKEN;
  const sender = process.env.SMS_SENDER;

  if (!token || !sender) {
    console.warn('[sms] SMS_API_TOKEN/SMS_SENDER not configured — skipping SMS to', phone);
    return { sent: false, reason: 'not_configured' };
  }

  try {
    await axios.post(
      'https://api.turbosms.ua/message/send.json',
      { recipients: [phone], sms: { sender, text } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    return { sent: true };
  } catch (err) {
    console.error('[sms] send failed:', err.response?.data || err.message);
    return { sent: false, reason: 'api_error' };
  }
}

module.exports = { sendSms };
