const { pool } = require('../db');
const { sendEmail } = require('./emailClient');
const { SHOP_NAME } = require('./brand');
const { allowedOrigins } = require('./security');

// ---------------------------------------------------------------------------
// Сповіщення зі списку бажаного: покупець отримує ОДИН лист, коли
//   • товар зі списку знову з'явився в наявності, або
//   • ціна знизилась щонайменше на WISHLIST_PRICE_DROP_PCT % (за замовчуванням 5) відносно ціни, яку ми «пам'ятаємо».
// «Пам'ятана» ціна й наявність зберігаються в рядку списку (price_snapshot / available_snapshot) і оновлюються
// після кожного листа та при зростанні ціни — тому про одну й ту саму зміну двічі не повідомляємо.
// Лист отримують лише покупці з підтвердженою поштою, які не вимкнули сповіщення (users.wishlist_alerts).
// ---------------------------------------------------------------------------

const PRICE_DROP_PCT = Math.max(1, Number(process.env.WISHLIST_PRICE_DROP_PCT || 5));
const MAX_USERS_PER_RUN = 300;
let running = false;

const money = (n) => `${Math.round(Number(n)).toLocaleString('uk-UA')} грн`;

// Формування тексту листа (чиста функція — легко тестується).
function buildMessage(userName, events, siteUrl) {
  const lines = events.map((e) => (e.kind === 'back'
    ? `• «${e.name}» — знову в наявності (${money(e.now)})`
    : `• «${e.name}» — ціна знизилась: було ${money(e.old)}, стало ${money(e.now)} (−${Math.round((1 - e.now / e.old) * 100)}%)`));
  const subject = events.length === 1
    ? (events[0].kind === 'back' ? `Товар зі списку бажаного знову в наявності` : `Подешевшав товар зі списку бажаного`)
    : `Зміни у вашому списку бажаного (${events.length})`;
  const text = `Вітаємо${userName ? `, ${userName}` : ''}!\n\nЩо змінилось у вашому списку бажаного:\n\n${lines.join('\n')}\n\n`
    + `${siteUrl ? `Перейти до магазину: ${siteUrl}\n\n` : ''}`
    + `Ціни й наявність швидко змінюються — якщо товар вам потрібен, не відкладайте.\n\n`
    + `Не хочете отримувати такі листи? У кабінеті відкрийте «Бажане» та зніміть позначку «Сповіщати про ціну та наявність».\n\n${SHOP_NAME}`;
  return { subject, text };
}

async function runWishlistAlerts({ send = sendEmail } = {}) {
  if (running) return { skipped: 'already_running' };
  running = true;
  const stats = { users: 0, events: 0, sent: 0, failed: 0, notConfigured: false };
  try {
    // 0) Запам'ятати ціну, якщо її не було на момент додавання.
    await pool.query(`UPDATE wishlist w SET price_snapshot = p.retail_price
                        FROM products p WHERE p.id = w.product_id AND w.price_snapshot IS NULL AND p.retail_price IS NOT NULL`);

    const { rows } = await pool.query(
      `SELECT w.user_id, w.product_id, w.price_snapshot, w.available_snapshot,
              p.name, p.retail_price, p.available, u.email, u.name AS user_name
         FROM wishlist w
         JOIN products p ON p.id = w.product_id
         JOIN users u ON u.id = w.user_id
        WHERE u.wishlist_alerts AND u.email_verified AND u.email IS NOT NULL AND p.available = true
          AND ( w.available_snapshot = false
                OR (p.retail_price IS NOT NULL AND w.price_snapshot IS NOT NULL AND p.retail_price <= w.price_snapshot * (1 - $1::numeric / 100)) )
        ORDER BY w.user_id LIMIT $2`, [PRICE_DROP_PCT, MAX_USERS_PER_RUN * 5]);

    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, { email: r.email, name: r.user_name, events: [] });
      byUser.get(r.user_id).events.push({
        productId: r.product_id, name: r.name, now: Number(r.retail_price),
        kind: r.available_snapshot === false ? 'back' : 'drop', old: r.price_snapshot == null ? null : Number(r.price_snapshot),
      });
    }

    const siteUrl = allowedOrigins[0] || '';
    for (const [userId, u] of byUser) {
      if (stats.users >= MAX_USERS_PER_RUN) break;
      stats.users += 1; stats.events += u.events.length;
      const { subject, text } = buildMessage(u.name, u.events, siteUrl);
      const res = await send(u.email, subject, text);
      if (res && res.sent) {
        stats.sent += 1;
        // Оновлюємо «пам'ятані» ціну й наявність, щоб про цю зміну більше не повідомляти.
        await pool.query(
          `UPDATE wishlist w SET price_snapshot = p.retail_price, available_snapshot = p.available
             FROM products p WHERE p.id = w.product_id AND w.user_id = $1 AND w.product_id = ANY($2::bigint[])`,
          [userId, u.events.map((e) => e.productId)]);
      } else if (res && res.reason === 'not_configured') {
        stats.notConfigured = true;   // пошту не налаштовано: нічого не позначаємо, щоб надіслати, коли її налаштують
        break;
      } else {
        stats.failed += 1;            // тимчасова помилка: повторимо наступного разу
      }
    }

    // Фоновий облік змін: товар зник із наявності → запам'ятати (щоб повернення було помітним);
    // ціна зросла → піднімаємо «пам'ятану» ціну (щоб наступне зниження порівнювалось із актуальною).
    await pool.query(`UPDATE wishlist w SET available_snapshot = false FROM products p
                       WHERE p.id = w.product_id AND p.available = false AND w.available_snapshot IS DISTINCT FROM false`);
    await pool.query(`UPDATE wishlist w SET price_snapshot = p.retail_price FROM products p
                       WHERE p.id = w.product_id AND p.retail_price IS NOT NULL AND w.price_snapshot IS NOT NULL AND p.retail_price > w.price_snapshot`);
    return stats;
  } finally {
    running = false;
  }
}

module.exports = { runWishlistAlerts, buildMessage, PRICE_DROP_PCT };
