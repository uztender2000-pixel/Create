const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// =====================================================================
// MyDrop sends a webhook whenever an order it manages changes — new
// status, TTN generated, etc. This saves us from polling getOrderStatus
// on a timer. MyDrop identifies orders by the id of the DRAFT this
// backend created (services/suppliers/mydrop.js stores that id in
// orders.supplier_order_id), so matching is a straight lookup.
//
// The URL includes a secret path segment instead of a shared header,
// per MyDrop's own recommendation ("приймайте вебхуки на секретному,
// відомому лише вам URL") — set MYDROP_WEBHOOK_SECRET and give MyDrop
// the full path including it, e.g.:
//   https://your-backend.onrender.com/api/webhooks/mydrop/<secret>
//
// MyDrop requires a response within 15 seconds and does not retry, so
// this handler does the (fast, single-row) DB update inline and returns
// 200 either way — a webhook MyDrop can't deliver successfully just
// means the next poll-based sync catches up instead, nothing is lost.
// =====================================================================

// Maps a MyDrop order-status title to our own pipeline. Unrecognized
// titles are kept as-is under supplier_status so nothing is silently lost.
const STATUS_MAP = {
  'Новий': 'ordered_from_supplier',
  'Прийнято': 'ordered_from_supplier',
  'Комплектується': 'ordered_from_supplier',
  'Відправлено': 'shipped',
  'Доставка': 'shipped',
  'Продаж': 'done',
  'Повернення': 'done',
  'Відмова': 'done',
  'Скасовано': 'done',
};

router.post('/:secret', express.json({ limit: '2mb' }), async (req, res) => {
  // Wrong or missing secret: respond 404 rather than 401, so a scanning
  // bot learns nothing about whether this endpoint exists.
  if (!process.env.MYDROP_WEBHOOK_SECRET || req.params.secret !== process.env.MYDROP_WEBHOOK_SECRET) {
    return res.sendStatus(404);
  }

  // Acknowledge immediately — MyDrop's 15s budget shouldn't depend on our
  // DB round-trip finishing first, and MyDrop doesn't retry on timeout.
  res.sendStatus(200);

  try {
    const payload = req.body;
    const mydropOrderId = payload?.id;
    if (!mydropOrderId) return; // a stock-change webhook or malformed body — nothing to update

    const statusTitle = payload?.orderStatus?.title || null;
    const ttn = payload?.ttn || null;
    const mappedStatus = statusTitle ? (STATUS_MAP[statusTitle] || null) : null;

    await pool.query(
      `UPDATE orders
          SET supplier_status = COALESCE($2, supplier_status),
              ttn              = COALESCE($3, ttn),
              status           = CASE
                                    WHEN $4::text IS NOT NULL AND status <> 'done' THEN $4::text
                                    ELSE status
                                  END
        WHERE supplier_order_id = $1`,
      [String(mydropOrderId), statusTitle, ttn, mappedStatus]
    );
  } catch (err) {
    // Already responded 200 to MyDrop; just log for our own visibility.
    console.error('[webhooks/mydrop] failed to process payload:', err.message);
  }
});

module.exports = router;
