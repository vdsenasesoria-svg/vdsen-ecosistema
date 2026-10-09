// T124-C: _refreshLogsFromFirestore must guard against stale entries from a different plan.
// Tests that the function checks data.planId vs ACTIVE_PLAN_ID before replacing LOGS.
'use strict';
const assert = require('assert');
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

// Locate _refreshLogsFromFirestore function body
const fnStart = src.indexOf('async function _refreshLogsFromFirestore(');
assert.ok(fnStart !== -1, '_refreshLogsFromFirestore function not found');

// Extract function body by matching braces
const fnBody = (function() {
  // Find the opening brace
  let braceStart = src.indexOf('{', fnStart);
  assert.ok(braceStart !== -1, 'opening brace not found');
  let depth = 0;
  let i = braceStart;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(fnStart, i + 1);
    }
    i++;
  }
  return src.slice(fnStart, fnStart + 2000);
})();

// The function must reference ACTIVE_PLAN_ID (plan ID guard)
assert.ok(
  fnBody.includes('ACTIVE_PLAN_ID'),
  'T124-C: _refreshLogsFromFirestore must check ACTIVE_PLAN_ID to guard against stale plan data'
);

// The function must check data.planId
assert.ok(
  fnBody.includes('data.planId'),
  'T124-C: _refreshLogsFromFirestore must reference data.planId for the plan ID guard'
);

// The guard must have an early return when planIds mismatch
assert.ok(
  fnBody.includes('data.planId !== ACTIVE_PLAN_ID'),
  'T124-C: guard must compare data.planId !== ACTIVE_PLAN_ID'
);

// After the guard, the function should still update exerciseUnits and exerciseHistory
// (cross-plan weight history preserved)
const guardBlock = fnBody.slice(fnBody.indexOf('data.planId !== ACTIVE_PLAN_ID'));
assert.ok(
  guardBlock.includes('EXERCISE_UNITS') || guardBlock.includes('exerciseUnits'),
  'T124-C: guard early-return block must still preserve exerciseUnits'
);
assert.ok(
  guardBlock.includes('EXERCISE_HISTORY') || guardBlock.includes('exerciseHistory'),
  'T124-C: guard early-return block must still preserve exerciseHistory'
);

console.log('T124-C PASS: _refreshLogsFromFirestore has plan ID guard');
