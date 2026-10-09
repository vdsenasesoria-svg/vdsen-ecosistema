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

test('backupPlanIfExists(targetId) is called', function () {
  assert.ok(body, 'function body present');
  assert.ok(
    body.indexOf('backupPlanIfExists(targetId)') > -1,
    'duplicatePlan must call backupPlanIfExists(targetId) to preserve the target\'s outgoing plan'
  );
});

test('backup call happens after targetId is chosen', function () {
  assert.ok(body, 'function body present');
  var targetIdx = body.indexOf('const targetId = sel.id');
  var backupIdx = body.indexOf('backupPlanIfExists(targetId)');
  assert.ok(targetIdx > -1, 'targetId assignment present');
  assert.ok(backupIdx > -1, 'backupPlanIfExists(targetId) call present');
  assert.ok(targetIdx < backupIdx, 'targetId must be resolved before the backup call');
});

test('backup call happens before the new plan is written', function () {
  assert.ok(body, 'function body present');
  var backupIdx = body.indexOf('backupPlanIfExists(targetId)');
  var addDocIdx = body.indexOf('addDoc(collection(db, "plans"), newPlan)');
  assert.ok(backupIdx > -1, 'backupPlanIfExists(targetId) call present');
  assert.ok(addDocIdx > -1, 'addDoc of newPlan present');
  assert.ok(backupIdx < addDocIdx, 'backup must run before the duplicated plan is created');
});

test('backup call happens before activePlanId is repointed at the target', function () {
  assert.ok(body, 'function body present');
  var backupIdx = body.indexOf('backupPlanIfExists(targetId)');
  var activateIdx = body.indexOf('updateDoc(doc(db, "clients", targetId), { activePlanId: newRef.id }');
  assert.ok(backupIdx > -1, 'backupPlanIfExists(targetId) call present');
  assert.ok(activateIdx > -1, 'activePlanId updateDoc present');
  assert.ok(backupIdx < activateIdx, 'backup must happen before the target\'s activePlanId is overwritten');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
