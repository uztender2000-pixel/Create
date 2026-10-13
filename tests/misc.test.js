const test = require('node:test');
const assert = require('node:assert');
const { normalizePath } = require('../services/errorReporter');
const { normalizeOwner } = require('../services/ownerInfo');

test('шляхи помилок групуються: числові id замінюються', () => {
  assert.strictEqual(normalizePath('/api/products/123?x=1'), '/api/products/:id');
  assert.strictEqual(normalizePath('/api/orders/5/items/77'), '/api/orders/:id/items/:id');
});

test('реквізити власника: некоректні ЄДРПОУ, IBAN і email відхиляються', () => {
  const { errors } = normalizeOwner({ edrpou: '123', iban: 'UA12', email: 'not-an-email' });
  assert.strictEqual(errors.length, 3);
});

test('реквізити власника: коректні дані проходять, пробіли в IBAN прибираються', () => {
  const { value, errors } = normalizeOwner({ edrpou: '12345678', iban: 'ua21 3223 1300 0002 6007 2335 6600 1', email: 'a@b.ua' });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(value.iban, 'UA213223130000026007233566001');
});
