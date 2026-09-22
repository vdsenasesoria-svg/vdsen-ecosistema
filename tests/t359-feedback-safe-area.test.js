'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('fixed workout feedback surfaces respect installed PWA safe areas', () => {
  const source = fs.readFileSync('vdsen-cliente.html', 'utf8');
  assert.match(source, /function _showAddSetSuggestion[\s\S]*?bottom:calc\(90px \+ env\(safe-area-inset-bottom,0px\)\)/);
  assert.match(source, /errEl\.style\.cssText = 'position:fixed;bottom:calc\(72px \+ env\(safe-area-inset-bottom,0px\)\)/);
  assert.match(source, /right:calc\(16px \+ env\(safe-area-inset-right,0px\)\)/);
  assert.match(source, /function showSessionSummary[\s\S]*?bottom:calc\(90px \+ env\(safe-area-inset-bottom,0px\)\)/);
});
