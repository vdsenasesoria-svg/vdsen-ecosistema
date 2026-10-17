const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('nutrition log controls meet the mobile touch target minimum', () => {
  const source = fs.readFileSync('vdsen-cliente.html', 'utf8');
  assert.match(
    source,
    /#tabNutr input\[type="number"\],#tabNutr button\[onclick="guardarNutriLog\(\)"\]\{min-height:44px\}/
  );
});
