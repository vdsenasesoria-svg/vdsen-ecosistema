/**
 * T134-H — saveManualPlan must back up the outgoing active plan before
 * deleting it.
 *
 * Bug: saveManualPlan reads the client's current activePlanId (prevPlanId2),
 * writes the new plan, points activePlanId at the new plan, then permanently
 * deleteDoc()s the previous plan — with NO call to backupPlanIfExists() and
 * NO confirmation. saveImportedPlan and duplicatePlanToClient both call
 * backupPlanIfExists() before an overwrite/delete of the client's active
 * plan; saveManualPlan silently skipped it, so any manually-built plan that
 * replaced an existing active plan destroyed the old plan irrecoverably and
 * broke the "plan anterior" compare feature (reads from plans_backup,
 * showClientDetail ~L14351) for that client.
 *
 * Fix: T134-H adds `await backupPlanIfExists(clientId);` before the
 * prevPlanId2 doc is deleted, matching the existing pattern.
 *
 * Run: node tests/t134h-manual-plan-backup-before-overwrite.test.js
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch (e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-coach.html', 'utf8');

function extractFnBody(src, fnDecl) {
  var idx = src.indexOf(fnDecl);
  if (idx === -1) return null;
  var start = src.indexOf('{', idx);
  var depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

console.log('T134-H — saveManualPlan backs up outgoing active plan before delete');

var body = extractFnBody(src, 'async function saveManualPlan(');

test('saveManualPlan function is present', function () {
  assert.ok(body, 'saveManualPlan function found in HTML source');
});

test('backupPlanIfExists(clientId) is called', function () {
  assert.ok(body, 'function body present');
  assert.ok(
    body.indexOf('backupPlanIfExists(clientId)') > -1,
    'saveManualPlan must call backupPlanIfExists(clientId) to preserve the outgoing plan'
  );
});

test('backup call happens before the previous plan is looked up for deletion', function () {
  assert.ok(body, 'function body present');
  var backupIdx = body.indexOf('backupPlanIfExists(clientId)');
  var deleteIdx = body.indexOf('deleteDoc(doc(db, "plans", prevPlanId2)');
  assert.ok(backupIdx > -1, 'backupPlanIfExists(clientId) call present');
  assert.ok(deleteIdx > -1, 'deleteDoc of prevPlanId2 present');
  assert.ok(backupIdx < deleteIdx, 'backup must run before the previous plan doc is deleted');
});

test('backup call happens after prevPlanId2 is captured (so it backs up the right plan)', function () {
  assert.ok(body, 'function body present');
  var capturedIdx = body.indexOf('prevPlanId2 = prevClientSnap2.exists()');
  var backupIdx = body.indexOf('backupPlanIfExists(clientId)');
  assert.ok(capturedIdx > -1, 'prevPlanId2 capture present');
  assert.ok(backupIdx > -1, 'backupPlanIfExists(clientId) call present');
  assert.ok(capturedIdx < backupIdx, 'prevPlanId2 must be captured before the backup call');
});

test('backup call happens before the new plan replaces activePlanId', function () {
  assert.ok(body, 'function body present');
  var backupIdx = body.indexOf('backupPlanIfExists(clientId)');
  var activateIdx = body.indexOf('updateDoc(doc(db, "clients", clientId), { activePlanId: planRef.id }');
  assert.ok(backupIdx > -1, 'backupPlanIfExists(clientId) call present');
  assert.ok(activateIdx > -1, 'activePlanId updateDoc present');
  assert.ok(backupIdx < activateIdx, 'backup must happen before activePlanId is repointed to the new plan');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
