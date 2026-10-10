const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const { chat, isEnabled, AssistantError } = require('../services/assistant');

const router = express.Router();

// POST /api/assistant/chat — { messages: [{role, content}], productId? }
// Відповідь: { reply, cards: [{id, name, price, picture_url}], ticketCreated }
// Доступний і гостям (помічник відповідає на питання про каталог), а замовлення та звернення — лише авторизованим.
router.post('/chat', optionalAuth, async (req, res) => {
  if (!isEnabled()) return res.status(503).json({ error: 'Помічник тимчасово недоступний' });
  const { messages, productId } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
    return res.status(400).json({ error: 'Некоректний запит' });
  }
  try {
    const out = await chat({ messages, user: req.user || null, productId });
    res.json(out);
  } catch (err) {
    if (err instanceof AssistantError) {
      const text = err.code === 'limit' ? 'Помічник сьогодні дуже завантажений. Спробуйте завтра або напишіть нам через форму.'
        : err.code === 'bad_request' ? 'Напишіть повідомлення'
        : 'Помічник тимчасово недоступний. Спробуйте за хвилину або напишіть нам через форму.';
      return res.status(err.status).json({ error: text, code: err.code });
    }
    console.error(err);
    res.status(500).json({ error: 'Помічник тимчасово недоступний' });
  }
});

module.exports = router;
