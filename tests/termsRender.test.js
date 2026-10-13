const test = require('node:test');
const assert = require('node:assert');
const { renderTerms } = require('../services/termsService');

const snap = { values: { name: 'ТОВ «Тест»', edrpou: '12345678' }, extra: [] };

test('HTML у тексті правил екранується (XSS неможливий)', () => {
  const { html } = renderTerms('## Розділ\n<script>alert(1)</script> **жирний** <img src=x onerror=alert(1)>', snap);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>жирний</strong>'));
});

test('реквізити власника підставляються й екрануються', () => {
  const { html } = renderTerms('Власник: {{owner.name}}, код {{owner.edrpou}}', { values: { name: '<b>Evil</b>', edrpou: '1' }, extra: [] });
  assert.ok(html.includes('&lt;b&gt;Evil&lt;/b&gt;'));
  assert.ok(!html.includes('<b>Evil</b>'));
});

test('відсутній реквізит показується як підказка, а не як порожнеча', () => {
  const { html } = renderTerms('Телефон: {{owner.phone}}', snap);
  assert.ok(html.includes('class="ph"'));
});

test('зміст будується із заголовків, списки й блок реквізитів працюють', () => {
  const { html, toc } = renderTerms('## Один\n- a\n- b\n## Два\n{{owner_block}}', snap);
  assert.deepStrictEqual(toc.map((t) => t.title), ['Один', 'Два']);
  assert.ok(html.includes('<ul><li>a</li><li>b</li></ul>'));
  assert.ok(html.includes('class="owner"'));
});
