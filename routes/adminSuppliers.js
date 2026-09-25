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
  s.manual_selection,
  s.last_sync_at, s.last_sync_status, s.last_sync_message, s.created_at,
  (s.api_key IS NOT NULL AND s.api_key <> '') AS has_api_key
`;

// GET /api/admin/suppliers — list with live product counts
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SAFE_COLUMNS},
              COALESCE(pc.total, 0)     AS product_count,
              COALESCE(pc.available, 0) AS available_count,
              COALESCE(pc.included, 0)  AS included_count
         FROM suppliers s
         LEFT JOIN (
           SELECT supplier_id,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE available)::int AS available,
                  COUNT(*) FILTER (WHERE included)::int AS included
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
      config, markup_percent, auto_order, active, sort_order, manual_selection,
    } = req.body;

    if (!code || !name) return res.status(400).json({ error: "code і name обов'язкові" });

    const { rows } = await pool.query(
      `INSERT INTO suppliers (code, name, adapter, feed_urls, api_url, api_key, api_login,
                              config, markup_percent, auto_order, active, sort_order, manual_selection)
       VALUES ($1, $2, COALESCE($3::text, 'yml_feed'), COALESCE($4::text[], '{}'::text[]),
               $5::text, $6::text, $7::text,
               COALESCE($8::jsonb, '{}'::jsonb), COALESCE($9::numeric, 0),
               COALESCE($10::boolean, false), COALESCE($11::boolean, true), COALESCE($12::integer, 0),
               COALESCE($13::boolean, false))
       RETURNING id`,
      [
        code.trim(), name.trim(), adapter, feed_urls, api_url, api_key, api_login,
        config ? JSON.stringify(config) : null, markup_percent, auto_order, active, sort_order,
        manual_selection,
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
      config, markup_percent, auto_order, active, sort_order, manual_selection,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE suppliers SET
         name              = COALESCE($2, name),
         adapter           = COALESCE($3, adapter),
         feed_urls         = COALESCE($4, feed_urls),
         api_url           = COALESCE($5, api_url),
         api_key           = COALESCE($6, api_key),
         api_login         = COALESCE($7, api_login),
         config            = COALESCE($8, config),
         markup_percent    = COALESCE($9, markup_percent),
         auto_order        = COALESCE($10, auto_order),
         active            = COALESCE($11, active),
         sort_order        = COALESCE($12, sort_order),
         manual_selection  = COALESCE($13, manual_selection)
       WHERE id = $1 RETURNING id`,
      [
        req.params.id, name, adapter, feed_urls, api_url, api_key, api_login,
        config ? JSON.stringify(config) : null, markup_percent, auto_order, active, sort_order,
        manual_selection,
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

// POST /api/admin/suppliers/:id/hubber-debug — TEMPORARY diagnostic route.
// Tests this supplier's exact stored credentials against Hubber's real
// /auth endpoint and reports back masked info about what was actually
// sent (length, first/last char, whether whitespace or a colon is
// present) plus Hubber's real response — without ever exposing the full
// secret. Only meaningful for adapter = 'hubber'. Safe to remove once
// the Hubber integration is confirmed working end-to-end.
router.post('/:id/hubber-debug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].adapter !== 'hubber') {
      return res.status(400).json({ error: `Цей постачальник використовує адаптер "${rows[0].adapter}", а не hubber` });
    }
    const hubber = require('../services/suppliers/hubber');
    const result = await hubber.debugAuth(rows[0]);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/suppliers/:id/sync-status — lightweight poll target for
// the "Синхронізувати" button's live progress. Cheap on purpose (one
// indexed row lookup) since the admin panel polls this every ~1.5s while
// a sync is running.
router.get('/:id/sync-status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT last_sync_status AS status, last_sync_message AS message,
              sync_progress_current AS current, sync_progress_total AS total
         FROM suppliers WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];
    const percent = row.total ? Math.min(100, Math.round((row.current / row.total) * 100)) : null;
    res.json({ ...row, percent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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

// POST /api/admin/suppliers/:id/purge — delete this supplier's catalogue.
// Products that appear in past orders can't be deleted (order history
// must keep pointing at something), so those are only switched off.
// The supplier itself stays, so it can be synced again later.
router.post('/:id/purge', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: sup } = await client.query('SELECT id, name FROM suppliers WHERE id = $1', [req.params.id]);
    if (!sup.length) return res.status(404).json({ error: 'Not found' });

    await client.query('BEGIN');
    await client.query(
      `DELETE FROM cart_items WHERE product_id IN (SELECT id FROM products WHERE supplier_id = $1)`,
      [req.params.id]
    );
    const { rowCount: deleted } = await client.query(
      `DELETE FROM products
        WHERE supplier_id = $1
          AND id NOT IN (SELECT product_id FROM orders WHERE product_id IS NOT NULL)`,
      [req.params.id]
    );
    const { rowCount: kept } = await client.query(
      `UPDATE products SET available = false WHERE supplier_id = $1`,
      [req.params.id]
    );
    await client.query('COMMIT');

    res.json({ ok: true, deleted, keptBecauseOfOrders: kept });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to purge catalogue' });
  } finally {
    client.release();
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
