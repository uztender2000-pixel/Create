const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');
const { listAdapters } = require('../services/suppliers');
const { syncSupplierById } = require('../services/catalogSync');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('settings'));

// Never return api_key to the browser. The dashboard only needs to know
// whether a key is set, not what it is.
const SAFE_COLUMNS = `
  s.id, s.code, s.name, s.adapter, s.feed_urls, s.api_url, s.api_login,
  s.config, s.markup_percent, s.auto_order, s.active, s.sort_order,
  s.last_sync_at, s.last_sync_status, s.last_sync_message, s.created_at,
  (s.api_key IS NOT NULL AND s.api_key <> '') AS has_api_key
`;

// GET /api/admin/suppliers — list with live product counts
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SAFE_COLUMNS},
              COALESCE(pc.total, 0)     AS product_count,
              COALESCE(pc.available, 0) AS available_count
         FROM suppliers s
         LEFT JOIN (
           SELECT supplier_id,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE available)::int AS available
             FROM products GROUP BY supplier_id
         ) pc ON pc.supplier_id = s.id
        ORDER BY s.sort_order, s.id`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load suppliers' });
  }
});

// GET /api/admin/suppliers/adapters — which adapters this build supports
// and what each can do, so the dashboard can show the right fields.
router.get('/adapters', (req, res) => {
  res.json(listAdapters());
});

// POST /api/admin/suppliers — register a new supplier
router.post('/', async (req, res) => {
  try {
    const {
      code, name, adapter, feed_urls, api_url, api_key, api_login,
      config, markup_percent, auto_order, active, sort_order,
    } = req.body;

    if (!code || !name) return res.status(400).json({ error: "code і name обов'язкові" });

    const { rows } = await pool.query(
      `INSERT INTO suppliers (code, name, adapter, feed_urls, api_url, api_key, api_login,
                              config, markup_percent, auto_order, active, sort_order)
       VALUES ($1,$2,COALESCE($3,'yml_feed'),COALESCE($4,'{}'),$5,$6,$7,
               COALESCE($8,'{}'),COALESCE($9,0),COALESCE($10,false),COALESCE($11,true),COALESCE($12,0))
       RETURNING id`,
      [
        code.trim(), name.trim(), adapter, feed_urls, api_url, api_key, api_login,
        config ? JSON.stringify(config) : null, markup_percent, auto_order, active, sort_order,
      ]
    );

    const { rows: created } = await pool.query(`SELECT ${SAFE_COLUMNS} FROM suppliers s WHERE s.id = $1`, [rows[0].id]);
    res.status(201).json(created[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Постачальник з таким code вже існує' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create supplier' });
  }
});

// PATCH /api/admin/suppliers/:id — update any field. Sending api_key: null
// leaves the existing key alone; sending "" clears it.
router.patch('/:id', async (req, res) => {
  try {
    const {
      name, adapter, feed_urls, api_url, api_key, api_login,
      config, markup_percent, auto_order, active, sort_order,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE suppliers SET
         name           = COALESCE($2, name),
         adapter        = COALESCE($3, adapter),
         feed_urls      = COALESCE($4, feed_urls),
         api_url        = COALESCE($5, api_url),
         api_key        = COALESCE($6, api_key),
         api_login      = COALESCE($7, api_login),
         config         = COALESCE($8, config),
         markup_percent = COALESCE($9, markup_percent),
         auto_order     = COALESCE($10, auto_order),
         active         = COALESCE($11, active),
         sort_order     = COALESCE($12, sort_order)
       WHERE id = $1 RETURNING id`,
      [
        req.params.id, name, adapter, feed_urls, api_url, api_key, api_login,
        config ? JSON.stringify(config) : null, markup_percent, auto_order, active, sort_order,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const { rows: updated } = await pool.query(`SELECT ${SAFE_COLUMNS} FROM suppliers s WHERE s.id = $1`, [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update supplier' });
  }
});

// POST /api/admin/suppliers/:id/sync — pull this supplier's catalogue now.
// Runs in the background so the dashboard gets an immediate answer even on
// a 40 000-product catalogue; watch last_sync_status for the result.
router.post('/:id/sync', async (req, res) => {
  const supplierId = req.params.id;
  const { rows } = await pool.query('SELECT id, name FROM suppliers WHERE id = $1', [supplierId]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });

  res.status(202).json({ ok: true, message: `Синхронізацію "${rows[0].name}" запущено` });

  syncSupplierById(supplierId)
    .then((r) => console.log(`[sync] manual ${r.supplier}: ${r.imported} оновлено, ${r.deactivated} знято`))
    .catch((err) => console.error(`[sync] manual failed:`, err.message));
});

// POST /api/admin/suppliers/:id/reprice — apply the supplier's markup to
// every product of that supplier that you haven't priced by hand.
router.post('/:id/reprice', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE products p
          SET retail_price = ROUND(p.price * (1 + COALESCE(p.markup_percent, s.markup_percent) / 100), 2),
              updated_at = now()
         FROM suppliers s
        WHERE s.id = p.supplier_id
          AND p.supplier_id = $1
          AND p.price_overridden = false`,
      [req.params.id]
    );
    res.json({ ok: true, updated: rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reprice' });
  }
});

// DELETE /api/admin/suppliers/:id — removes the supplier and its products.
// Blocked while any order still references those products, so order
// history can never end up pointing at nothing.
router.delete('/:id', async (req, res) => {
  try {
    const { rows: orderRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM orders WHERE supplier_id = $1`,
      [req.params.id]
    );
    if (orderRows[0].count > 0) {
      return res.status(409).json({
        error: `Є ${orderRows[0].count} замовлень цього постачальника. Вимкніть його (active = false) замість видалення.`,
      });
    }

    const { rowCount } = await pool.query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete supplier' });
  }
});

module.exports = router;
