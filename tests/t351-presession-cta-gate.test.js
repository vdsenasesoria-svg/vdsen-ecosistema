const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

test('pre-session CTA waits for all required answers', () => {
  const start = client.indexOf('function _preSelect(field, val) {');
  const end = client.indexOf('\nwindow._preSelect = _preSelect;', start);
  const source = client.slice(start, end);
  assert.ok(source.includes('var ok = filled === 3;'));
  assert.ok(source.includes("btn.textContent = ok ? 'EMPEZAR →' : filled + '/3 respondidas';"));
});
