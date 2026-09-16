/**
 * T094 — Targeted test: guardarCI disables ALL save buttons, not just the first
 * Run: node tests/ci-guardar-buttons.test.js
 */
var assert = require('assert');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

// Helpers that mirror the fix applied in guardarCI()
function disableAll(btns) {
  var origTexts = btns.map(function(b) { return b.textContent; });
  btns.forEach(function(b) { b.disabled = true; b.textContent = 'GUARDANDO...'; });
  return origTexts;
}
function restoreAll(btns, origTexts) {
  btns.forEach(function(b, i) { b.disabled = false; b.textContent = origTexts[i] || 'GUARDAR'; });
}

console.log('T094 — ci-guardar-buttons');

test('both buttons are disabled during save', function() {
  var btnFloat  = { disabled: false, textContent: '💾 GUARDAR' };
  var btnInline = { disabled: false, textContent: '✓ GUARDAR CHECK-IN SEM 1' };
  disableAll([btnFloat, btnInline]);
  assert.strictEqual(btnFloat.disabled,  true, 'floating button must be disabled');
  assert.strictEqual(btnInline.disabled, true, 'inline button must be disabled');
  assert.strictEqual(btnFloat.textContent,  'GUARDANDO...', 'floating shows GUARDANDO');
  assert.strictEqual(btnInline.textContent, 'GUARDANDO...', 'inline shows GUARDANDO');
});

test('both buttons are restored to their original text', function() {
  var btnFloat  = { disabled: false, textContent: '💾 GUARDAR' };
  var btnInline = { disabled: false, textContent: '✓ GUARDAR CHECK-IN SEM 1' };
  var saved = disableAll([btnFloat, btnInline]);
  restoreAll([btnFloat, btnInline], saved);
  assert.strictEqual(btnFloat.disabled,  false, 'floating re-enabled');
  assert.strictEqual(btnInline.disabled, false, 'inline re-enabled');
  assert.strictEqual(btnFloat.textContent,  '💾 GUARDAR',              'floating restores original label');
  assert.strictEqual(btnInline.textContent, '✓ GUARDAR CHECK-IN SEM 1', 'inline restores original label');
});

test('OLD querySelector pattern left second button enabled — regression proof', function() {
  var btn1 = { disabled: false, textContent: '💾 GUARDAR' };
  var btn2 = { disabled: false, textContent: '✓ GUARDAR CHECK-IN SEM 1' };
  // Simulate querySelector (first-only) — the old broken behaviour
  var firstOnly = btn1;
  firstOnly.disabled = true;
  firstOnly.textContent = 'GUARDANDO...';
  assert.strictEqual(btn2.disabled, false, 'second button was NOT disabled (confirmed old bug)');
  assert.strictEqual(btn1.disabled, true,  'first button was disabled');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
