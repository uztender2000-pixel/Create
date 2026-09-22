const axios = require('axios');
const { pool } = require('../db');
const { getAdapter } = require('./suppliers');

// =====================================================================
// Order dispatch.
//
// A basket can contain products from several suppliers at once. The
// customer sees one checkout; behind it, every supplier has to receive
// its own order with only its own items.
//
// Each row in `orders` is one product from one supplier. Rows created by
// the same checkout share a group_id. This module takes a group_id,
// splits its rows by supplier, and submits one order per supplier via
// that supplier's adapter.
//
// A supplier with auto_order = false, or an adapter that can't place
// orders, simply stays manual: the rows are saved, you get the Telegram
// message, and you place that part by hand. Nothing breaks.
// =====================================================================

// Telegram notification for a whole checkout, with items grouped by
// supplier so you can see at a glance what has to be ordered where.
async function notifyTelegram(groupId, rows) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const first = rows[0];
  const bySupplier = new Map();
  for (const row of rows) {
    const key = row.supplier_name || 'Без постачальника';
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key).push(row);
  }

  const supplierBlocks = [...bySupplier.entries()]
    .map(([supplierName, items]) => {
      const lines = items
        .map((i) => `   • ${i.product_name} x${i.quantity} (#${i.id})`)
        .join('\n');
      return `📦 ${supplierName}:\n${lines}`;
    })
    .join('\n');

  const deliveryLine = first.delivery_method === 'courier'
    ? `Кур'єром: ${first.courier_address || '-'}`
    : `Відділення НП: ${first.np_branch || '-'}`;

  const total = rows.reduce((sum, r) => sum + Number(r.unit_price || 0) * r.quantity, 0);

  const text =
    `🛒 Нове замовлення\n` +
    `${supplierBlocks}\n\n` +
    `Клієнт: ${first.customer_name}, ${first.customer_phone}\n` +
    `Місто: ${first.customer_city || '-'}\n` +
    `${deliveryLine}\n` +
    `Сума: ${total.toFixed(2)} грн\n` +
    `Коментар: ${first.comment || '-'}`;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
    });
  } catch (err) {
    console.error('[telegram] notify failed:', err.message);
  }
}

// Loads every order row of one checkout, with the data the adapters need.
async function loadGroup(groupId) {
  const { rows } = await pool.query(
    `SELECT o.*,
            p.name                AS product_name,
            p.supplier_product_id AS supplier_product_id,
            s.name                AS supplier_name
       FROM orders o
       JOIN products p  ON p.id = o.product_id
       LEFT JOIN suppliers s ON s.id = o.supplier_id
      WHERE o.group_id = $1
      ORDER BY o.id`,
    [groupId]
  );
  return rows;
}

// Submits one supplier's share of a checkout and writes the outcome back
// onto its order rows.
async function submitToSupplier(supplierId, rows) {
  const { rows: supplierRows } = await pool.query('SELECT * FROM suppliers WHERE id = $1', [supplierId]);
  const supplier = supplierRows[0];
  const orderIds = rows.map((r) => r.id);

  if (!supplier) {
    return { supplierId, submitted: false, reason: 'supplier_missing' };
  }
  if (!supplier.auto_order) {
    return { supplierId, supplier: supplier.name, submitted: false, reason: 'manual_mode' };
  }

  let adapter;
  try {
    adapter = getAdapter(supplier);
  } catch (err) {
    await markFailed(orderIds, err.message);
    return { supplierId, supplier: supplier.name, submitted: false, reason: 'unknown_adapter', error: err.message };
  }

  if (!adapter.capabilities?.createOrder || typeof adapter.createOrder !== 'function') {
    return { supplierId, supplier: supplier.name, submitted: false, reason: 'not_supported' };
  }

  const first = rows[0];
  const payload = {
    groupId: first.group_id,
    customerName: first.customer_name,
    customerPhone: first.customer_phone,
    city: first.customer_city,
    npBranch: first.np_branch,
    deliveryMethod: first.delivery_method,
    courierAddress: first.courier_address,
    comment: first.comment,
    items: rows.map((r) => ({
      orderId: r.id,
      supplierProductId: r.supplier_product_id,
      quantity: r.quantity,
      name: r.product_name,
      retailPrice: r.unit_price,  // what the customer pays — MyDrop requires this
      costPrice: r.cost_price,    // your cost — used as drop_price where relevant
    })),
  };

  let result;
  try {
    result = await adapter.createOrder(supplier, payload);
  } catch (err) {
    result = { ok: false, reason: 'adapter_threw', error: err.message };
  }

  if (result.ok) {
    await pool.query(
      `UPDATE orders
          SET supplier_submitted = true,
              supplier_order_id  = $2,
              supplier_status    = 'submitted',
              supplier_error     = NULL,
              status             = CASE WHEN status = 'new' THEN 'ordered_from_supplier' ELSE status END
        WHERE id = ANY($1)`,
      [orderIds, result.supplierOrderId || null]
    );
    return { supplierId, supplier: supplier.name, submitted: true, supplierOrderId: result.supplierOrderId };
  }

  // A failed submission must never lose the order: the rows are already
  // saved and you already have the Telegram message, so the worst case is
  // that you place this one supplier's part by hand, as before.
  const message = typeof result.error === 'string' ? result.error : JSON.stringify(result.error || result.reason);
  await markFailed(orderIds, message);
  console.error(`[dispatch] ${supplier.name}: ${result.reason} — ${message}`);
  return { supplierId, supplier: supplier.name, submitted: false, reason: result.reason, error: message };
}

async function markFailed(orderIds, message) {
  await pool.query(
    `UPDATE orders SET supplier_status = 'failed', supplier_error = $2 WHERE id = ANY($1)`,
    [orderIds, String(message || '').slice(0, 500)]
  );
}

// The entry point used by both checkout paths (cart and one-click order).
// Notifies you first, then tries to submit each supplier's share.
async function dispatchGroup(groupId) {
  const rows = await loadGroup(groupId);
  if (!rows.length) return { groupId, suppliers: [] };

  await notifyTelegram(groupId, rows);

  const bySupplier = new Map();
  for (const row of rows) {
    if (!row.supplier_id) continue;
    if (!bySupplier.has(row.supplier_id)) bySupplier.set(row.supplier_id, []);
    bySupplier.get(row.supplier_id).push(row);
  }

  const results = [];
  for (const [supplierId, supplierRows] of bySupplier) {
    results.push(await submitToSupplier(supplierId, supplierRows));
  }

  return { groupId, suppliers: results };
}

// Retries just one supplier's share of a checkout — useful from the admin
// panel after a supplier's API was down or a key was fixed.
async function retrySupplierInGroup(groupId, supplierId) {
  const rows = (await loadGroup(groupId)).filter((r) => r.supplier_id === supplierId);
  if (!rows.length) throw new Error('Немає позицій цього постачальника в замовленні');
  return submitToSupplier(supplierId, rows);
}

module.exports = { dispatchGroup, retrySupplierInGroup, notifyTelegram };
