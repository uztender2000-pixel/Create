const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const { pool } = require('../db');

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

// Walks up parentId links from a leaf category to find the top-level
// section (the ancestor with no parentId) — e.g. "3417" (Комбінезони) ->
// "3412" (Одяг) -> "841" (Зоотовари). Returns that root's name.
// This is what lets the site auto-sort products into sections without you
// telling it which section each feed belongs to.
function findSectionName(categoryId, tree, depth = 0) {
  const node = tree[categoryId];
  if (!node || depth > 10) return null; // depth guard against malformed/circular data
  if (!node.parentId) return node.name; // this IS the root — it's the section
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
    const description = offer.description?.[0] || '';
    const categoryId = offer.categoryId?.[0] || null;
    const categoryName = categoryId ? (tree[categoryId]?.name || null) : null;
    const section = categoryId ? findSectionName(categoryId, tree) : null;
    const vendor = offer.vendor?.[0] || null;
    const picture = Array.isArray(offer.picture) ? offer.picture[0] : null;

    await pool.query(
      `INSERT INTO products (id, name, description, price, retail_price, category_id, category_name, section, picture_url, vendor, available, updated_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         retail_price = EXCLUDED.price,
         category_id = EXCLUDED.category_id,
         category_name = EXCLUDED.category_name,
         section = EXCLUDED.section,
         picture_url = EXCLUDED.picture_url,
         vendor = EXCLUDED.vendor,
         available = EXCLUDED.available,
         updated_at = now()`,
      [id, name, description, price, categoryId, categoryName, section, picture, vendor, available]
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
