const express = require('express');
const router = express.Router();

// GET /api/config — public, non-sensitive site config for the frontend
// (e.g. a link to join the customer Telegram bot for order updates).
router.get('/', (req, res) => {
  res.json({
    customerBotUrl: process.env.TELEGRAM_CUSTOMER_BOT_URL || null,
  });
});

module.exports = router;
