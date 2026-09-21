const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('stats'));

// GET /api/admin/stats — headline numbers, a 30-day chart, and a
// per-supplier breakdown.
//
// Revenue and profit now come from the prices stored on the order itself
// (unit_price / cost_price), not from the product's current price. That
// matters with several suppliers repricing on their own schedules: last
// month's profit shouldn't change because BRAIN raised a price today.
router.get('/', async (req, res) => {
  try {
    const [totals, byStatus, last30days, topProducts, bySupplier, syncHealth] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM orders) AS total_orders,
          (SELECT COUNT(DISTINCT group_id)::int FROM orders WHERE group_id IS NOT NULL) AS total_checkouts,
          (SELECT COUNT(*)::int FROM orders WHERE created_at >= now() - interval '1 day') AS orders_today,
          (SELECT COUNT(*)::int FROM users) AS total_users,
          (SELECT COUNT(*)::int FROM products p JOIN suppliers s ON s.id = p.supplier_id
            WHERE p.available = true AND s.active = true) AS total_products,
          (SELECT COUNT(*)::int FROM suppliers WHERE active = true) AS active_suppliers,
          (SELECT COALESCE(SUM(quantity * COALESCE(unit_price, 0)), 0) FROM orders) AS total_revenue,
          (SELECT COALESCE(SUM(quantity * (COALESCE(unit_price, 0) - COALESCE(cost_price, 0))), 0) FROM orders) AS total_profit,
          (SELECT COUNT(*)::int FROM orders WHERE supplier_status = 'failed') AS failed_submissions
      `),
      pool.query(`SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status`),
      pool.query(`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS count,
               COALESCE(SUM(quantity * COALESCE(unit_price, 0)), 0) AS revenue
          FROM orders
         WHERE created_at >= now() - interval '30 days'
         GROUP BY day ORDER BY day ASC
      `),
      pool.query(`
        SELECT p.name, s.name AS supplier_name, COUNT(*)::int AS order_count
          FROM orders o
          JOIN products p ON p.id = o.product_id
          LEFT JOIN suppliers s ON s.id = o.supplier_id
         GROUP BY p.name, s.name ORDER BY order_count DESC LIMIT 10
      `),
      pool.query(`
        SELECT s.id, s.name, s.code,
               COUNT(o.id)::int AS order_count,
               COALESCE(SUM(o.quantity * COALESCE(o.unit_price, 0)), 0) AS revenue,
               COALESCE(SUM(o.quantity * (COALESCE(o.unit_price, 0) - COALESCE(o.cost_price, 0))), 0) AS profit
          FROM suppliers s
          LEFT JOIN orders o ON o.supplier_id = s.id
         GROUP BY s.id, s.name, s.code
         ORDER BY revenue DESC
      `),
      pool.query(`
        SELECT id, name, active, last_sync_at, last_sync_status, last_sync_message,
               (SELECT COUNT(*)::int FROM products WHERE supplier_id = suppliers.id AND available = true) AS available_products
          FROM suppliers ORDER BY sort_order, id
      `),
    ]);

    res.json({
      totals: totals.rows[0],
      byStatus: byStatus.rows,
      last30Days: last30days.rows,
      topProducts: topProducts.rows,
      bySupplier: bySupplier.rows,
      suppliers: syncHealth.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

module.exports = router;
