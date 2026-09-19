const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const { pool } = require('../db');

// Both feeds use the same YML/XML structure dropshipping.ua exports, so one
// function handles either URL.
async function importFeed(feedUrl) {
  const { data: xml } = await axios.get(feedUrl, { timeout: 20000 });
  const parsed = await parseStringPromise(xml, { explicitArray: true, trim: true });

  const offers = parsed?.yml_catalog?.shop?.[0]?.offers?.[0]?.offer || [];
  let upserted = 0;

  for (const offer of offers) {
    const id = offer.$.id;
    const available = offer.$.available === 'true';
    const price = parseFloat(offer.price?.[0] || '0');
    const name = offer.name?.[0] || '';
    const description = offer.description?.[0] || '';
    const categoryId = offer.categoryId?.[0] || null;
    const vendor = offer.vendor?.[0] || null;
    const picture = Array.isArray(offer.picture) ? offer.picture[0] : null;

    await pool.query(
      `INSERT INTO products (id, name, description, price, category_id, picture_url, vendor, available, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         category_id = EXCLUDED.category_id,
         picture_url = EXCLUDED.picture_url,
         vendor = EXCLUDED.vendor,
         available = EXCLUDED.available,
         updated_at = now()`,
      [id, name, description, price, categoryId, picture, vendor, available]
    );
    upserted++;
  }

  return upserted;
}

// Pulls every feed URL configured in .env and logs a short summary.
async function syncAllFeeds() {
  const feedUrls = [
    process.env.FEED_URL_ZOOTOVARY,
    process.env.FEED_URL_AMUNITSIYA,
  ].filter(Boolean);

  for (const url of feedUrls) {
    try {
      const count = await importFeed(url);
      console.log(`[feed sync] ${url} -> ${count} products upserted`);
    } catch (err) {
      // A single feed failing (e.g. dropshipping.ua is briefly down) should
      // never crash the whole sync job or the server.
      console.error(`[feed sync] failed for ${url}:`, err.message);
    }
  }
}

module.exports = { importFeed, syncAllFeeds };
