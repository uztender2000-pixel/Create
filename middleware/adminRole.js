// Розділи з юридичною інформацією (правила й реквізити власника) змінює лише
// адміністратор (role = 'admin'), а не будь-який працівник із правом «settings».
// Ставиться ПІСЛЯ requireAdminAuth.
function requireAdminRole(req, res, next) {
  if (req.admin && req.admin.role === 'admin') return next();
  return res.status(403).json({ error: 'Цей розділ доступний лише адміністратору' });
}

module.exports = { requireAdminRole };
