const axios = require('axios');
const { parseStringPromise } = require('xml2js');

// =====================================================================
// Adapter: yml_feed
//
// Handles any supplier that publishes a YML/Yandex-Market style XML feed
// (dropshipping.ua, Prom exports, most Ukrainian dropshipping platforms).
// A supplier using this adapter needs feed_urls filled in.
//
// Order submission: optional. If the supplier also has a simple REST
// endpoint for placing orders (api_url + api_key), we use the common
// X-API-KEY + JSON-body shape. If api_url is empty, createOrder reports
// that it's unsupported and the order stays manual — exactly the flow
// you have today.
// =====================================================================

const capabilities = {
  catalog: true,
  stock: true,       // availability comes from the feed itself
  createOrder: true, // only when api_url/api_key are configured
  orderStatus: false,
};

// Some suppliers put raw HTML in the description field (<p>, <br>, etc.).
// Strip it down to plain text, turning block-level breaks into newlines so
// paragraphs don't run together.
function cleanDescription(html) {
  if (!html) return '';
  return html
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A feed's <categories> block is a full tree:
//   <category id="841">Зоотовари</category>
//   <category id="3412" parentId="841">Одяг для домашніх тварин</category>
// This reads it into { id: { name, parentId } } so we can walk it.
function buildCategoryTree(parsed) {
  const rawCategories = parsed?.yml_catalog?.shop?.[0]?.categories?.[0]?.category || [];
  const tree = {};
  for (const cat of rawCategories) {
    const id = cat?.$?.id;
    const parentId = cat?.$?.parentId || null;
    const name = typeof cat === 'object' ? (cat._ || '').trim() : String(cat).trim();
    if (id) tree[id] = { name, parentId };
  }
  return tree;
}

// Some suppliers give their root category a lazy placeholder name instead
// of something meaningful ("корневая" = "root", left over from their own
// default setup). Override known placeholders here.
const SECTION_NAME_OVERRIDES = {
  'корневая': 'Товари-бестселери🔥',
};

// Walks up parentId links from a leaf category to the top-level section
// (the ancestor with no parentId) and returns that root's name.
function findSectionName(categoryId, tree, depth = 0) {
  const node = tree[categoryId];
  if (!node || depth > 10) return null; // guard against malformed/circular data
  if (!node.parentId) {
    const name = node.name;
    return SECTION_NAME_OVERRIDES[name.trim().toLowerCase()] || name;
  }
  return findSectionName(node.parentId, tree, depth + 1);
}

// Converts one <offer> element into the normalized shape every adapter in
// this project returns. Keeping this shape identical across adapters is
// what lets catalogSync treat BRAIN, MTI and a plain XML feed the same way.
function normalizeOffer(offer, tree) {
  const categoryId = offer.categoryId?.[0] || null;

  const pictures = Array.isArray(offer.picture)
    ? offer.picture
    : (offer.picture ? [offer.picture] : []);

  // <param name="Об'єм" unit="мл">500</param> -> { "Об'єм": "500 мл" }
  const rawParams = Array.isArray(offer.param) ? offer.param : (offer.param ? [offer.param] : []);
  const params = {};
  for (const p of rawParams) {
    const paramName = p?.$?.name;
    const unit = p?.$?.unit;
    const value = typeof p === 'object' ? (p._ || '').trim() : String(p).trim();
    if (paramName) params[paramName] = unit ? `${value} ${unit}` : value;
  }

  const stockRaw = offer.stock_quantity?.[0] ?? offer.quantity_in_stock?.[0] ?? offer.quantity?.[0];
  const stock = stockRaw !== undefined && stockRaw !== null && `${stockRaw}`.trim() !== ''
    ? parseInt(stockRaw, 10)
    : null;

  return {
    supplierProductId: String(offer.$.id),
    name: offer.name?.[0] || '',
    description: cleanDescription(offer.description?.[0] || ''),
    price: parseFloat(offer.price?.[0] || '0'),
    categoryId,
    categoryName: categoryId ? (tree[categoryId]?.name || null) : null,
    section: categoryId ? findSectionName(categoryId, tree) : null,
    pictureUrl: pictures[0] || null,
    pictures,
    vendorCode: offer.vendorCode?.[0] || null,
    vendor: offer.vendor?.[0] || null,
    params,
    stock: Number.isFinite(stock) ? stock : null,
    available: offer.$.available === 'true',
  };
}

// Pulls every feed URL configured for this supplier and hands the products
// to onBatch() in chunks, so a 50 000-product catalogue never sits in
// memory in one piece.
async function fetchCatalog(supplier, onBatch, { batchSize = 500 } = {}) {
  const urls = supplier.feed_urls || [];
  if (!urls.length) {
    throw new Error(`Постачальник "${supplier.name}" використовує адаптер yml_feed, але не має жодного feed_url`);
  }

  let total = 0;

  for (const url of urls) {
    const { data: xml } = await axios.get(url, {
      timeout: 120000,
      maxContentLength: 512 * 1024 * 1024,
      maxBodyLength: 512 * 1024 * 1024,
    });
    const parsed = await parseStringPromise(xml, { explicitArray: true, trim: true });

    const tree = buildCategoryTree(parsed);
    const offers = parsed?.yml_catalog?.shop?.[0]?.offers?.[0]?.offer || [];

    let batch = [];
    for (const offer of offers) {
      if (!offer?.$?.id) continue;
      batch.push(normalizeOffer(offer, tree));
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
  }

  return total;
}

// Places one order with this supplier. `order` arrives already grouped:
// it's one customer, one delivery address, and every item in it belongs
// to THIS supplier.
async function createOrder(supplier, order) {
  if (!supplier.api_url || !supplier.api_key) {
    return { ok: false, reason: 'not_configured' };
  }

  const payload = {
    name: order.customerName,
    phone: order.customerPhone,
    city: order.city || null,
    np_branch: order.npBranch || null,
    description: order.comment || '',
    order_source: 'Сайт',
    products: order.items.map((item) => ({
      // The supplier's own product id — not our internal numeric id.
      product_id: item.supplierProductId,
      amount: item.quantity,
    })),
  };

  try {
    const { data } = await axios.post(supplier.api_url, payload, {
      headers: { 'X-API-KEY': supplier.api_key, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    return {
      ok: true,
      supplierOrderId: data?.id ? String(data.id) : (data?.order_id ? String(data.order_id) : null),
      raw: data,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'api_error',
      error: err.response?.data || err.message,
    };
  }
}

module.exports = { name: 'yml_feed', capabilities, fetchCatalog, createOrder };
