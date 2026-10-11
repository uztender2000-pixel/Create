// Політика паролів: довжина важливіша за «складність», тому головна вимога — довжина,
// плюс заборона найпоширеніших і передбачуваних паролів.
const MIN_USER = 10;
const MIN_ADMIN = 12;
const MAX_BYTES = 72;   // bcrypt ігнорує все після 72 байтів — чесно обмежуємо

const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'qwerty', 'qwerty123', 'qwerty1234', 'qwertyuiop',
  'qwerty123456', '1q2w3e4r', '1q2w3e4r5t', '1qaz2wsx', 'zaq12wsx', 'asdfghjkl', 'zxcvbnm', 'abc123', 'abcd1234', 'abcdefgh', 'abcdefghij',
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910', '0987654321', '111111', '000000', '121212', '123123', '123321',
  '1234qwer', 'qwer1234', 'iloveyou', 'admin', 'admin123', 'admin1234', 'administrator', 'welcome', 'welcome1', 'letmein', 'monkey', 'dragon',
  'football', 'baseball', 'master', 'shadow', 'superman', 'trustno1', 'changeme', 'default', 'login', 'secret', 'test1234', 'testtest', 'guest',
  'privet', 'privet123', 'parol', 'parol123', 'ukraine', 'ukraina', 'slavaukraini', 'slava_ukraini', 'vkhatu', 'vkhatu123', 'allshop', 'shop1234',
  'йцукен', 'йцукен123', 'пароль', 'пароль123', 'україна', 'привіт',
]);

function looksSequential(s) {
  const t = s.toLowerCase();
  if (/^(.)\1+$/.test(t)) return true;                       // aaaaaaaaaa
  let seq = true;
  for (let i = 1; i < t.length; i++) if (t.charCodeAt(i) - t.charCodeAt(i - 1) !== 1) { seq = false; break; }
  return seq;                                                 // abcdefghij, 123456789012
}

// Повертає текст помилки або null, якщо пароль прийнятний.
function validatePassword(password, { email, name, isAdmin = false } = {}) {
  const pw = String(password ?? '');
  const min = isAdmin ? MIN_ADMIN : MIN_USER;
  if (pw.length < min) return `Пароль має бути щонайменше ${min} символів`;
  if (Buffer.byteLength(pw, 'utf8') > MAX_BYTES) return 'Пароль занадто довгий (максимум 72 байти)';
  const norm = pw.toLowerCase();
  // Поширене слово + цифри/символи в кінці (password12345, Qwerty!!2026, admin2024) — теж надто слабкі.
  const flat = norm.replace(/[^a-zа-яіїєґ0-9]/g, '');
  const base = flat.replace(/\d+$/, '');
  const leet = base.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/@/g, 'a').replace(/\$/g, 's');
  if (COMMON.has(norm) || COMMON.has(flat) || (base.length >= 4 && (COMMON.has(base) || COMMON.has(leet)))) {
    return 'Цей пароль надто поширений — придумайте інший';
  }
  if (looksSequential(pw)) return 'Пароль надто передбачуваний (повтори чи послідовність символів)';
  const classes = [/[a-zа-яіїєґ]/, /[A-ZА-ЯІЇЄҐ]/, /\d/, /[^A-Za-zА-Яа-яІіЇїЄєҐґ\d]/].filter((r) => r.test(pw)).length;
  if (classes < 2) return 'Додайте до пароля цифри, великі літери або символи';
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && norm.includes(local)) return 'Пароль не повинен містити ваш email';
  const first = String(name || '').trim().split(/\s+/)[0].toLowerCase();
  if (first.length >= 4 && norm.includes(first)) return "Пароль не повинен містити ваше ім'я";
  return null;
}

module.exports = { validatePassword, MIN_USER, MIN_ADMIN };
