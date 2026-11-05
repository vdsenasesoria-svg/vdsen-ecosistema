'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('rest timer overlay clears the installed PWA bottom safe area', () => {
  const source = fs.readFileSync('vdsen-cliente.html', 'utf8');
  const start = source.indexOf('function _ensureRestTimerOverlay() {');
  const end = source.indexOf('\nfunction startRestTimer(', start);
  const overlay = source.slice(start, end);
  assert.match(overlay, /bottom:calc\(65px \+ env\(safe-area-inset-bottom,0px\)\)/);
});
