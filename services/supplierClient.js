const axios = require('axios');

// Sends an order to the supplier's API so it's placed automatically instead
// of you doing it by hand in the dropshipping.ua cabinet.
//
// THIS NEEDS REAL CREDENTIALS FROM DROPSHIPPING.UA SUPPORT BEFORE IT DOES
// ANYTHING. Until SUPPLIER_API_URL and SUPPLIER_API_KEY are set in your
// environment, submitOrderToSupplier() simply does nothing and returns
// { submitted: false } — your current manual + Telegram-notification flow
// keeps working exactly as before. Nothing breaks by having this file here
// unconfigured.
//
// The request shape below follows the common pattern used by Ukrainian
// dropshipping platforms (e.g. mydrop.com.ua's documented order API):
// POST with an X-API-KEY header, JSON body with customer info and a
// products array. Once you have dropshipping.ua's actual API docs, this
// is very likely the only function that needs adjusting — everything else
// (orders.js, cart.js) just calls submitOrderToSupplier() and doesn't care
// about the specific request format.
async function submitOrderToSupplier({ customerName, customerPhone, city, npBranch, comment, items }) {
  const apiUrl = process.env.SUPPLIER_API_URL;
  const apiKey = process.env.SUPPLIER_API_KEY;

  if (!apiUrl || !apiKey) {
    return { submitted: false, reason: 'not_configured' };
  }

  const payload = {
    name: customerName,
    phone: customerPhone,
    city: city || null,
    np_branch: npBranch || null,
    description: comment || '',
    order_source: 'Сайт',
    products: items.map((item) => ({
      // product_id here must be the supplier's own product/offer id — the
      // same `id` your feed gives each offer, which you already store as
      // products.id in your database.
      product_id: item.productId,
      amount: item.quantity,
    })),
  };

  try {
    const { data } = await axios.post(apiUrl, payload, {
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return { submitted: true, response: data };
  } catch (err) {
    // Never let a supplier-API failure break your own order flow — the
    // order is already saved in your database and you already got the
    // Telegram notification either way. Log it so you notice and can
    // place that one order manually as a fallback.
    console.error('[supplier API] submission failed:', err.response?.data || err.message);
    return { submitted: false, reason: 'api_error', error: err.response?.data || err.message };
  }
}

module.exports = { submitOrderToSupplier };
