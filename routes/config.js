const express = require('express');
const router = express.Router();
const { cookieSessionsEnabled } = require('../services/security');

// GET /api/config — public, non-sensitive site config for the frontend
// (e.g. a link to join the customer Telegram bot for order updates).
router.get('/', (req, res) => {
  res.json({
    customerBotUrl: process.env.TELEGRAM_CUSTOMER_BOT_URL || null,
    // The "seller" shown on a product card for shop_ships suppliers (see
    // suppliers.fulfillment_type) — we're the seller of record for those,
    // so the customer sees our own shop rather than the wholesaler behind it.
    shopName: process.env.SHOP_NAME || 'В Хату.UA',
    // Віджет чату з ШІ-помічником показуємо лише тоді, коли на сервері задано ключ Anthropic API.
    assistantEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    // Фронтенд за цим прапорцем вирішує, чи працювати з httpOnly-cookie (і слати credentials) та чи показувати капчу.
    cookieSessions: cookieSessionsEnabled(),
    turnstileSiteKey: process.env.TURNSTILE_SECRET ? (process.env.TURNSTILE_SITE_KEY || null) : null,
  });
});

module.exports = router;
