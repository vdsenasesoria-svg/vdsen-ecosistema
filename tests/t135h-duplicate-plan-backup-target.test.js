/**
 * T135-H — duplicatePlan must back up the target client's outgoing active
 * plan before overwriting it.
 *
 * Bug: duplicatePlan lets the coach pick a target client (possibly one that
 * already has an active plan — the picker gives no warning either), creates
 * the duplicated plan, and repoints the target's activePlanId at it with no
 * call to backupPlanIfExists() and no deletion/backup of the previous plan.
 * The overwritten plan becomes silently unreachable through the app (no UI
 * references an orphaned plan doc) and is invisible to the "plan anterior"
 * compare feature, which reads from plans_backup. duplicatePlanToClient
 * (the sibling "copy to another client" flow) already calls
 * backupPlanIfExists(targetId) before its equivalent overwrite.
 *
 * Fix: T135-H adds `await backupPlanIfExists(targetId);` right after the
 * target client is chosen, before the target's activePlanId is repointed.
 *
 * Run: node tests/t135h-duplicate-plan-backup-target.test.js
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

console.log('T135-H — duplicatePlan backs up target\'s outgoing active plan');

var body = extractFnBody(src, 'async function duplicatePlan(');

test('duplicatePlan function is present', function () {
  assert.ok(body, 'duplicatePlan function found in HTML source');
});

test('the target\'s outgoing plan is backed up by the single assignment transaction (T591-C)', function () {
  assert.ok(body, 'function body present');
  assert.ok(body.indexOf('_assignPlanTxn(') > -1 && body.indexOf('clientId: targetId') > -1, 'duplicatePlan assigns to the TARGET client through _assignPlanTxn');
  var eng = extractFnBody(src, 'async function _assignPlanTxn(');
  assert.ok(eng && eng.indexOf("tx.set(doc(db, 'plans_backup'") > -1, 'the transaction writes the backup of the target\'s outgoing plan');
});

test('backup call happens after targetId is chosen', function () {
  assert.ok(body, 'function body present');
  var targetIdx = body.indexOf('const targetId = sel.id');
  var backupIdx = body.indexOf('_assignPlanTxn(');
  assert.ok(targetIdx > -1, 'targetId assignment present');
  assert.ok(backupIdx > -1, 'assignment transaction call present');
  assert.ok(targetIdx < backupIdx, 'targetId must be resolved before the transaction (which backs up the target\'s plan)');
});

test('backup call happens before the new plan is written', function () {
  assert.ok(body, 'function body present');
  var eng = extractFnBody(src, 'async function _assignPlanTxn(');
  var backupIdx = eng.indexOf("tx.set(doc(db, 'plans_backup'");
  var newIdx = eng.indexOf('tx.set(planRef, o.buildPlanDoc(planId, nowIso))');
  assert.ok(backupIdx > -1 && newIdx > -1, 'backup write and new-plan write both present in the transaction');
  assert.ok(body.indexOf('addDoc(') === -1, 'duplicatePlan has no loose addDoc: the copy is created inside the transaction together with the backup');
});

test('backup call happens before activePlanId is repointed at the target', function () {
  assert.ok(body, 'function body present');
  var eng = extractFnBody(src, 'async function _assignPlanTxn(');
  var txIdx = eng.indexOf('runTransaction(db');
  var backupIdx = eng.indexOf("tx.set(doc(db, 'plans_backup'");
  var activateIdx = eng.indexOf('tx.update(cRef, { activePlanId: planId })');
  assert.ok(txIdx > -1 && backupIdx > txIdx && activateIdx > txIdx, 'backup and activePlanId repointing are writes of the same transaction');
  assert.ok(body.indexOf('updateDoc(') === -1, 'duplicatePlan has no separate activePlanId updateDoc');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
