const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('minimized rest timer clears the PWA bottom safe area', () => {
  const source = fs.readFileSync('vdsen-cliente.html', 'utf8');
  const timerPill = source.match(/<div id="timerPill"[\s\S]*?<\/div>'\+/);
  assert.ok(timerPill);
  assert.match(timerPill[0], /bottom:calc\(80px \+ env\(safe-area-inset-bottom,0px\)\)/);
});
