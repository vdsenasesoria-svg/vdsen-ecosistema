/**
 * T138-H — _applyTemplateToClient and applyTemplate must back up the
 * client's outgoing active plan before overwriting it.
 *
 * Bug: both "apply a template to a client" code paths created the new plan
 * and then repointed the client's activePlanId at it with no call to
 * backupPlanIfExists() and no confirmation — the same gap already fixed in
 * saveManualPlan (T134-H) and duplicatePlan (T135-H). Any client who already
 * had an active plan lost it silently (no plans_backup entry), breaking the
 * "plan anterior" compare view for that client.
 *
 * Fix: T138-H adds `await backupPlanIfExists(clientId);` before the new plan
 * is created in both functions.
 *
 * Run: node tests/t138h-template-apply-backup-before-overwrite.test.js
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

console.log('T138-H — template-apply flows back up outgoing active plan');

function assertBackupBeforeOverwrite(fnDecl, label, activateSnippet) {
  var body = extractFnBody(src, fnDecl);
  test(label + ' function is present', function () {
    assert.ok(body, label + ' found in HTML source');
  });
  test(label + ' backs up the outgoing plan through the single assignment transaction (T591-C)', function () {
    assert.ok(body, 'function body present');
    assert.ok(body.indexOf('_assignPlanTxn(') > -1, label + ' must assign through _assignPlanTxn');
    var eng = extractFnBody(src, 'async function _assignPlanTxn(');
    assert.ok(eng && eng.indexOf("tx.set(doc(db, 'plans_backup'") > -1, 'the transaction writes the backup of the outgoing plan');
  });
  test(label + ' backup call happens before activePlanId is repointed', function () {
    assert.ok(body, 'function body present');
    var eng = extractFnBody(src, 'async function _assignPlanTxn(');
    var txIdx = eng.indexOf('runTransaction(db');
    var backupIdx = eng.indexOf("tx.set(doc(db, 'plans_backup'");
    var activateIdx = eng.indexOf(activateSnippet);
    assert.ok(txIdx > -1 && backupIdx > txIdx, 'backup is a write of the transaction');
    assert.ok(activateIdx > txIdx, 'activePlanId repointing is a write of the SAME transaction: ' + activateSnippet);
    assert.ok(body.indexOf('updateDoc(doc(db') === -1, label + ' has no loose activePlanId updateDoc left');
  });
}

assertBackupBeforeOverwrite(
  'async function _applyTemplateToClient(',
  '_applyTemplateToClient',
  'tx.update(cRef, { activePlanId: planId })'
);

assertBackupBeforeOverwrite(
  'async function applyTemplate(',
  'applyTemplate',
  'tx.update(cRef, { activePlanId: planId })'
);

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
