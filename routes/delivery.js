const express = require('express');
const axios = require('axios');

const router = express.Router();
const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/';

async function novaPoshtaRequest(modelName, calledMethod, methodProperties) {
  const apiKey = process.env.NOVA_POSHTA_API_KEY;
  if (!apiKey) {
    const err = new Error('NOVA_POSHTA_API_KEY not configured');
    err.notConfigured = true;
    throw err;
  }

  const { data } = await axios.post(
    NP_API_URL,
    { apiKey, modelName, calledMethod, methodProperties },
    { timeout: 10000 }
  );

  if (!data.success) {
    throw new Error((data.errors && data.errors[0]) || 'Nova Poshta API error');
  }
  return data.data;
}

// GET /api/delivery/cities?q=Київ — city search for the autocomplete field.
router.get('/cities', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);

    const data = await novaPoshtaRequest('Address', 'getCities', { FindByString: q, Limit: 15 });
    res.json(data.map((c) => ({ ref: c.Ref, name: c.Description, area: c.AreaDescription })));
  } catch (err) {
    if (err.notConfigured) {
      return res.status(503).json({ error: 'Доставку Новою поштою ще не налаштовано на сайті' });
    }
    console.error('[delivery] cities failed:', err.message);
    res.status(500).json({ error: 'Не вдалося завантажити список міст' });
  }
});

// GET /api/delivery/warehouses?cityRef=... — branches for the chosen city.
router.get('/warehouses', async (req, res) => {
  try {
    const cityRef = req.query.cityRef;
    if (!cityRef) return res.status(400).json({ error: 'cityRef is required' });

    const data = await novaPoshtaRequest('AddressGeneral', 'getWarehouses', { CityRef: cityRef, Limit: 500 });
    res.json(data.map((w) => ({ ref: w.Ref, name: w.Description })));
  } catch (err) {
    if (err.notConfigured) {
      return res.status(503).json({ error: 'Доставку Новою поштою ще не налаштовано на сайті' });
    }
    console.error('[delivery] warehouses failed:', err.message);
    res.status(500).json({ error: 'Не вдалося завантажити список відділень' });
  }
});

module.exports = router;
