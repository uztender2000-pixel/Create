const axios = require('axios');
const crypto = require('crypto');

// =====================================================================
// Adapter: tradeevo
//
// TradeEvo is one supplier row that can carry products from several real
// distributors at once (ERC, ЮГ-Контракт, DC-Link, Юг-Торг, or anything
// from their own catalogue) — they're all merged behind one account and
// one catalogue endpoint, so unlike MyDrop there's no per-vendor split
// needed here: one TradeEvo account = one supplier row in our system.
//
// Auth (every request): two headers —
//   Client-ID:     your account id, from Кабінет → API
//   Authorization: md5("<ClientID>:<ApiSecretKey>")
// Store the account id in supplier.api_login and the secret in
// supplier.api_key. Responses are always { Data, Status, ErrorMessage }.
//
// Catalogue: GET http://api.tradeevo.com/api/productlist
//   TradeEvo's own field names for each product weren't given to us in
//   writing — the code below reads several likely candidate names per
//   field (common in Ukrainian B2B APIs: Id/ProductId/Sku, Name/Title,
//   Price/RetailPrice, Quantity/Stock/Balance...). VERIFY THIS against a
//   real response before relying on it: run one sync, then check a
//   product's row with the SQL console —
//     SELECT name, price, stock FROM products
//      WHERE supplier_id = (SELECT id FROM suppliers WHERE code = 'tradeevo')
//      LIMIT 5;
//   If names/prices/stock come through empty or wrong, ask TradeEvo
//   support for one real productlist response and this file's
//   normalizeProduct() gets a five-minute fix.
//
// Orders: POST to supplier.config.importUrl (copy the FULL url shown on
// TradeEvo's "Довідник API замовлень" page — it already has your real id
// in place of <ваш_id>, so there's nothing to guess here). The order id
// (orders[].id) is chosen BY US, not returned by TradeEvo, so we use our
// own order row id — that's also what lets a human find it again in the
// TradeEvo back office if something needs checking by hand.
//
// TradeEvo's docs don't show a "get order status" endpoint or a webhook
// for it yet, so orderStatus stays unsupported until that's confirmed —
// statuses/ttn will need to come back the same way they do today
// (checked manually, or via whatever TradeEvo's "apps" callback page
// turns out to configure once we know what it does).
// =====================================================================

const CATALOG_URL = 'http://api.tradeevo.com/api/productlist';

const capabilities = {
  catalog: true,
  stock: false,
  createOrder: true,
  orderStatus: false, // not documented yet — see note above
};

function authHeaders(supplier) {
  const clientId = supplier.api_login;
  const secret = supplier.api_key;
  const hash = crypto.createHash('md5').update(`${clientId}:${secret}`).digest('hex');
  return { 'Client-ID': clientId, Authorization: hash, 'Content-Type': 'application/json' };
}

// Reads the first present key out of several candidate field-name
// spellings — a defensive shim for the parts of TradeEvo's schema we
// haven't seen a real example of yet (see the big comment above).
function pick(obj, ...candidates) {
  for (const key of candidates) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return null;
}

function normalizeProduct(raw) {
  const price = parseFloat(pick(raw, 'Price', 'price', 'RetailPrice', 'retailPrice') ?? 0);
  const stockRaw = pick(raw, 'Quantity', 'quantity', 'Stock', 'stock', 'Balance', 'balance');
  const stock = stockRaw !== null ? parseInt(stockRaw, 10) : null;

  return {
    supplierProductId: String(pick(raw, 'Sku', 'sku', 'Id', 'id', 'ProductId', 'productId', 'Article', 'article')),
    name: pick(raw, 'Name', 'name', 'Title', 'title', 'ProductName', 'productName') || '',
    description: pick(raw, 'Description', 'description') || '',
    price: Number.isFinite(price) ? price : 0,
    categoryId: pick(raw, 'CategoryId', 'categoryId') ? String(pick(raw, 'CategoryId', 'categoryId')) : null,
    categoryName: pick(raw, 'CategoryName', 'categoryName', 'Category', 'category'),
    section: pick(raw, 'CategoryName', 'categoryName', 'Category', 'category'),
    pictureUrl: pick(raw, 'Image', 'image', 'ImageUrl', 'imageUrl', 'Picture', 'picture'),
    pictures: pick(raw, 'Images', 'images') || [],
    vendorCode: pick(raw, 'Sku', 'sku', 'Article', 'article'),
    vendor: pick(raw, 'Vendor', 'vendor', 'Brand', 'brand'),
    params: {},
    stock: Number.isFinite(stock) ? stock : null,
    available: stock === null ? true : stock > 0,
  };
}

async function fetchCatalog(supplier, onBatch, { batchSize = 500 } = {}) {
  if (!supplier.api_login || !supplier.api_key) {
    throw new Error(`Постачальник "${supplier.name}" (TradeEvo) не має Client-ID / ApiSecretKey`);
  }

  const { data } = await axios.get(CATALOG_URL, {
    headers: authHeaders(supplier),
    timeout: 60000,
  });

  if (data?.Status === false || data?.ErrorMessage) {
    throw new Error(`TradeEvo productlist: ${data?.ErrorMessage || 'невідома помилка'}`);
  }

  const items = Array.isArray(data?.Data) ? data.Data : [];
  let total = 0;
  let batch = [];
  for (const raw of items) {
    batch.push(normalizeProduct(raw));
    if (batch.length >= batchSize) {
      await onBatch(batch);
      total += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await onBatch(batch);
    total += batch.length;
  }
  return total;
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
  if (!supplier.api_login || !supplier.api_key) {
    return { ok: false, reason: 'not_configured', error: 'Немає Client-ID / ApiSecretKey' };
  }
  const importUrl = supplier.config?.importUrl;
  if (!importUrl) {
    return {
      ok: false, reason: 'not_configured',
      error: 'Немає config.importUrl — скопіюйте повну адресу зі сторінки "Довідник API замовлень" в кабінеті TradeEvo',
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
      headers: authHeaders(supplier),
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
