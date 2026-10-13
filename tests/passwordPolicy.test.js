const test = require('node:test');
const assert = require('node:assert');
const { validatePassword } = require('../services/passwordPolicy');

test('короткі й поширені паролі відхиляються', () => {
  for (const pw of ['123456', 'short1', 'qwerty123456', 'password12345', 'Qwerty1234567', 'aaaaaaaaaaaa', 'abcdefghijkl']) {
    assert.ok(validatePassword(pw), `має бути відхилено: ${pw}`);
  }
});

test('адмінам потрібно 12+ символів, покупцям — 10+', () => {
  assert.strictEqual(validatePassword('Mala-Zhaba-2026'), null);
  assert.ok(validatePassword('MyShop#2026', { isAdmin: true }));
  assert.strictEqual(validatePassword('MyShop#2026xyz', { isAdmin: true }), null);
});

test('пароль не може містити email чи ім\'я', () => {
  assert.ok(validatePassword('ivan-test-pass-1', { email: 'ivan.test@x.ua', name: 'Ivan' }));
  assert.ok(validatePassword('Oleksandr-2026-ok', { name: 'Oleksandr Petrenko' }));
});

test('довжина обмежена 72 байтами (ліміт bcrypt)', () => {
  assert.ok(validatePassword('A1-' + 'x'.repeat(80)));
});
