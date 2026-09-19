const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const { pool } = require('../db');

// Applied only when a product is first inserted — never overwrites a price
// you set manually (e.g. via the /retail-price endpoint for your finalists).
const DEFAULT_MARKUP = 1.2;

// Rounds up to the nearest 10 UAH so prices look like normal retail prices.
function roundRetailPrice(cost) {
  return Math.ceil((cost * DEFAULT_MARKUP) / 10) * 10;
}

// dropshipping.ua feeds include a <categories> block that maps each
// categoryId to a human-readable name — e.g. <category id="3422">Нашийники</category>.
// This reads that block into a plain { id: name } map.
function buildCategoryMap(parsed) {
  const rawCategories = parsed?.yml_catalog?.shop?.[0]?.categories?.[0]?.category || [];
  const map = {};
  for (const cat of rawCategories) {
    const id = cat?.$?.id;
    // xml2js puts the text content under `_` when the element also has attributes.
    const name = typeof cat === 'object' ? (cat._ || '').trim() : String(cat).trim();
    if (id) map[id] = name;
  }
  return map;
}

// Imports one feed. `section` is the human label you choose for this feed
// as a whole (e.g. "Зоотовари", "Дім", "Парфумерія") — stored on every
// product from this feed so the site can group by section.
async function importFeed(feedUrl, section) {
  const { data: xml } = await axios.get(feedUrl, { timeout: 30000 });
  const parsed = await parseStringPromise(xml, { explicitArray: true, trim: true });

  const categoryMap = buildCategoryMap(parsed);
  const offers = parsed?.yml_catalog?.shop?.[0]?.offers?.[0]?.offer || [];
  let upserted = 0;

  for (const offer of offers) {
    const id = offer.$.id;
    const available = offer.$.available === 'true';
    const price = parseFloat(offer.price?.[0] || '0');
    const name = offer.name?.[0] || '';
    const description = offer.description?.[0] || '';
    const categoryId = offer.categoryId?.[0] || null;
    const categoryName = categoryId ? (categoryMap[categoryId] || null) : null;
    const vendor = offer.vendor?.[0] || null;
    const picture = Array.isArray(offer.picture) ? offer.picture[0] : null;
    const defaultRetailPrice = roundRetailPrice(price);

    await pool.query(
      `INSERT INTO products (id, name, description, price, retail_price, category_id, category_name, section, picture_url, vendor, available, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         retail_price = COALESCE(products.retail_price, EXCLUDED.retail_price),
         category_id = EXCLUDED.category_id,
         category_name = EXCLUDED.category_name,
         section = EXCLUDED.section,
         picture_url = EXCLUDED.picture_url,
         vendor = EXCLUDED.vendor,
         available = EXCLUDED.available,
         updated_at = now()`,
      [id, name, description, price, defaultRetailPrice, categoryId, categoryName, section, picture, vendor, available]
    );
    upserted++;
  }

  return upserted;
}

// Reads FEED_1_URL/FEED_1_SECTION through FEED_5_URL/FEED_5_SECTION from
// the environment and imports every one that's configured. Add or remove
// feeds just by editing these env vars on Render — no code changes needed.
function loadFeedConfig() {
  const feeds = [];
  for (let i = 1; i <= 5; i++) {
    const url = process.env[`FEED_${i}_URL`];
    const section = process.env[`FEED_${i}_SECTION`];
    if (url) feeds.push({ url, section: section || `Розділ ${i}` });
  }
  return feeds;
}

async function syncAllFeeds() {
  const feeds = loadFeedConfig();

  if (feeds.length === 0) {
    console.warn('[feed sync] No FEED_1_URL..FEED_5_URL configured — nothing to import.');
    return;
  }

  for (const { url, section } of feeds) {
    try {
      const count = await importFeed(url, section);
      console.log(`[feed sync] [${section}] ${url} -> ${count} products upserted`);
    } catch (err) {
      // A single feed failing should never crash the whole sync job or the server.
      console.error(`[feed sync] failed for ${url}:`, err.message);
    }
  }
}

module.exports = { importFeed, syncAllFeeds, loadFeedConfig };
