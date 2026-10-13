process.env.ADMIN_JWT_SECRET = 'test-secret-for-unit-tests';
const test = require('node:test');
const assert = require('node:assert');
const totp = require('../services/totp');

test('TOTP відповідає еталонному вектору RFC 6238', () => {
  // секрет '12345678901234567890', час 59 с → крок 1 → код 287082
  assert.strictEqual(totp.hotp(Buffer.from('12345678901234567890'), 1), '287082');
});

test('правильний код приймається, повторний — ні (replay), хибний — ні', () => {
  const secret = totp.generateSecret();
  const step = Math.floor(Date.now() / 1000 / 30);
  const code = totp.hotp(totp.base32Decode(secret), step);
  assert.strictEqual(totp.verifyTotp(secret, code), step);
  assert.strictEqual(totp.verifyTotp(secret, code, step), null);
  assert.strictEqual(totp.verifyTotp(secret, '12345'), null);
  assert.strictEqual(totp.verifyTotp(secret, 'abcdef'), null);
});

test('секрет шифрується й розшифровується; зашифроване не містить відкритого тексту', () => {
  const enc = totp.encryptSecret('JBSWY3DPEHPK3PXP');
  assert.ok(enc.startsWith('v1:'));
  assert.ok(!enc.includes('JBSWY3DPEHPK3PXP'));
  assert.strictEqual(totp.decryptSecret(enc), 'JBSWY3DPEHPK3PXP');
});

test('резервні коди одноразові', () => {
  const { plain, hashes } = totp.generateBackupCodes(3);
  assert.strictEqual(plain.length, 3);
  const left = totp.consumeBackupCode(hashes, plain[0].toUpperCase());
  assert.strictEqual(left.length, 2);
  assert.strictEqual(totp.consumeBackupCode(left, plain[0]), null);
  assert.strictEqual(totp.consumeBackupCode(hashes, 'zzzzz-zzzzz'), null);
});
