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

test('the outgoing plan is backed up by the single assignment transaction (T591-C)', function () {
  assert.ok(body, 'function body present');
  assert.ok(body.indexOf('_assignPlanTxn(') > -1, 'saveManualPlan must create the plan through _assignPlanTxn');
   var eng = extractFnBody(src, 'async function _assignPlanTxn(');
   assert.ok(eng, '_assignPlanTxn (single assignment transaction) present');
    assert.ok(eng.indexOf("tx.set(doc(db, 'plans_backup'") > -1, 'the transaction writes the backup of the outgoing plan');
  assert.ok(body.indexOf('addDoc(') === -1 && body.indexOf('updateDoc(') === -1, 'saveManualPlan has no loose addDoc/updateDoc left (the window between them is closed)');
});

test('backup call happens before the previous plan is looked up for deletion', function () {
  assert.ok(body, 'function body present');
  var eng = extractFnBody(src, 'async function _assignPlanTxn(');
  var backupIdx = eng.indexOf("tx.set(doc(db, 'plans_backup'");
  var deleteIdx = eng.indexOf("tx.update(doc(db, 'plans', curActive), retire)");
  assert.ok(backupIdx > -1, 'backup write present in the transaction');
  assert.ok(deleteIdx > -1, 'explicit historical retirement of the previous plan present in the same transaction');
  assert.ok(backupIdx < deleteIdx, 'backup is written before the previous plan is retired (and both commit together or not at all)');
});

test('backup call happens after prevPlanId2 is captured (so it backs up the right plan)', function () {
  assert.ok(body, 'function body present');
  var capturedIdx = body.indexOf('prevPlanId2 = await _readActivePlanIdStrict(clientId)');
  var txnIdx = body.indexOf('_assignPlanTxn(');
  assert.ok(capturedIdx > -1, 'prevPlanId2 capture present');
  assert.ok(txnIdx > -1, 'assignment transaction call present');
  assert.ok(capturedIdx < txnIdx && body.indexOf('expectedPrevPlanId: prevPlanId2') > -1, 'the previous plan is captured first and passed as expectedPrevPlanId (the transaction re-checks it, so the backup is of the right plan)');
});

test('backup call happens before the new plan replaces activePlanId', function () {
  assert.ok(body, 'function body present');
  var eng = extractFnBody(src, 'async function _assignPlanTxn(');
  var backupIdx = eng.indexOf("tx.set(doc(db, 'plans_backup'");
  var activateIdx = eng.indexOf('tx.update(cRef, { activePlanId: planId })');
  assert.ok(backupIdx > -1, 'backup write present');
  assert.ok(activateIdx > -1, 'activePlanId write present');
  assert.ok(eng.indexOf('runTransaction(db') > -1 && eng.indexOf('runTransaction(db') < Math.min(backupIdx, activateIdx), 'backup and the activePlanId repointing are writes of the SAME transaction: the pointer can never move without the backup');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
