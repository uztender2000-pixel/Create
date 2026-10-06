const express = require('express');
const axios = require('axios');
const { pool } = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

const MAX_TEXT = 2000;
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|ua|ru|info|biz|xyz|top)\b)/i;

// «Іван Петренко» → «Іван П.»: повне прізвище покупця на сторінці товару не показуємо.
function publicName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Покупець';
  const first = parts[0].slice(0, 30);
  return parts[1] ? `${first} ${parts[1][0].toUpperCase()}.` : first;
}

// Прибираємо керівні символи й зайві пробіли; HTML тут не чистимо — його екранує фронтенд при показі.
function cleanText(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Покупка підтверджена, якщо в користувача є відправлене чи виконане замовлення цього товару.
async function hasPurchased(userId, productId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM orders WHERE user_id = $1 AND product_id = $2 AND status IN ('shipped', 'done') LIMIT 1`,
    [userId, productId]
  );
  return rows.length > 0;
}

// Повідомлення в Telegram про відгук, що чекає модерації (як і сповіщення про замовлення).
function notifyPending({ productName, rating, text, author }) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const msg = `⭐ Новий відгук на модерацію\nТовар: ${productName}\nАвтор: ${author}\nОцінка: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}\n${text ? `Текст: ${text.slice(0, 300)}` : '(без тексту)'}`;
  axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: msg }).catch(() => {});
}

// GET /api/reviews/product/:productId?page=1&limit=10
// Публічні відгуки + підсумок оцінок. Для авторизованого користувача додатково повертає
// його власний відгук (навіть якщо він ще на модерації) і чи можна йому писати відгук.
router.get('/product/:productId', optionalAuth, async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: 'Некоректний товар' });
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

    const { rows: [sum] } = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(ROUND(AVG(rating)::numeric, 1), 0)::float AS average,
              COUNT(*) FILTER (WHERE rating = 1)::int AS r1, COUNT(*) FILTER (WHERE rating = 2)::int AS r2,
              COUNT(*) FILTER (WHERE rating = 3)::int AS r3, COUNT(*) FILTER (WHERE rating = 4)::int AS r4,
              COUNT(*) FILTER (WHERE rating = 5)::int AS r5
         FROM product_reviews WHERE product_id = $1 AND status = 'published'`,
      [productId]
    );

    const { rows: reviews } = await pool.query(
      `SELECT id, author_name AS author, rating, text, verified_purchase AS verified,
              admin_reply AS reply, admin_reply_at AS reply_at, created_at
         FROM product_reviews
        WHERE product_id = $1 AND status = 'published'
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [productId, limit, (page - 1) * limit]
    );

    let mine = null;
    let canReview = false;
    if (req.user) {
      const { rows } = await pool.query(
        `SELECT id, rating, text, status, verified_purchase AS verified, created_at, updated_at, admin_reply AS reply
           FROM product_reviews WHERE product_id = $1 AND user_id = $2`,
        [productId, req.user.id]
      );
      mine = rows[0] || null;
      canReview = true;
    }

    res.json({
      summary: {
        count: sum.count, average: sum.average,
        distribution: { 1: sum.r1, 2: sum.r2, 3: sum.r3, 4: sum.r4, 5: sum.r5 },
      },
      reviews,
      pagination: { page, limit, total: sum.count, hasMore: page * limit < sum.count },
      mine,
      canReview,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити відгуки' });
  }
});

// POST /api/reviews/product/:productId — { rating: 1..5, text? }
// Створює відгук або оновлює власний (один на товар). Відгук покупця публікується одразу,
// інші чекають модерації. Приховані адміном відгуки редагуванням не повертаються у видачу.
router.post('/product/:productId', requireAuth, async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: 'Некоректний товар' });

    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Поставте оцінку від 1 до 5 зірок' });
    }
    const text = cleanText(req.body.text);
    if (text.length > MAX_TEXT) return res.status(400).json({ error: `Відгук задовгий (максимум ${MAX_TEXT} символів)` });
    if (text && text.length < 5) return res.status(400).json({ error: 'Напишіть хоча б кілька слів або залиште поле порожнім' });
    if (URL_RE.test(text)) return res.status(400).json({ error: 'У відгуках не можна залишати посилання' });

    const { rows: prod } = await pool.query('SELECT id, name FROM products WHERE id = $1', [productId]);
    if (!prod.length) return res.status(404).json({ error: 'Товар не знайдено' });

    const { rows: users } = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    if (!users.length) return res.status(401).json({ error: 'Користувача не знайдено' });

    const verified = await hasPurchased(req.user.id, productId);
    const { rows: existing } = await pool.query(
      'SELECT id, status FROM product_reviews WHERE product_id = $1 AND user_id = $2',
      [productId, req.user.id]
    );

    // hidden лишається hidden; решта: покупець → published, інші → pending
    const status = existing[0] && existing[0].status === 'hidden' ? 'hidden' : (verified ? 'published' : 'pending');
    const author = publicName(users[0].name);

    const { rows } = await pool.query(
      `INSERT INTO product_reviews (product_id, user_id, rating, text, author_name, verified_purchase, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (product_id, user_id) DO UPDATE
         SET rating = EXCLUDED.rating, text = EXCLUDED.text, author_name = EXCLUDED.author_name,
             verified_purchase = EXCLUDED.verified_purchase, status = EXCLUDED.status, updated_at = now()
       RETURNING id, rating, text, status, verified_purchase AS verified, created_at, updated_at`,
      [productId, req.user.id, rating, text || null, author, verified, status]
    );

    if (status === 'pending') notifyPending({ productName: prod[0].name, rating, text, author });

    const message = status === 'published' ? 'Дякуємо за відгук! Його вже опубліковано.'
      : status === 'hidden' ? 'Відгук збережено, але його приховано модератором.'
      : 'Дякуємо! Відгук з\'явиться на сайті після перевірки.';
    res.status(existing.length ? 200 : 201).json({ review: rows[0], message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося зберегти відгук' });
  }
});

// DELETE /api/reviews/product/:productId — видалити власний відгук.
router.delete('/product/:productId', requireAuth, async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: 'Некоректний товар' });
    await pool.query('DELETE FROM product_reviews WHERE product_id = $1 AND user_id = $2', [productId, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося видалити відгук' });
  }
});

module.exports = router;
