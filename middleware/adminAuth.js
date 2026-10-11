const jwt = require('jsonwebtoken');
const { pool } = require('../db');

// Чи обов'язкова двофакторка для цього акаунта. Керується змінною ADMIN_REQUIRE_MFA:
//   (за замовчуванням) — для ролі «admin»;  'all' — для всіх;  'false' — вимкнено.
function mfaRequiredFor(admin) {
  const mode = String(process.env.ADMIN_REQUIRE_MFA || 'true').toLowerCase();
  if (mode === 'false') return false;
  if (mode === 'all') return true;
  return admin.role === 'admin';
}

// Verifies an admin token (signed with a DIFFERENT secret than customer
// tokens, so the two systems are fully isolated — a leaked customer token
// can never be used to access the admin dashboard, and vice versa).
// Attaches req.admin = { id, email, role, permissions, mfa_enabled }.
//
// enforceMfa=true (за замовчуванням): акаунт, якому двофакторка обов'язкова, але ще не
// увімкнена, не отримує доступу до жодного розділу, окрім сторінок налаштування безпеки
// (їх обслуговує requireAdminAuthBasic). Токен також перестає діяти після зміни пароля,
// «Вийти всюди» чи скидання 2FA (admin_users.token_version).
function makeAdminAuth(enforceMfa) {
  return async function adminAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Потрібна авторизація' });

    try {
      const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
      if (payload.purpose) throw new Error('wrong token type');   // проміжний токен 2FA не є сесією
      const { rows } = await pool.query(
        'SELECT id, email, role, permissions, active, token_version, mfa_enabled FROM admin_users WHERE id = $1',
        [payload.adminId]
      );
      if (!rows.length || !rows[0].active) return res.status(401).json({ error: 'Обліковий запис не активний' });
      if ((payload.tv || 0) !== rows[0].token_version) return res.status(401).json({ error: 'Сесію завершено. Увійдіть знову' });

      req.admin = rows[0];
      if (enforceMfa && mfaRequiredFor(rows[0]) && !rows[0].mfa_enabled) {
        return res.status(403).json({ error: 'Спершу увімкніть двофакторну автентифікацію', mfaSetupRequired: true });
      }
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Недійсний або прострочений токен' });
    }
  };
}

const requireAdminAuth = makeAdminAuth(true);
const requireAdminAuthBasic = makeAdminAuth(false);

// role='admin' (the owner) always passes every permission check, no matter
// what the permissions column says. Anyone else needs permissions[key]===true.
function requirePermission(key) {
  return (req, res, next) => {
    if (req.admin.role === 'admin' || req.admin.permissions?.[key] === true) return next();
    return res.status(403).json({ error: 'Немає доступу до цього розділу' });
  };
}

module.exports = { requireAdminAuth, requireAdminAuthBasic, requirePermission, mfaRequiredFor };
