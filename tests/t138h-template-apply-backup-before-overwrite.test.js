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
  test(label + ' calls backupPlanIfExists(clientId)', function () {
    assert.ok(body, 'function body present');
    assert.ok(
      body.indexOf('backupPlanIfExists(clientId)') > -1,
      label + ' must call backupPlanIfExists(clientId) before overwriting the active plan'
    );
  });
  test(label + ' backup call happens before activePlanId is repointed', function () {
    assert.ok(body, 'function body present');
    var backupIdx = body.indexOf('backupPlanIfExists(clientId)');
    var activateIdx = body.indexOf(activateSnippet);
    assert.ok(backupIdx > -1, 'backupPlanIfExists(clientId) call present');
    assert.ok(activateIdx > -1, 'activePlanId updateDoc present: ' + activateSnippet);
    assert.ok(backupIdx < activateIdx, 'backup must happen before activePlanId is overwritten');
  });
}

assertBackupBeforeOverwrite(
  'async function _applyTemplateToClient(',
  '_applyTemplateToClient',
  "updateDoc(doc(db, 'clients', clientId), { activePlanId: planRef.id }"
);

assertBackupBeforeOverwrite(
  'async function applyTemplate(',
  'applyTemplate',
  'updateDoc(doc(db, "clients", clientId), { activePlanId: planRef.id }'
);

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
