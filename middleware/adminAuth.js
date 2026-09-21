const jwt = require('jsonwebtoken');
const { pool } = require('../db');

// Verifies an admin token (signed with a DIFFERENT secret than customer
// tokens, so the two systems are fully isolated — a leaked customer token
// can never be used to access the admin dashboard, and vice versa).
// Attaches req.admin = { id, email, role, permissions }.
async function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Потрібна авторизація' });

  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT id, email, role, permissions, active FROM admin_users WHERE id = $1',
      [payload.adminId]
    );
    if (!rows.length || !rows[0].active) return res.status(401).json({ error: 'Обліковий запис не активний' });

    req.admin = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недійсний або прострочений токен' });
  }
}

// role='admin' (the owner) always passes every permission check, no matter
// what the permissions column says. Anyone else needs permissions[key]===true.
function requirePermission(key) {
  return (req, res, next) => {
    if (req.admin.role === 'admin' || req.admin.permissions?.[key] === true) return next();
    return res.status(403).json({ error: 'Немає доступу до цього розділу' });
  };
}

module.exports = { requireAdminAuth, requirePermission };
