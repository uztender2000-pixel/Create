const express = require('express');
const { pool } = require('../db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');

const router = express.Router();
router.use(requireAdminAuth, requirePermission('orders'));

const STATUS_UA = {
  new: 'Нове', confirmed: 'Підтверджене', ordered_from_supplier: 'У постачальника', shipped: 'Відправлене', done: 'Виконане', cancelled: 'Скасоване',
};
const DELIVERY_UA = { branch: 'Відділення', courier: "Кур'єр", locker: 'Поштомат' };
const MAX_ROWS = 50000;

// Клітинка CSV. Значення, що починаються на = + - @ (або табуляцію), Excel сприйняв би як ФОРМУЛУ — так можна
// вкрасти дані або виконати дію через підступне ім'я покупця. Тому перед такими значеннями ставимо апостроф.
function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  s = s.replace(/\r?\n/g, ' ');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const money = (n) => (n == null ? '' : Number(n).toFixed(2).replace('.', ','));   // українська кома для Excel

// GET /api/admin/orders-export?status=&failed=true&supplier_id=&from=YYYY-MM-DD&to=YYYY-MM-DD
// Файл CSV (UTF-8 з BOM, роздільник «;»): Excel відкриває його подвійним кліком із коректною кирилицею.
router.get('/', async (req, res) => {
  try {
    const { status, supplier_id, from, to } = req.query;
    const cond = [];
    const params = [];
    const dateOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
    if (status) { params.push(String(status)); cond.push(`o.status = $${params.length}`); }
    if (req.query.failed === 'true') cond.push('o.supplier_error IS NOT NULL');
    if (supplier_id && /^\d+$/.test(String(supplier_id))) { params.push(supplier_id); cond.push(`o.supplier_id = $${params.length}`); }
    if (dateOk(from)) { params.push(from); cond.push(`o.created_at >= ($${params.length}::date AT TIME ZONE 'Europe/Kyiv')`); }
    if (dateOk(to)) { params.push(to); cond.push(`o.created_at < (($${params.length}::date + 1) AT TIME ZONE 'Europe/Kyiv')`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT o.id, o.group_id, o.created_at, o.status, o.quantity, o.unit_price, o.cost_price,
              o.customer_name, o.customer_phone, o.customer_city, o.np_city, o.np_branch, o.delivery_method,
              o.courier_address, o.ttn, o.comment, o.supplier_status, o.supplier_error,
              p.name AS product_name, p.vendor_code, s.name AS supplier_name
         FROM orders o
         LEFT JOIN products p ON p.id = o.product_id
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         ${where}
        ORDER BY o.created_at DESC
        LIMIT ${MAX_ROWS}`, params);

    const head = ['№', 'Група замовлення', 'Дата', 'Статус', 'Товар', 'Артикул', 'Кількість', 'Ціна, грн', 'Сума, грн', 'Собівартість, грн', 'Маржа, грн',
      'Покупець', 'Телефон', 'Місто', 'Доставка', 'Відділення / адреса', 'ТТН', 'Постачальник', 'Статус у постачальника', 'Помилка постачальника', 'Коментар'];
    const lines = [head.map(cell).join(';')];
    let total = 0;
    for (const r of rows) {
      const qty = Number(r.quantity) || 1;
      const sum = r.unit_price != null ? Number(r.unit_price) * qty : null;
      const margin = sum != null && r.cost_price != null ? sum - Number(r.cost_price) * qty : null;
      if (sum != null) total += sum;
      const d = new Date(r.created_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short' });
      lines.push([
        r.id, r.group_id, d, STATUS_UA[r.status] || r.status, r.product_name, r.vendor_code, qty, money(r.unit_price), money(sum), money(r.cost_price), money(margin),
        r.customer_name, r.customer_phone, r.np_city || r.customer_city, DELIVERY_UA[r.delivery_method] || r.delivery_method || '',
        r.delivery_method === 'courier' ? r.courier_address : (r.np_branch || ''), r.ttn, r.supplier_name, r.supplier_status, r.supplier_error, r.comment,
      ].map(cell).join(';'));
    }
    lines.push(['', '', '', '', '', 'РАЗОМ', '', '', money(total)].map(cell).join(';'));

    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="orders-${stamp}.csv"`);
    res.set('Cache-Control', 'no-store');
    res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося підготувати файл' });
  }
});

module.exports = router;
