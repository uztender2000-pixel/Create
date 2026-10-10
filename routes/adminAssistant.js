const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');
const { isEnabled, model, dailyLimit } = require('../services/assistant');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('settings'));

// Орієнтовні ціни, USD за мільйон токенів: [вхідні, вихідні]. Можна перевизначити змінними
// ASSISTANT_PRICE_IN / ASSISTANT_PRICE_OUT, якщо ціни чи модель змінились.
const PRICES = {
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-4-5-20251001': [1, 5],
};

function priceFor(modelName) {
  const envIn = parseFloat(process.env.ASSISTANT_PRICE_IN);
  const envOut = parseFloat(process.env.ASSISTANT_PRICE_OUT);
  if (Number.isFinite(envIn) && Number.isFinite(envOut)) return [envIn, envOut];
  return PRICES[modelName] || null;
}

// GET /api/admin/assistant/usage — використання ШІ-помічника: сьогодні, 7 і 30 днів, орієнтовні витрати.
// Витрати — оцінка за кількістю токенів без урахування знижок кешування; точні суми — у console.anthropic.com.
router.get('/usage', async (req, res) => {
  try {
    const { rows: [r] } = await pool.query(`
      SELECT
        COALESCE(SUM(requests)      FILTER (WHERE day = CURRENT_DATE), 0)::int      AS req_today,
        COALESCE(SUM(input_tokens)  FILTER (WHERE day = CURRENT_DATE), 0)::bigint   AS in_today,
        COALESCE(SUM(output_tokens) FILTER (WHERE day = CURRENT_DATE), 0)::bigint   AS out_today,
        COALESCE(SUM(requests)      FILTER (WHERE day >= CURRENT_DATE - 6), 0)::int AS req_7d,
        COALESCE(SUM(requests)      FILTER (WHERE day >= CURRENT_DATE - 29), 0)::int AS req_30d,
        COALESCE(SUM(input_tokens)  FILTER (WHERE day >= CURRENT_DATE - 29), 0)::bigint AS in_30d,
        COALESCE(SUM(output_tokens) FILTER (WHERE day >= CURRENT_DATE - 29), 0)::bigint AS out_30d
      FROM assistant_usage
    `);
    const modelName = model();
    const price = priceFor(modelName);
    const cost = (inTok, outTok) => (price ? Math.round(((Number(inTok) * price[0] + Number(outTok) * price[1]) / 1e6) * 100) / 100 : null);

    res.json({
      enabled: isEnabled(),
      model: modelName,
      dailyLimit: dailyLimit(),
      today: { requests: r.req_today, cost_usd: cost(r.in_today, r.out_today) },
      last7: { requests: r.req_7d },
      last30: { requests: r.req_30d, input_tokens: Number(r.in_30d), output_tokens: Number(r.out_30d), cost_usd: cost(r.in_30d, r.out_30d) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити використання помічника' });
  }
});

module.exports = router;
