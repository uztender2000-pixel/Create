const axios = require('axios');

// Захист від ботів: Cloudflare Turnstile (безкоштовно, без «виберіть світлофори»).
// Вмикається змінними TURNSTILE_SECRET (на сервері) і TURNSTILE_SITE_KEY (віддається фронтенду
// через /api/config). Якщо секрет не задано — перевірка пропускається, і сайт працює як раніше.
const VERIFY_URL = process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function requireCaptcha(req, res, next) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return next();

  const token = req.body && typeof req.body.captchaToken === 'string' ? req.body.captchaToken : '';
  if (!token) return res.status(400).json({ error: 'Підтвердіть, що ви не робот', captchaRequired: true });

  try {
    const { data } = await axios.post(
      VERIFY_URL,
      new URLSearchParams({ secret, response: token, remoteip: req.ip || '' }).toString(),
      { timeout: 5000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (data && data.success) return next();
    return res.status(400).json({ error: 'Перевірку «я не робот» не пройдено. Спробуйте ще раз', captchaRequired: true });
  } catch (err) {
    // Якщо сервіс перевірки недоступний — краще відмовити, ніж пропустити ботів.
    console.error('[captcha] сервіс перевірки недоступний:', err.message);
    return res.status(503).json({ error: 'Не вдалося перевірити захист від ботів. Спробуйте за хвилину', captchaRequired: true });
  }
}

module.exports = { requireCaptcha };
