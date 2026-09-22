const axios = require('axios');
const ymlFeed = require('./ymlFeed');

// =====================================================================
// Adapter: mydrop
//
// MyDrop is a CRM platform used by many independent Ukrainian dropship
// vendors at once — one dropshipper API key works across all vendors on
// the platform you've connected with. Each MyDrop vendor becomes ONE
// supplier row here, with:
//
//   feed_urls  — the vendor's own YML/XML product export link, copied
//                from their public price-list ("Вигрузка товарів") —
//                MyDrop's catalogue export is standard YML, so this
//                adapter reuses ymlFeed's parser rather than duplicating it.
//   api_key    — your MyDrop DROPSHIPPER API key (Особистий кабінет →
//                Інтеграції → API). The SAME key on every MyDrop supplier
//                row you create, since it's account-wide, not per-vendor.
//   config.vendorName — the vendor's exact name as shown in MyDrop
//                (case-sensitive match; required to place orders).
//
// Order flow is two calls, matching how the MyDrop cabinet itself works:
//   1. POST /dropshipper/api/orders       → creates a DRAFT (submitted:false)
//   2. POST /dropshipper/api/orders/:id/submit → hands the draft to the
//      vendor (this is what actually reserves stock and notifies them)
// A draft that fails to submit is NOT deleted: it stays visible in your
// MyDrop cabinet so you can fix and submit it by hand if needed — the
// same safety net the rest of this app gives you via Telegram + retry.
//
// Requires the dropshipper PREMIUM plan on MyDrop's side; without it,
// step 1 returns 403 subscription_required.
// =====================================================================

const API_BASE = 'https://backend.mydrop.com.ua';

const capabilities = {
  catalog: true,
  stock: false,       // no separate light sync yet — full fetchCatalog covers it
  createOrder: true,
  orderStatus: true,
};

function headers(supplier) {
  return { 'X-API-KEY': supplier.api_key, 'Content-Type': 'application/json' };
}

// Catalogue import is delegated to the yml_feed adapter: MyDrop's vendor
// export is a standard YML file, so there is no reason to parse it twice.
async function fetchCatalog(supplier, onBatch, options) {
  if (!supplier.api_key) {
    throw new Error(`Постачальник "${supplier.name}" (MyDrop) не має API-ключа дропшипера`);
  }
  if (!supplier.config?.vendorName) {
    throw new Error(
      `Постачальник "${supplier.name}" (MyDrop) не має налаштованого config.vendorName — ` +
      `без нього неможливо створювати замовлення цьому постачальнику`
    );
  }
  return ymlFeed.fetchCatalog(supplier, onBatch, options);
}

// Places one order: draft, then submit. `order` follows the NORMALIZED
// ORDER shape from services/suppliers/index.js.
async function createOrder(supplier, order) {
  if (!supplier.api_key) return { ok: false, reason: 'not_configured', error: 'Немає API-ключа' };
  if (!supplier.config?.vendorName) {
    return { ok: false, reason: 'not_configured', error: 'Немає config.vendorName (точна назва постачальника в MyDrop)' };
  }

  // ---- Step 1: draft ----
  let draftRes;
  try {
    draftRes = await axios.post(
      `${API_BASE}/dropshipper/api/orders`,
      {
        name: order.customerName,
        phone: order.customerPhone,
        city: order.city || undefined,
        warehouse_number: order.npBranch || undefined,
        home_delivery: order.deliveryMethod === 'courier',
        description: order.comment || undefined,
        order_source: 'Сайт',
        products: order.items.map((item) => ({
          vendor_name: supplier.config.vendorName,
          sku: item.supplierProductId || undefined,
          product_title: item.name,
          price: Number(item.retailPrice) || 0,
          drop_price: Number(item.costPrice) || undefined,
          amount: item.quantity,
        })),
      },
      { headers: headers(supplier), timeout: 20000, validateStatus: () => true }
    );
  } catch (err) {
    return { ok: false, reason: 'network_error', error: err.message };
  }

  if (draftRes.status === 403 && draftRes.data?.reason === 'subscription_required') {
    return { ok: false, reason: 'subscription_required', error: draftRes.data?.message || 'Потрібен тариф Premium з API на MyDrop' };
  }
  if (draftRes.status >= 400) {
    return { ok: false, reason: 'draft_failed', error: draftRes.data?.message || JSON.stringify(draftRes.data) };
  }

  const draftId = draftRes.data?.id;
  if (!draftId) {
    return { ok: false, reason: 'draft_failed', error: 'MyDrop не повернув ID чернетки' };
  }

  // ---- Step 2: submit the draft to the vendor ----
  let submitRes;
  try {
    submitRes = await axios.post(
      `${API_BASE}/dropshipper/api/orders/${draftId}/submit`,
      {
        city: order.city || undefined,
        warehouse_number: order.npBranch || undefined,
        home_delivery: order.deliveryMethod === 'courier',
        generate_ttn: true,
      },
      { headers: headers(supplier), timeout: 20000, validateStatus: () => true }
    );
  } catch (err) {
    // Draft exists even though submit failed to reach MyDrop — surface the
    // draft id so a human can finish it from the MyDrop cabinet.
    return { ok: false, reason: 'network_error', error: err.message, supplierOrderId: String(draftId) };
  }

  if (submitRes.status >= 400 || submitRes.data?.valid === false) {
    const errors = submitRes.data?.errors || [];
    const message = errors.map((e) => e.message).join('; ') || 'Не вдалося подати замовлення постачальнику';
    // The draft stays in MyDrop either way — it's not lost, just not submitted.
    return { ok: false, reason: 'submit_failed', error: message, supplierOrderId: String(draftId) };
  }

  return {
    ok: true,
    supplierOrderId: String(draftId),
    raw: submitRes.data,
  };
}

// Reads back status + TTN for an order already placed with this vendor.
async function getOrderStatus(supplier, supplierOrderId) {
  const { data } = await axios.get(`${API_BASE}/dropshipper/api/orders/${supplierOrderId}`, {
    headers: headers(supplier),
    timeout: 15000,
  });
  return {
    status: data?.orderStatus?.title || null,
    ttn: data?.ttn || null,
  };
}

module.exports = { name: 'mydrop', capabilities, fetchCatalog, createOrder, getOrderStatus };
