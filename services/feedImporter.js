const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const { pool } = require('../db');

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

// dropshipping.ua feeds include a <categories> block that's a full tree:
// <category id="841">Зоотовари</category>
// <category id="3412" parentId="841">Одяг для домашніх тварин</category>
// <category id="3417" parentId="3412">Комбінезони для тварин</category>
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
// of something meaningful ("корневая" = "root" in Russian, left over from
// the supplier's own default setup). Override known placeholders here.
const SECTION_NAME_OVERRIDES = {
  'корневая': 'Товари-бестселери🔥',
};

// Walks up parentId links from a leaf category to find the top-level
// section (the ancestor with no parentId) — e.g. "3417" (Комбінезони) ->
// "3412" (Одяг) -> "841" (Зоотовари). Returns that root's name.
// This is what lets the site auto-sort products into sections without you
// telling it which section each feed belongs to.
function findSectionName(categoryId, tree, depth = 0) {
  const node = tree[categoryId];
  if (!node || depth > 10) return null; // depth guard against malformed/circular data
  if (!node.parentId) {
    const name = node.name;
    return SECTION_NAME_OVERRIDES[name.trim().toLowerCase()] || name;
  }
  return findSectionName(node.parentId, tree, depth + 1);
}

// Imports one feed. Section and category name are derived automatically
// from the feed's own category tree — no manual labeling needed.
async function importFeed(feedUrl) {
  const { data: xml } = await axios.get(feedUrl, { timeout: 30000 });
  const parsed = await parseStringPromise(xml, { explicitArray: true, trim: true });

  const tree = buildCategoryTree(parsed);
  const offers = parsed?.yml_catalog?.shop?.[0]?.offers?.[0]?.offer || [];
  let upserted = 0;

  for (const offer of offers) {
    const id = offer.$.id;
    const available = offer.$.available === 'true';
    const price = parseFloat(offer.price?.[0] || '0');
    const name = offer.name?.[0] || '';
    const description = cleanDescription(offer.description?.[0] || '');
    const categoryId = offer.categoryId?.[0] || null;
    const categoryName = categoryId ? (tree[categoryId]?.name || null) : null;
    const section = categoryId ? findSectionName(categoryId, tree) : null;
    const vendor = offer.vendor?.[0] || null;
    const vendorCode = offer.vendorCode?.[0] || null;

    // Every <picture> the feed gives this offer, in order — not just the first.
    const pictures = Array.isArray(offer.picture) ? offer.picture : (offer.picture ? [offer.picture] : []);
    const picture = pictures[0] || null;

    // <param name="Об'єм" unit="мл">500</param> — xml2js gives each as
    // { _: '500', $: { name: "Об'єм", unit: 'мл' } }. Build a flat spec
    // object for the detail page's characteristics table.
    const rawParams = Array.isArray(offer.param) ? offer.param : (offer.param ? [offer.param] : []);
    const params = {};
    for (const p of rawParams) {
      const paramName = p?.$?.name;
      const unit = p?.$?.unit;
      const value = typeof p === 'object' ? (p._ || '').trim() : String(p).trim();
      if (paramName) params[paramName] = unit ? `${value} ${unit}` : value;
    }

    await pool.query(
      `INSERT INTO products (id, name, description, price, retail_price, category_id, category_name, section, picture_url, pictures, vendor_code, params, vendor, available, updated_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         retail_price = EXCLUDED.price,
         category_id = EXCLUDED.category_id,
         category_name = EXCLUDED.category_name,
         section = EXCLUDED.section,
         picture_url = EXCLUDED.picture_url,
         pictures = EXCLUDED.pictures,
         vendor_code = EXCLUDED.vendor_code,
         params = EXCLUDED.params,
         vendor = EXCLUDED.vendor,
         available = EXCLUDED.available,
         updated_at = now()`,
      [id, name, description, price, categoryId, categoryName, section, picture, pictures, vendorCode, JSON.stringify(params), vendor, available]
    );
    upserted++;
  }

  return upserted;
}

// Reads FEED_1_URL through FEED_5_URL from the environment — just URLs now,
// no section labels needed, since the section is worked out automatically
// from each product's place in the feed's own category tree.
function loadFeedUrls() {
  const urls = [];
  for (let i = 1; i <= 5; i++) {
    const url = process.env[`FEED_${i}_URL`];
    if (url) urls.push(url);
  }
  return urls;
}

async function syncAllFeeds() {
  const urls = loadFeedUrls();

  if (urls.length === 0) {
    console.warn('[feed sync] No FEED_1_URL..FEED_5_URL configured — nothing to import.');
    return;
  }

  for (const url of urls) {
    try {
      const count = await importFeed(url);
      console.log(`[feed sync] ${url} -> ${count} products upserted`);
    } catch (err) {
      console.error(`[feed sync] failed for ${url}:`, err.message);
    }
  }
}

module.exports = { importFeed, syncAllFeeds, loadFeedUrls };
