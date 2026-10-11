const crypto = require('crypto');

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) для двофакторної автентифікації адмінів — без сторонніх бібліотек:
// сумісно з Google Authenticator, Microsoft Authenticator, Authy, 1Password тощо.
// ---------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateSecret() { return base32Encode(crypto.randomBytes(20)); }

function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const o = h[19] & 15;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Повертає номер 30-секундного кроку, на якому збігся код, або null.
// lastStep — крок останнього успішного входу: код не можна використати двічі (replay).
function verifyTotp(secretB32, token, lastStep = null, window = 1) {
  const code = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const now = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  let matched = null;
  for (let w = -window; w <= window; w++) {
    const step = now + w;
    if (safeEqual(hotp(secret, step), code) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (lastStep != null && matched <= Number(lastStep)) return null;
  return matched;
}

function otpauthUrl(secret, email, issuer) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// ---- Шифрування секрету в БД (AES-256-GCM). Ключ: MFA_ENC_KEY або ADMIN_JWT_SECRET. ----
function encKey() {
  const base = process.env.MFA_ENC_KEY || process.env.ADMIN_JWT_SECRET;
  if (!base) throw new Error('MFA_ENC_KEY / ADMIN_JWT_SECRET не задано');
  return crypto.createHash('sha256').update(String(base)).digest();
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decryptSecret(stored) {
  const [v, iv, tag, ct] = String(stored).split(':');
  if (v !== 'v1') throw new Error('Невідомий формат секрету');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ---- Резервні коди (на випадок втрати телефону): зберігаються лише хеші, кожен діє один раз ----
const hashCode = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

function generateBackupCodes(n = 8) {
  const plain = Array.from({ length: n }, () => {
    const h = crypto.randomBytes(5).toString('hex');
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
  return { plain, hashes: plain.map(hashCode) };
}

// Повертає масив хешів без використаного коду або null, якщо код не підійшов.
function consumeBackupCode(hashes, input) {
  const h = hashCode(input);
  const list = Array.isArray(hashes) ? hashes : [];
  return list.includes(h) ? list.filter((x) => x !== h) : null;
}

module.exports = {
  generateSecret, verifyTotp, otpauthUrl, encryptSecret, decryptSecret,
  generateBackupCodes, consumeBackupCode, base32Decode, hotp,
};
