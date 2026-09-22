const axios = require('axios');
const ymlFeed = require('./ymlFeed');

// =====================================================================
// Adapter: tradeevo
//
// TradeEvo is one supplier row that can carry products from several real
// distributors at once (ERC, ЮГ-Контракт, DC-Link, Юг-Торг, or anything
// from their own catalogue) — they're all merged behind one account, so
// unlike MyDrop there's no per-vendor split needed here: one TradeEvo
// account = one supplier row in our system.
//
// IMPORTANT — the REST catalogue methods TradeEvo's own docs page
// describes (version / productlist / producttransaction, on a domain
// "api.tradeevo.com") are DEAD: TradeEvo support confirmed that domain
// doesn't exist and those methods aren't in their current system — the
// docs page just never got taken down. Do not resurrect that code path
// without a fresh confirmation from TradeEvo that it's real and live.
//
// What's actually live, confirmed two different ways (a working order
// submission and TradeEvo support directly):
//
//   CATALOGUE — not a REST call. In the TradeEvo cabinet you create an
//   "XML-канал" (an export channel), pick which products go into it, and
//   TradeEvo gives you a permanent link to a YML/XML feed with prices,
//   stock and specs — the same format every other yml_feed supplier
//   here uses. So catalogue import is simply DELEGATED to ymlFeed:
//   set this supplier's feed_urls to that channel link and everything
//   else (parsing, batching, price rules) just works, no TradeEvo-
//   specific code needed for it.
//
//   ORDERS — real REST call: POST to supplier.api_url (the ordinary
//   "API URL" field in the admin panel's supplier form), which is the
//   FULL url TradeEvo shows you after creating an "API замовлень"
//   integration in their cabinet (already includes your account's key,
//   e.g. https://app.tradeevo.com/api/ImoprtOrders/<key> — note the
//   misspelling "ImoprtOrders" is intentional on TradeEvo's side, not a
//   typo to fix). Body shape confirmed against TradeEvo's own worked
//   example (see the big schema table they sent). No Client-ID/Secret-Key
//   auth is needed for this endpoint — the key embedded in the url is
//   the only credential attached to a submitted order.
// =====================================================================

const capabilities = {
  catalog: true,   // delegated to ymlFeed — see fetchCatalog below
  stock: false,
  createOrder: true,
  orderStatus: false, // no confirmed status/TTN endpoint from TradeEvo yet
};

// Catalogue import: this supplier's feed_urls should be set to the link
// TradeEvo's "XML-канал" gives you. Nothing TradeEvo-specific to do here.
async function fetchCatalog(supplier, onBatch, options) {
  if (!supplier.feed_urls?.length) {
    throw new Error(
      `Постачальник "${supplier.name}" (TradeEvo) не має feed_urls — ` +
      `створіть XML-канал у кабінеті TradeEvo і вкажіть його посилання тут`
    );
  }
  return ymlFeed.fetchCatalog(supplier, onBatch, options);
}

// Splits a customer's full name into TradeEvo's firstName/lastName.
// Our own checkout collects one free-text name field with no fixed word
// order ("Ім'я Прізвище" vs "Прізвище Ім'я" vs someone typing a
// patronymic too), so guessing which word is the patronymic would often
// be wrong. Safer split: first word = firstName, everything else =
// lastName. secondName (patronymic) is left blank rather than guessed —
// TradeEvo's schema marks it optional.
function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ') || parts[0] || '',
    secondName: '',
  };
}

async function createOrder(supplier, order) {
  const importUrl = supplier.api_url;
  if (!importUrl) {
    return {
      ok: false, reason: 'not_configured',
      error: 'Немає API URL — вставте адресу, яку TradeEvo видає після створення інтеграції "API замовлень", у поле "API URL" при редагуванні постачальника',
    };
  }

  const { firstName, lastName, secondName } = splitName(order.customerName);
  const totalPrice = order.items.reduce((sum, i) => sum + Number(i.retailPrice || 0) * i.quantity, 0);

  // We choose this id ourselves — TradeEvo doesn't hand one back — so we
  // use our own group id, which also lets a human find this order again
  // in the TradeEvo back office if support needs to look it up.
  const ourOrderId = `SITE-${order.groupId}`;

  const payload = {
    orders: [
      {
        id: ourOrderId,
        dateCreated: new Date().toISOString(),
        clientNotes: order.comment || null,
        products: order.items.map((item) => ({
          sku: item.supplierProductId,
          name: item.name,
          quantity: item.quantity,
          price: Number(item.retailPrice) || 0,
        })),
        delivery: {
          firstName,
          lastName,
          secondName,
          phone: order.customerPhone,
          city: order.city || null,
          shippingService: 'НоваПошта',
          deliveryName: 'НоваПошта',
          deliveryAddress: order.deliveryMethod === 'courier' ? (order.courierAddress || null) : (order.npBranch || null),
          warehouseName: order.deliveryMethod === 'courier' ? null : (order.npBranch || null),
          methodDoors: order.deliveryMethod === 'courier',
        },
        price: totalPrice,
        paymentName: 'Наложений платіж',
        paymentStatus: 'Не сплачено',
        status: 'Очікує підтвердження',
        source: 'Сайт',
      },
    ],
  };

  try {
    const { data, status } = await axios.post(importUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000,
      validateStatus: () => true,
    });

    if (status >= 200 && status < 300 && data?.Status !== false) {
      return { ok: true, supplierOrderId: ourOrderId, raw: data };
    }
    return {
      ok: false,
      reason: 'submit_failed',
      error: data?.ErrorMessage || `HTTP ${status}`,
      supplierOrderId: ourOrderId,
    };
  } catch (err) {
    return { ok: false, reason: 'network_error', error: err.message, supplierOrderId: ourOrderId };
  }
}

module.exports = { name: 'tradeevo', capabilities, fetchCatalog, createOrder };
