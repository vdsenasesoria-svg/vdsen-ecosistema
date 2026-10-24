// T123-C: Rest timer state must be cleared when plan changes (planChanged === true)
// Tests that vdsen_restEnd and vdsen_restTotal are removed from localStorage
// inside the planChanged branch of loadPlan.
'use strict';
const assert = require('assert');
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

// Find the planChanged block — bounded by "if (planChanged) {" through to "} else {"
const planChangedBlock = (function() {
  const start = src.indexOf('if (planChanged) {');
  assert.ok(start !== -1, 'planChanged block not found');
  // Walk forward to find the matching closing brace (before the else clause)
  let depth = 0;
  let i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i++;
  }
  return src.slice(start, start + 3000);
})();

// The planChanged block must call localStorage.removeItem for both rest-timer keys
assert.ok(
  planChangedBlock.includes("localStorage.removeItem('vdsen_restEnd')"),
  'T123-C: planChanged block must remove vdsen_restEnd from localStorage'
);
assert.ok(
  planChangedBlock.includes("localStorage.removeItem('vdsen_restTotal')"),
  'T123-C: planChanged block must remove vdsen_restTotal from localStorage'
);

// The rest timer restore code must come AFTER the planChanged block in loadPlan.
// If the keys are cleared in planChanged, the restore code will find no saved timer.
const planChangedEnd = src.indexOf('if (planChanged) {') + planChangedBlock.length;
const restoreRestTimerIdx = src.indexOf('vdsen_restEnd', planChangedEnd);
assert.ok(
  restoreRestTimerIdx !== -1,
  'T123-C: rest timer restore code should still exist after the planChanged block'
);
// Make sure the restore reads vdsen_restEnd AFTER the planChanged block
assert.ok(
  restoreRestTimerIdx > planChangedEnd,
  'T123-C: rest timer restore code is after the planChanged cleanup (so cleared keys take effect)'
);

console.log('T123-C PASS: rest timer keys cleared in planChanged block');
