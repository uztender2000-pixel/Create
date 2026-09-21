const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('stats'));

// GET /api/admin/stats — headline numbers + a 30-day orders chart
router.get('/', async (req, res) => {
  try {
    const [totals, byStatus, last30days, topProducts] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM orders) AS total_orders,
          (SELECT COUNT(*)::int FROM orders WHERE created_at >= now() - interval '1 day') AS orders_today,
          (SELECT COUNT(*)::int FROM users) AS total_users,
          (SELECT COUNT(*)::int FROM products WHERE available = true) AS total_products,
          (SELECT COALESCE(SUM(o.quantity * p.retail_price), 0) FROM orders o JOIN products p ON p.id = o.product_id) AS total_revenue
      `),
      pool.query(`SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status`),
      pool.query(`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
        FROM orders
        WHERE created_at >= now() - interval '30 days'
        GROUP BY day ORDER BY day ASC
      `),
      pool.query(`
        SELECT p.name, COUNT(*)::int AS order_count
        FROM orders o JOIN products p ON p.id = o.product_id
        GROUP BY p.name ORDER BY order_count DESC LIMIT 5
      `),
    ]);

    res.json({
      totals: totals.rows[0],
      byStatus: byStatus.rows,
      last30Days: last30days.rows,
      topProducts: topProducts.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

module.exports = router;
