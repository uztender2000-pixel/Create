const { getTermsStatus } = require('../services/termsService');

// Ставиться ПІСЛЯ requireAuth. Не пускає покупця далі (оформлення замовлення,
// відгуки), поки він не прийняв чинну редакцію правил та умов.
// Фронтенд розпізнає відповідь за полем termsRequired і показує вікно з правилами.
async function requireTermsAccepted(req, res, next) {
  try {
    const status = await getTermsStatus(req.user.id);
    if (status && status.needsAcceptance) {
      return res.status(403).json({
        error: 'Спершу ознайомтеся з правилами та умовами й підтвердіть згоду',
        termsRequired: true,
      });
    }
    next();
  } catch (err) {
    console.error('[terms] перевірка згоди не вдалася:', err.message);
    res.status(500).json({ error: 'Не вдалося перевірити згоду з правилами' });
  }
}

module.exports = { requireTermsAccepted };
