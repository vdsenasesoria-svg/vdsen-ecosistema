const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = source.indexOf('async function loadPlan(user)');
const end = source.indexOf('\nfunction renderPlanRoto', start);
const loadPlan = source.slice(start, end);

test('T445: loadPlan rejects an obsolete auth generation before mutating PLAN or rendering', () => {
  const guard = 'if (_mySeq !== _loadPlanSeq || !USER || USER.uid !== user.uid) return;';
  const firstGuard = loadPlan.indexOf(guard);
  assert.ok(firstGuard >= 0, 'loadPlan needs a UID+generation stale guard');
  assert.ok(firstGuard < loadPlan.indexOf('PLAN = {'), 'guard must precede PLAN mutation');
  assert.ok(firstGuard < loadPlan.indexOf('renderAll()'), 'guard must precede client rendering');
});
