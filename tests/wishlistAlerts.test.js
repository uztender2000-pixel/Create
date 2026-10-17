const test = require('node:test');
const assert = require('node:assert');
const { buildMessage } = require('../services/wishlistAlerts');

test('лист про зниження ціни містить стару й нову ціну та відсоток', () => {
  const { subject, text } = buildMessage('Олена', [{ kind: 'drop', name: 'Чайник', old: 1000, now: 800 }], 'https://shop.example');
  assert.match(subject, /Подешевшав/);
  assert.match(text, /Чайник/);
  assert.match(text, /−20%/);
  assert.match(text, /https:\/\/shop\.example/);
  assert.match(text, /Олена/);
});

test('лист про повернення в наявність', () => {
  const { subject, text } = buildMessage('', [{ kind: 'back', name: 'Пилосос', now: 3000 }], '');
  assert.match(subject, /знову в наявності/);
  assert.match(text, /Пилосос/);
  assert.ok(!text.includes('Перейти до магазину'));   // без адреси сайту рядок не додається
});

test('кілька змін — один лист із підсумком у темі', () => {
  const { subject, text } = buildMessage('Ія', [
    { kind: 'back', name: 'A', now: 10 }, { kind: 'drop', name: 'B', old: 200, now: 150 },
  ], '');
  assert.match(subject, /\(2\)/);
  assert.strictEqual((text.match(/^•/gm) || []).length, 2);
});
