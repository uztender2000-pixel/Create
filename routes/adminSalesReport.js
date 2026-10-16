const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('stats'));

// GET /api/admin/sales-report?days=30 — звіт продажів за період (7 / 30 / 90 / 365 діб) у порівнянні з попереднім
// періодом такої самої тривалості. Виручка й прибуток рахуються за цінами, збереженими в самому замовленні
// (unit_price / cost_price), тому зміни прайсів постачальників не «переписують» минулі продажі.
// «Замовлення» = оформлення (група позицій одного кошика), «позиції» = окремі товарні рядки.
router.get('/', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 730);
    const bucket = days > 92 ? 'week' : 'day';   // довгі періоди групуємо по тижнях, щоб графік був читабельним

    const base = `
      WITH o AS (
        SELECT o.*, COALESCE(o.group_id::text, o.id::text) AS chk,
               o.quantity * COALESCE(o.unit_price, 0) AS rev,
               o.quantity * (COALESCE(o.unit_price, 0) - COALESCE(o.cost_price, 0)) AS prof,
               (o.created_at >= now() - make_interval(days => $1)) AS cur,
               (o.created_at >= now() - make_interval(days => $1 * 2) AND o.created_at < now() - make_interval(days => $1)) AS prev
          FROM orders o
         WHERE o.created_at >= now() - make_interval(days => $1 * 2)
      )`;

    const [kpi, users, repeat, series, status, topProducts, bySupplier] = await Promise.all([
      pool.query(`${base}
        SELECT COUNT(DISTINCT chk) FILTER (WHERE cur)::int AS checkouts_cur, COUNT(DISTINCT chk) FILTER (WHERE prev)::int AS checkouts_prev,
               COALESCE(SUM(quantity) FILTER (WHERE cur), 0)::int AS units_cur, COALESCE(SUM(quantity) FILTER (WHERE prev), 0)::int AS units_prev,
               COALESCE(SUM(rev) FILTER (WHERE cur), 0)::float AS revenue_cur, COALESCE(SUM(rev) FILTER (WHERE prev), 0)::float AS revenue_prev,
               COALESCE(SUM(prof) FILTER (WHERE cur), 0)::float AS profit_cur, COALESCE(SUM(prof) FILTER (WHERE prev), 0)::float AS profit_prev,
               COUNT(DISTINCT user_id) FILTER (WHERE cur AND user_id IS NOT NULL)::int AS buyers_cur,
               COUNT(DISTINCT user_id) FILTER (WHERE prev AND user_id IS NOT NULL)::int AS buyers_prev
          FROM o`, [days]),
      pool.query(`SELECT COUNT(*) FILTER (WHERE created_at >= now() - make_interval(days => $1))::int AS new_cur,
                         COUNT(*) FILTER (WHERE created_at >= now() - make_interval(days => $1 * 2) AND created_at < now() - make_interval(days => $1))::int AS new_prev
                    FROM users`, [days]),
      // повторні покупці: ті, хто купував у періоді й має щонайменше 2 оформлення за весь час
      pool.query(`${base}
        SELECT COUNT(*)::int AS repeat_buyers FROM (
          SELECT DISTINCT user_id FROM o WHERE cur AND user_id IS NOT NULL
        ) b WHERE (SELECT COUNT(DISTINCT COALESCE(group_id::text, id::text)) FROM orders WHERE user_id = b.user_id) >= 2`, [days]),
      pool.query(`${base}
        SELECT to_char(s.b, 'YYYY-MM-DD') AS day, COALESCE(x.checkouts, 0)::int AS checkouts,
               COALESCE(x.revenue, 0)::float AS revenue, COALESCE(x.profit, 0)::float AS profit
          FROM generate_series(date_trunc('${bucket}', (now() AT TIME ZONE 'Europe/Kyiv') - make_interval(days => $1 - 1)),
                               date_trunc('${bucket}', now() AT TIME ZONE 'Europe/Kyiv'), interval '1 ${bucket}') AS s(b)
          LEFT JOIN (
            SELECT date_trunc('${bucket}', created_at AT TIME ZONE 'Europe/Kyiv') AS d, COUNT(DISTINCT chk) AS checkouts, SUM(rev) AS revenue, SUM(prof) AS profit
              FROM o WHERE cur GROUP BY 1
          ) x ON x.d = s.b
         ORDER BY s.b`, [days]),
      pool.query(`${base} SELECT status, COUNT(*)::int AS count FROM o WHERE cur GROUP BY status ORDER BY count DESC`, [days]),
      pool.query(`${base}
        SELECT COALESCE(p.name, 'Видалений товар') AS name, SUM(o.quantity)::int AS units, SUM(o.rev)::float AS revenue, SUM(o.prof)::float AS profit
          FROM o LEFT JOIN products p ON p.id = o.product_id WHERE o.cur
         GROUP BY o.product_id, p.name ORDER BY profit DESC NULLS LAST LIMIT 10`, [days]),
      pool.query(`${base}
        SELECT COALESCE(s.name, '—') AS name, COUNT(DISTINCT o.chk)::int AS checkouts, SUM(o.rev)::float AS revenue, SUM(o.prof)::float AS profit
          FROM o LEFT JOIN suppliers s ON s.id = o.supplier_id WHERE o.cur
         GROUP BY s.name ORDER BY revenue DESC`, [days]),
    ]);

    const k = kpi.rows[0];
    const avg = (rev, n) => (n ? rev / n : 0);
    res.set('Cache-Control', 'no-store');
    res.json({
      days, bucket,
      kpi: {
        checkouts: { cur: k.checkouts_cur, prev: k.checkouts_prev },
        units: { cur: k.units_cur, prev: k.units_prev },
        revenue: { cur: k.revenue_cur, prev: k.revenue_prev },
        profit: { cur: k.profit_cur, prev: k.profit_prev },
        avg_check: { cur: avg(k.revenue_cur, k.checkouts_cur), prev: avg(k.revenue_prev, k.checkouts_prev) },
        margin_pct: { cur: k.revenue_cur ? (k.profit_cur / k.revenue_cur) * 100 : 0, prev: k.revenue_prev ? (k.profit_prev / k.revenue_prev) * 100 : 0 },
        buyers: { cur: k.buyers_cur, prev: k.buyers_prev },
        new_customers: { cur: users.rows[0].new_cur, prev: users.rows[0].new_prev },
        repeat_buyers: { cur: repeat.rows[0].repeat_buyers, prev: null },
      },
      series: series.rows,
      byStatus: status.rows,
      topProducts: topProducts.rows,
      bySupplier: bySupplier.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося підготувати звіт' });
  }
});

module.exports = router;
