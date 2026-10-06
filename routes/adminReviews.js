const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('orders'));

const STATUSES = ['pending', 'published', 'hidden'];

// GET /api/admin/reviews/summary — скільки відгуків чекає модерації (для бейджа в меню).
router.get('/summary', async (req, res) => {
  try {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'published')::int AS published,
              COUNT(*) FILTER (WHERE status = 'hidden')::int AS hidden
         FROM product_reviews`
    );
    res.json(r);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити підсумки відгуків' });
  }
});

// GET /api/admin/reviews?status=pending|published|hidden  ?limit=50&offset=0
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const params = [];
    let where = '';
    if (STATUSES.includes(status)) { params.push(status); where = `WHERE r.status = $1`; }

    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM product_reviews r ${where}`, params);
    const listParams = [...params, limit, offset];
    const { rows } = await pool.query(
      `SELECT r.id, r.product_id, r.rating, r.text, r.author_name, r.verified_purchase, r.status,
              r.admin_reply, r.admin_reply_at, r.created_at, r.updated_at,
              p.name AS product_name, u.email AS user_email, u.name AS user_name
         FROM product_reviews r
         JOIN products p ON p.id = r.product_id
         LEFT JOIN users u ON u.id = r.user_id
         ${where}
        ORDER BY (r.status = 'pending') DESC, r.created_at DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    res.json({ total: count.rows[0].n, items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити відгуки' });
  }
});

// PATCH /api/admin/reviews/:id — { status?, admin_reply? }. Порожня відповідь прибирає відповідь магазину.
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Некоректний id' });
    const { status, admin_reply } = req.body;
    const sets = [];
    const params = [];

    if (status !== undefined) {
      if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Невідомий статус' });
      params.push(status); sets.push(`status = $${params.length}`);
    }
    if (admin_reply !== undefined) {
      const reply = String(admin_reply || '').trim().slice(0, 1000);
      params.push(reply || null); sets.push(`admin_reply = $${params.length}`);
      sets.push(reply ? 'admin_reply_at = now()' : 'admin_reply_at = NULL');
    }
    if (!sets.length) return res.status(400).json({ error: 'Нічого оновлювати' });

    params.push(id);
    const { rows } = await pool.query(
      `UPDATE product_reviews SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}
       RETURNING id, status, admin_reply, admin_reply_at`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Відгук не знайдено' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося оновити відгук' });
  }
});

// DELETE /api/admin/reviews/:id
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Некоректний id' });
    const { rowCount } = await pool.query('DELETE FROM product_reviews WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Відгук не знайдено' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося видалити відгук' });
  }
});

module.exports = router;
