const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('settings'));

// =====================================================================
// The admin's own category/subcategory tree — independent of any
// supplier's raw categories. Mainly built for manual_selection suppliers
// (Hubber & co), but usable for any product via routes/adminProducts.js's
// assign-categories endpoint.
// =====================================================================

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

// GET /api/admin/categories — full tree, flat list with parent_id, plus
// how many products currently sit in each (regardless of on-sale status,
// so the admin can see empty categories too).
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.parent_id, c.name, c.slug, c.sort_order, c.created_at,
              COALESCE(pc.count, 0)::int AS product_count
         FROM categories c
         LEFT JOIN (
           SELECT category_id, COUNT(*)::int AS count
             FROM product_categories GROUP BY category_id
         ) pc ON pc.category_id = c.id
        ORDER BY c.parent_id NULLS FIRST, c.sort_order, c.name`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// POST /api/admin/categories — create a category or subcategory.
// body: { name, parent_id?: null, sort_order?: 0 }
router.post('/', async (req, res) => {
  try {
    const { name, parent_id, sort_order } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "name обов'язковий" });

    if (parent_id) {
      const { rows: parentRows } = await pool.query('SELECT id FROM categories WHERE id = $1', [parent_id]);
      if (!parentRows.length) return res.status(400).json({ error: 'Батьківської категорії не знайдено' });
    }

    const { rows } = await pool.query(
      `INSERT INTO categories (parent_id, name, slug, sort_order)
       VALUES ($1, $2, $3, COALESCE($4, 0))
       RETURNING *`,
      [parent_id || null, name.trim(), slugify(name), sort_order]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// PATCH /api/admin/categories/:id — rename, move to a different parent,
// or reorder. Moving a category under one of its own descendants is
// rejected (would create a cycle).
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, parent_id, sort_order } = req.body;

    if (parent_id !== undefined && parent_id !== null) {
      if (String(parent_id) === String(id)) {
        return res.status(400).json({ error: 'Категорія не може бути власним батьком' });
      }
      const { rows: descendants } = await pool.query(
        `WITH RECURSIVE d AS (
           SELECT id FROM categories WHERE parent_id = $1
           UNION ALL
           SELECT c.id FROM categories c JOIN d ON c.parent_id = d.id
         )
         SELECT id FROM d WHERE id = $2`,
        [id, parent_id]
      );
      if (descendants.length) {
        return res.status(400).json({ error: 'Не можна перенести категорію в її ж підкатегорію' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE categories SET
         name       = COALESCE($2, name),
         slug       = CASE WHEN $2::text IS NOT NULL THEN $3 ELSE slug END,
         parent_id  = CASE WHEN $4::text = '__null__' THEN NULL
                           WHEN $4::text IS NOT NULL THEN $4::integer
                           ELSE parent_id END,
         sort_order = COALESCE($5, sort_order),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, name || null, name ? slugify(name) : null,
       parent_id === null ? '__null__' : (parent_id !== undefined ? String(parent_id) : null),
       sort_order],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// DELETE /api/admin/categories/:id — refuses to delete a non-empty
// category (has subcategories or assigned products) unless ?force=true,
// since that would silently unassign products from it.
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const force = req.query.force === 'true';

    if (!force) {
      const { rows } = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM categories WHERE parent_id = $1)::int AS children,
           (SELECT COUNT(*) FROM product_categories WHERE category_id = $1)::int AS products`,
        [id]
      );
      if (rows[0].children > 0 || rows[0].products > 0) {
        return res.status(409).json({
          error: `Категорія містить ${rows[0].children} підкатегорій і ${rows[0].products} товарів. Повторіть з ?force=true, щоб видалити разом з ними.`,
          children: rows[0].children,
          products: rows[0].products,
        });
      }
    }

    const { rowCount } = await pool.query('DELETE FROM categories WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

module.exports = router;
