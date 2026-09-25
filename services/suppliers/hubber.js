const axios = require('axios');

// =====================================================================
// Adapter: hubber
//
// Hubber (office.hubber.pro) is a Ukrainian B2B marketplace-integration
// platform: suppliers list products, and connected marketplaces (like
// OllShop) pick which ones to sell and place orders through its REST
// API. Unlike MyDrop/TradeEvo, there is no YML feed involved — catalogue,
// orders and everything else go through JSON endpoints.
//
// ---------------------------------------------------------------------
// ⚠️  BUILT FROM DOCUMENTATION ONLY — NOT YET TESTED AGAINST A LIVE KEY.
// The doc pasted into this project was a machine-translated Swagger page
// (Ukrainian UI text, but the actual JSON field names inside code samples
// stayed in their original English/snake_case — e.g. client_name,
// vendor_code, main_picture). That's reliable enough to build against,
// but four things below are still ASSUMPTIONS that need a real API key
// to confirm — each is marked "CONFIRM:" at the point it matters:
//
//   1. BASE URL / PATH — CONFIRMED from a real "Try it out" call:
//      https://office.hubber.pro/api/v1, endpoint GET /auth (not the
//      "/token" name the translated doc implied). If your account's
//      base differs, just fill in "API URL" on the supplier.
//
//   2. HOW TO GET THE VERY FIRST TOKEN — CONFIRMED 2026-09-24 via a live
//      Swagger "Authorize" (basicAuth) call that returned 200 with a
//      token: GET /auth authenticates with HTTP Basic Auth (Hubber
//      account email as username, account password as password), no
//      request body. Implemented using supplier.api_login (email) and
//      supplier.api_key (password), both trimmed before sending.
//
//   3. WHETHER "price" IS COST OR ALREADY A SELL PRICE — Hubber's
//      product schema has price/old_price sitting next to
//      category_commission and profit, which reads like "price" may
//      already be a suggested resale price with Hubber's own commission
//      baked in, not a raw cost. To stay safe, set this supplier's
//      markup_percent to 0 in the admin panel until you've confirmed
//      which it is — 0% just means you resell at exactly what Hubber
//      reports, no guessed extra margin on top.
//
//   4. SHAPE OF "photos" / "attributes" ON EACH PRODUCT — the doc marks
//      these as untyped arrays ([...]). normalizeParams()/pictures
//      below handle the most likely shapes defensively and never throw
//      on an unexpected one — worst case a product just imports with
//      no specs table instead of failing the whole sync.
//
// Run one manual sync from the admin dashboard after adding your key,
// then check "Логи" (adminLogs) — any of the four assumptions being
// wrong shows up there as an error message rather than silently
// importing wrong data.
// ---------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://office.hubber.pro/api/v1';

const capabilities = {
  catalog: true,
  stock: false,   // no separate lightweight price/stock-only endpoint documented
  createOrder: true,
  orderStatus: true,
  // Supports browseCatalog(): live, server-side-filtered, single-page
  // catalogue queries that never get written to our database. Powers the
  // manual_selection "Огляд каталогу" screen (routes/adminProducts.js).
  liveBrowse: true,
};

function baseUrl(supplier) {
  return (supplier.api_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

// ---- Token cache: one Bearer token per supplier row, refreshed a
// minute before it actually expires. ----
const tokenCache = new Map(); // supplierId -> { token, expiresAt }

async function getToken(supplier) {
  const cached = tokenCache.get(supplier.id);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  if (!supplier.api_login || !supplier.api_key) {
    throw new Error(
      `Постачальник "${supplier.name}" (Hubber) не має api_login/api_key — ` +
      `вкажіть email і пароль вашого акаунту Hubber у налаштуваннях постачальника`
    );
  }

  const companyId = supplier.config?.companyId;
  // .trim() defensively — a stray leading/trailing space from copy-paste
  // into the admin panel is invisible in the browser but breaks Basic
  // Auth silently (server sees it as "wrong password").
  const res = await axios.get(`${baseUrl(supplier)}/auth`, {
    auth: { username: supplier.api_login.trim(), password: supplier.api_key.trim() }, // CONFIRMED: Basic Auth, verified 200 via Swagger 2026-09-24
    params: companyId ? { company_id: companyId } : undefined,
    timeout: 15000,
    validateStatus: () => true, // handle non-2xx ourselves so the real Hubber error body isn't lost
  });

  if (res.status >= 400) {
    throw new Error(
      `Hubber /auth HTTP ${res.status}: ${JSON.stringify(res.data)} ` +
      `(company_id=${companyId ?? 'не задано'}, api_login=${supplier.api_login ? 'задано' : 'ПОРОЖНЬО'}, api_key=${supplier.api_key ? 'задано' : 'ПОРОЖНЬО'})`
    );
  }

  const data = res.data;
  const token = data?.token;
  if (!token) throw new Error(`Hubber /auth повернув 200, але без поля "token": ${JSON.stringify(data)}`);

  // "expires_at" is a guess at the real field name (doc showed it
  // translated as "термін дії закінчується"); fall back to a 25-minute
  // cache if the field isn't there so we still refresh reasonably often.
  const expiresAtRaw = data.expires_at || data.expired_at || data.expiresAt;
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw).getTime() : Date.now() + 25 * 60 * 1000;

  tokenCache.set(supplier.id, { token, expiresAt });
  return token;
}

// Masks a secret for safe display: keeps the first/last char, hides the
// rest, shows the exact length (length matters more than content here —
// a copy-paste that silently dropped or added a character is the most
// common cause of "works in the browser, fails from code").
function maskSecret(value) {
  if (!value) return { length: 0, preview: '(порожньо)' };
  const len = value.length;
  if (len <= 2) return { length: len, preview: '*'.repeat(len) };
  return { length: len, preview: `${value[0]}${'*'.repeat(len - 2)}${value[len - 1]}` };
}

// Diagnostic helper (not part of the adapter contract) — used by the
// admin-only /hubber-debug route to test this supplier's exact stored
// credentials against the real Hubber /auth endpoint and report back
// what was actually sent, without ever exposing the real secret.
async function debugAuth(supplier) {
  const rawLogin = supplier.api_login || '';
  const rawKey = supplier.api_key || '';
  const trimmedLogin = rawLogin.trim();
  const trimmedKey = rawKey.trim();
  const companyId = supplier.config?.companyId;

  const info = {
    baseUrl: baseUrl(supplier),
    companyId: companyId ?? null,
    login: { ...maskSecret(rawLogin), hadWhitespace: rawLogin !== trimmedLogin, containsColon: rawLogin.includes(':') },
    password: { ...maskSecret(rawKey), hadWhitespace: rawKey !== trimmedKey, containsColon: rawKey.includes(':') },
  };

  if (!trimmedLogin || !trimmedKey) {
    return { ...info, ok: false, status: null, message: 'api_login або api_key порожні в базі' };
  }

  try {
    const res = await axios.get(`${baseUrl(supplier)}/auth`, {
      auth: { username: trimmedLogin, password: trimmedKey },
      params: companyId ? { company_id: companyId } : undefined,
      headers: { accept: 'application/json' },
      timeout: 15000,
      validateStatus: () => true,
    });
    return {
      ...info,
      ok: res.status >= 200 && res.status < 300 && !!res.data?.token,
      status: res.status,
      message: res.status >= 400 ? JSON.stringify(res.data) : 'OK — токен отримано',
    };
  } catch (err) {
    return { ...info, ok: false, status: null, message: `Мережева помилка: ${err.message}` };
  }
}

async function request(supplier, method, path, { params, data } = {}) {
  const token = await getToken(supplier);
  const res = await axios({
    method,
    url: `${baseUrl(supplier)}${path}`,
    params,
    data,
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept-Language': 'uk-UA',
      'Content-Type': 'application/json',
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (res.status === 401) {
    // Token may have been revoked/expired early server-side — drop the
    // cache so the next call re-authenticates instead of looping on 401s.
    tokenCache.delete(supplier.id);
  }
  return res;
}

// ---- Category tree: Hubber only gives you a product's immediate
// category_id/category_name plus that category's own parent_id/name —
// no full ancestor chain. To fill our "section" (top-level grouping
// used in the sidebar) we fetch every category once per sync and walk
// each product's category up to its root. ----
//
// Cached for a few minutes per supplier — browseCatalog() below calls
// this on every single filter change/page turn in the admin's live
// catalogue browser, and re-fetching Hubber's whole category list
// (itself paginated) on every keystroke would be wasteful and slow.
const categoryMapCache = new Map(); // supplierId -> { map, expiresAt }
const CATEGORY_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchCategoryMap(supplier) {
  const cached = categoryMapCache.get(supplier.id);
  if (cached && cached.expiresAt > Date.now()) return cached.map;

  const map = new Map(); // id -> { name, parentId, parentName }
  const PAGE_SIZE = 100; // Hubber's documented and enforced max per page
  let page = 1;
  for (;;) {
    // NOTE: no "format" param — leave it at Hubber's default (hash-style
    // ids), because that's what /product/cursor's category_id values are
    // in too. Explicitly requesting format=id previously returned a
    // different id scheme that never matched a product's category_id,
    // silently breaking the parent-lookup walk below.
    //
    // "catalog" isn't documented for /category, but it IS documented for
    // /product ('my' vs 'all'), and undocumented endpoints on the same
    // API often share request handling — worth trying since /category
    // returning only a "my products" subset would explain why most
    // products (pulled with catalog=all) couldn't find their category
    // here at all. Harmless if Hubber just ignores it.
    const catalog = supplier.config?.catalog || 'all';
    const res = await request(supplier, 'get', '/category', { params: { limit: PAGE_SIZE, page, catalog } });
    if (res.status >= 400) throw new Error(`Hubber /category HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    const rows = Array.isArray(res.data) ? res.data : [];
    if (!rows.length) break;
    for (const c of rows) {
      map.set(String(c.id), { name: c.name, parentId: c.parent_id ? String(c.parent_id) : null, parentName: c.parent_name || null });
    }
    if (rows.length < PAGE_SIZE) break;
    page += 1;
  }

  categoryMapCache.set(supplier.id, { map, expiresAt: Date.now() + CATEGORY_CACHE_TTL_MS });
  return map;
}

// Public (adapter-contract) version for the admin "Огляд каталогу" filter
// panel: a flat array with parentId so the frontend can build a
// category → subcategory cascade, instead of the internal Map shape
// fetchCategoryMap uses for the section-resolving walk above.
async function fetchCategories(supplier) {
  const map = await fetchCategoryMap(supplier);
  return [...map.entries()].map(([id, c]) => ({ id, name: c.name, parentId: c.parentId }));
}



// fallbackName: the product's OWN category_name, straight from the
// product payload (always present, regardless of whether /category's
// tree happens to cover that category). Used whenever the id-based
// walk can't find a match, so a gap in /category's coverage degrades
// to "grouped by its immediate category name" instead of dumping the
// product into "Без категорії".
function resolveSection(categoryId, categoryMap, fallbackName) {
  if (!categoryId) return fallbackName || null;
  let current = categoryMap.get(String(categoryId));
  if (!current) return fallbackName || null;
  const seen = new Set();
  while (current.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = categoryMap.get(current.parentId);
    if (!parent) return current.parentName || current.name;
    current = parent;
  }
  return current.name;
}

// Normalizes the "photos" field into a plain array of URL strings —
// handles both ["url", ...] and [{url: "..."}, ...] shapes.
function normalizePictures(photos, mainPicture) {
  const list = [];
  if (mainPicture) list.push(mainPicture);
  if (Array.isArray(photos)) {
    for (const p of photos) {
      const url = typeof p === 'string' ? p : (p?.url || p?.path || p?.src);
      if (url && !list.includes(url)) list.push(url);
    }
  }
  return list;
}

// Normalizes the "attributes" field into a flat { "Спецификація": "значення" }
// object — the shape our product-detail specs table expects. Handles
// {name, value}, {attributeId, value} and a couple of common variants;
// silently skips anything it doesn't recognise rather than throwing.
// Turns a product's specs into one flat { "Назва характеристики": "значення" }
// map, from TWO different shapes Hubber's schema mixes on the same product:
//
//   options: { "Тип": "Универсальная батарея", ... }             — already
//     flat strings, used as-is.
//
//   attributes: [{ name: "Диаметр", values: [{ value: "21 см", id: ... }] }]
//     — values is an array of OBJECTS, not strings. The bug this replaced
//     called value.join(', ') directly on that array, which stringifies
//     each {value, id} object as "[object Object]" instead of reading its
//     .value field — that literal text is what ended up saved to
//     products.params and shown in the storefront's characteristics table.
function normalizeParams(options, attributes) {
  const params = {};

  if (options && typeof options === 'object' && !Array.isArray(options)) {
    for (const [key, value] of Object.entries(options)) {
      if (key && value != null && value !== '') params[key] = String(value);
    }
  }

  if (Array.isArray(attributes)) {
    for (const a of attributes) {
      if (!a || typeof a !== 'object') continue;
      const key = a.name || a.attribute_name || a.attributeName;
      if (!key) continue;

      let value;
      if (Array.isArray(a.values)) {
        // Each entry is {value, id} per the doc — pull out just .value.
        value = a.values
          .map((v) => (v && typeof v === 'object' ? v.value : v))
          .filter((v) => v != null && v !== '')
          .join(', ');
      } else if (a.value != null) {
        value = Array.isArray(a.value) ? a.value.join(', ') : String(a.value);
      }

      if (value) params[String(key)] = value;
    }
  }

  return params;
}

function normalizeProduct(p, categoryMap) {
  return {
    supplierProductId: String(p.id),
    name: p.name || '',
    description: p.description || '',
    price: Number(p.price) || 0, // see note 3 at the top of this file
    categoryId: p.category_id ? String(p.category_id) : null,
    categoryName: p.category_name || null,
    section: resolveSection(p.category_id, categoryMap, p.category_name),
    pictureUrl: p.main_picture || null,
    pictures: normalizePictures(p.photos, p.main_picture),
    vendorCode: p.vendor_code || null,
    vendor: p.brand || null,
    params: normalizeParams(p.options, p.attributes),
    stock: Number.isFinite(p.stock_quantity) ? p.stock_quantity : null,
    // availability: 1 = on sale. status_id semantics aren't fully
    // documented, so we deliberately don't also filter on status here —
    // see note 4 style caveat: if products you expect to see are
    // missing after a sync, this is the first place to check.
    available: p.availability === 1 || p.availability === true,
    // Everything else Hubber's schema exposes on a product that our own
    // columns don't have room for, kept verbatim in products.raw_meta so
    // the admin "add products" filter panel can offer every selection
    // Hubber itself supports (see /product/cursor#marketplace params):
    //   statusId / status         -> filter by ?status= (4, 7)
    //   isTop                     -> filter by ?mark=top
    //   editedAt                  -> filter by ?start_edited_at/end_edited_at
    //   brandId                   -> a more precise brand filter than the
    //                                free-text vendor/brand name
    //   hubberSupplierId/Name/Rating -> Hubber is itself an aggregator of
    //     many underlying suppliers (its own ?company_id= filter) — this
    //     is the ACTUAL seller behind the product, not our "Hubber"
    //     supplier row, and is usually the single most useful filter for
    //     deciding which products to trust and import.
    //   categoryCommission/profit -> Hubber's own suggested margin figures
    meta: {
      statusId: Number.isFinite(p.status_id) ? p.status_id : null,
      status: p.status || null,
      isTop: p.is_top === 1 || p.is_top === true,
      editedAt: p.edited_at || null,
      moderatedAt: p.moderated_at || null,
      createdAt: p.created_at || null,
      brandId: Number.isFinite(p.brand_id) ? p.brand_id : null,
      hubberSupplierId: p.supplier_id != null ? String(p.supplier_id) : null,
      hubberSupplierName: p.supplier_name || null,
      hubberSupplierRating: Number.isFinite(p.supplier_rating) ? p.supplier_rating : null,
      categoryCommission: Number.isFinite(p.category_commission) ? p.category_commission : null,
      profit: Number.isFinite(p.profit) ? p.profit : null,
      oldPrice: Number.isFinite(p.old_price) ? p.old_price : null,
    },
  };
}

// Hubber's date filters want 'YYYY-MM-DD HH:mm:ss' per the doc's own
// example ('2021-01-01 00:00:00'), not a full ISO string with a T/Z.
function toHubberDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------
// Live catalogue browsing — powers the admin "Огляд каталогу" screen for
// manual_selection suppliers. Queries Hubber's own filters directly and
// returns ONE page of normalized products WITHOUT writing anything to our
// database — this is the whole point of the feature: an admin can filter
// and page through Hubber's entire catalogue (tens of thousands of items)
// while the server only ever holds one ~50-row page in memory at a time,
// and our database is only touched later, for the handful of products the
// admin actually clicks "Імпортувати" on (see routes/adminProducts.js).
//
// Uses /product#marketplace (page-based), NOT /product/cursor#marketplace —
// the cursor endpoint doesn't support filtering by category_id at all,
// while this one does, which is why fetchCatalog (the full sync) and
// browseCatalog deliberately use two different Hubber endpoints.
//
// filters (all optional):
//   id            — Hubber's own product id, full-match per the doc
//   name          — partial match on product name
//   vendorCode    — full match on article/vendor_code
//   markTop       — true -> only "top" marked products
//   companyId     — Hubber's OWN underlying-supplier id (their aggregation
//                   of many real sellers) — NOT our suppliers.id
//   categoryId    — Hubber's own category or subcategory id (see
//                   fetchCategories() for the full tree)
//   priceFrom/priceTo
//   availability  — 0 | 1
//   status        — 4 | 7 (Hubber's moderation status_id)
//   startEditedAt / endEditedAt — Date | ISO string
// page: 1-based page number (Hubber's own "page" param), defaults to 1.
// ---------------------------------------------------------------------
async function browseCatalog(supplier, filters = {}, page = 1) {
  const categoryMap = await fetchCategoryMap(supplier);
  const pageLimit = 50;

  const params = {
    page: Math.max(1, parseInt(page, 10) || 1),
    limit: pageLimit,
    view: 'full',
    catalog: supplier.config?.catalog || 'all',
    id: filters.id || undefined,
    name: filters.name || undefined,
    mark: filters.markTop ? 'top' : undefined,
    vendor_code: filters.vendorCode || undefined,
    company_id: filters.companyId || undefined,
    category_id: filters.categoryId || undefined,
    availability: filters.availability != null && filters.availability !== '' ? Number(filters.availability) : undefined,
    status: filters.status || undefined,
    start_edited_at: filters.startEditedAt ? toHubberDateTime(filters.startEditedAt) : undefined,
    end_edited_at: filters.endEditedAt ? toHubberDateTime(filters.endEditedAt) : undefined,
  };
  // Hubber documents "price" as a nested {from, to} object; the safest
  // real-world guess for how a query string carries that is bracket
  // notation (price[from]=1&price[to]=100), the common convention for
  // this style of API. Sent as separate top-level keys since axios
  // won't serialize a plain nested object the way Hubber's doc implies.
  if (filters.priceFrom != null && filters.priceFrom !== '') params['price[from]'] = Number(filters.priceFrom);
  if (filters.priceTo != null && filters.priceTo !== '') params['price[to]'] = Number(filters.priceTo);

  const res = await request(supplier, 'get', '/product', { params });
  if (res.status >= 400) {
    throw new Error(`Hubber /product HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  }

  const rows = Array.isArray(res.data) ? res.data : (res.data?.items || []);
  const items = rows.map((p) => normalizeProduct(p, categoryMap));

  const headerTotal = res.headers?.['x-pagination-total-count'] ?? res.headers?.['x-total-count'];
  const total = headerTotal != null ? Number(headerTotal) : null;
  const hasMore = total != null ? params.page * pageLimit < total : rows.length === pageLimit;

  return { items, page: params.page, total, hasMore };
}

// GET /product/cursor#marketplace — cursor-paginated listing of every
// product Hubber makes available to your marketplace account.
//
// options.editedSince (Date | ISO string), when given, is forwarded as
// start_edited_at so HUBBER filters server-side — used by the manual-
// selection "lightweight refresh" path (see catalogSync.js) so we never
// pull the full remote catalogue just to update prices/stock on products
// already imported. Full, unfiltered calls (options.editedSince absent)
// should only ever happen for suppliers WITHOUT manual_selection.
async function fetchCatalog(supplier, onBatch, options) {
  const categoryMap = await fetchCategoryMap(supplier);
  const catalog = supplier.config?.catalog || 'all'; // 'my' | 'all'
  const pageLimit = 100; // Hubber's documented and enforced max per page

  let cursor = undefined;
  let imported = 0;
  let reportedTotal = false;

  for (;;) {
    const res = await request(supplier, 'get', '/product/cursor', {
      params: {
        cursor,
        limit: pageLimit,
        view: 'full',
        catalog,
        start_edited_at: options?.editedSince ? toHubberDateTime(options.editedSince) : undefined,
      },
    });
    if (res.status >= 400) {
      throw new Error(`Hubber /product/cursor HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    }

    // Best-effort: if Hubber sends a total-count pagination header (as it
    // does on several other endpoints per the docs), forward it once so
    // the admin panel can show a real % instead of just a running count.
    // Harmless no-op if the header isn't there for this endpoint.
    if (!reportedTotal) {
      const headerTotal = res.headers?.['x-pagination-total-count'] ?? res.headers?.['x-total-count'];
      if (headerTotal != null) {
        options?.onProgress?.(Number(headerTotal));
        reportedTotal = true;
      }
    }

    const rows = Array.isArray(res.data) ? res.data : (res.data?.items || []);
    if (!rows.length) break;

    const batch = rows.map((p) => normalizeProduct(p, categoryMap));
    await onBatch(batch);
    imported += batch.length;

    if (rows.length < pageLimit) break;
    // The next cursor is the id of the last item returned, per the doc's
    // description of the cursor parameter ("pass the id of the last
    // element to get the next N").
    cursor = rows[rows.length - 1].id;
    if (!cursor) break;
  }

  return imported;
}

// Builds Hubber's single free-text "delivery_data" field from our
// structured delivery choice — same idea as the TradeEvo adapter, since
// Hubber's order schema (per the doc) has no separate city/branch fields.
function buildDeliveryData(order) {
  const city = order.city || '';
  if (order.deliveryMethod === 'courier') {
    return [city, order.courierAddress].filter(Boolean).join(', ') || 'Кур\'єрська доставка';
  }
  return [city, order.npBranch ? `Нова пошта, ${order.npBranch}` : 'Нова пошта'].filter(Boolean).join(', ');
}

// POST /order/create
async function createOrder(supplier, order) {
  const alias = `SITE-${order.groupId}`;
  const payload = {
    client_name: order.customerName,
    client_phone: order.customerPhone,
    order_notes: order.comment || undefined,
    delivery_data: buildDeliveryData(order),
    alias,
    products: order.items.map((item) => ({
      id: item.supplierProductId,
      quantity: item.quantity,
    })),
  };

  let res;
  try {
    res = await request(supplier, 'post', '/order/create', { data: payload });
  } catch (err) {
    return { ok: false, reason: 'network_error', error: err.message };
  }

  if (res.status >= 400) {
    return {
      ok: false,
      reason: 'submit_failed',
      error: res.data?.message || (Array.isArray(res.data) ? res.data.map((e) => e.message).join('; ') : JSON.stringify(res.data)),
    };
  }

  // The doc's own success example showed the id under a translated key —
  // check both the real field name and that fallback just in case.
  const supplierOrderId = res.data?.id ?? res.data?.['Ідентифікатор замовлення'];
  return { ok: true, supplierOrderId: supplierOrderId != null ? String(supplierOrderId) : alias, raw: res.data };
}

// GET /order?id=... — status + TTN for an order already placed.
async function getOrderStatus(supplier, supplierOrderId) {
  const res = await request(supplier, 'get', '/order', { params: { id: supplierOrderId } });
  if (res.status >= 400) throw new Error(`Hubber /order HTTP ${res.status}: ${JSON.stringify(res.data)}`);

  const order = Array.isArray(res.data) ? res.data[0] : res.data;
  const outgoing = order?.outgoing?.[0];
  return {
    status: outgoing?.status?.title || order?.status?.title || null,
    ttn: outgoing?.tracking_num || null,
  };
}

module.exports = { name: 'hubber', capabilities, fetchCatalog, browseCatalog, fetchCategories, createOrder, getOrderStatus, debugAuth };
