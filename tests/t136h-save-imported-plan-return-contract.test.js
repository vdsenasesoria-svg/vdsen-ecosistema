/**
 * T136-H — saveImportedPlan must report success/failure via return value, and
 * every caller that chains nutrition/supplement/pharma writes after it must
 * check that value before proceeding.
 *
 * Bug: saveImportedPlan silently `return`s (no throw) when the coach declines
 * its "reemplazar plan activo" confirm, when the plan gate BLOCKs, or when
 * required inputs are missing. It never signaled this to callers. Four call
 * sites — autoGeneratePlan, loadPlanFromPastedAnalysis, _autoGenerateForModal
 * (AI review/confirm flow), and _submitModalImport — ignored the (undefined)
 * result and unconditionally: (a) pushed "N día(s) de entrenamiento" onto a
 * "saved" summary shown to the coach, and/or (b) wrote nutritionPlan /
 * supplementPlan / pharmacoPlan to the client doc, and/or (c) reloaded the
 * client detail modal as if the plan had been activated. A coach who declined
 * the replace-plan confirm would see a false "saved" report while other
 * client fields were mutated anyway — a partial-state write with no rollback
 * and misleading feedback.
 *
 * Fix: T136-H makes saveImportedPlan return true only after a real write +
 * activation, and false at every early-exit/decline/catch point. The four
 * call sites now check this and bail out (with a "cancelled" status message)
 * before doing anything else when it is false.
 *
 * Run: node tests/t136h-save-imported-plan-return-contract.test.js
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

console.log('T136-H — saveImportedPlan return contract + caller guards');

// ── 1. saveImportedPlan itself ──────────────────────────────────────────
var sipBody = extractFnBody(src, 'async function saveImportedPlan(');

test('saveImportedPlan function is present', function () {
  assert.ok(sipBody, 'saveImportedPlan function found in HTML source');
});

test('saveImportedPlan returns true on the successful-write path', function () {
  assert.ok(sipBody, 'function body present');
  var successToastIdx = sipBody.indexOf('"✅ Plan importado y activado correctamente"');
  var returnTrueIdx = sipBody.indexOf('return true;');
  assert.ok(successToastIdx > -1, 'success toast present');
  assert.ok(returnTrueIdx > -1, 'return true; present');
  assert.ok(successToastIdx < returnTrueIdx, 'return true must come after the success toast (i.e. after the write completed)');
});

test('saveImportedPlan returns false when the coach declines the replace-plan confirm', function () {
  assert.ok(sipBody, 'function body present');
  var confirmIdx = sipBody.indexOf('if (!confirmed) return false;');
  assert.ok(confirmIdx > -1, '"if (!confirmed) return false;" present — decline must be reported, not swallowed');
});

test('saveImportedPlan returns false from the catch block', function () {
  assert.ok(sipBody, 'function body present');
  var catchIdx = sipBody.indexOf('} catch (e) {');
  assert.ok(catchIdx > -1, 'catch block present');
  var afterCatch = sipBody.slice(catchIdx);
  var finallyIdx = afterCatch.indexOf('} finally {');
  assert.ok(finallyIdx > -1, 'finally block present');
  var catchBody = afterCatch.slice(0, finallyIdx);
  assert.ok(/return false;/.test(catchBody), 'catch block must return false');
});

test('saveImportedPlan returns false on the pre-write gate BLOCK', function () {
  assert.ok(sipBody, 'function body present');
  var blockIdx = sipBody.indexOf("_g78.status === 'BLOCK'");
  assert.ok(blockIdx > -1, 'gate BLOCK check present');
  var blockBlockEnd = sipBody.indexOf('}', blockIdx);
  var blockSlice = sipBody.slice(blockIdx, blockBlockEnd);
  assert.ok(/return false;/.test(blockSlice), 'gate BLOCK branch must return false');
});

// ── 2. Callers must check the return value before proceeding ───────────
function assertCallerChecksResult(fnDecl, label) {
  var body = extractFnBody(src, fnDecl);
  test(label + ' function is present', function () {
    assert.ok(body, label + ' found in HTML source');
  });
  test(label + ' captures saveImportedPlan(clientId) result in a variable', function () {
    assert.ok(body, 'function body present');
    assert.ok(
      /const\s+_\w+\s*=\s*await saveImportedPlan\(clientId\);/.test(body),
      label + ' must capture the return value of saveImportedPlan(clientId), not call it fire-and-forget'
    );
  });
  test(label + ' bails out (return) when saveImportedPlan resolves falsy', function () {
    assert.ok(body, 'function body present');
    var m = body.match(/const\s+(_\w+)\s*=\s*await saveImportedPlan\(clientId\);/);
    assert.ok(m, 'capture variable found');
    var varName = m[1];
    var checkRe = new RegExp('if\\s*\\(\\s*!' + varName + '\\s*\\)\\s*\\{[\\s\\S]{0,300}?return;');
    assert.ok(checkRe.test(body), label + ' must have "if (!' + varName + ') { ... return; }" guarding the rest of the flow');
  });
}

assertCallerChecksResult('async function autoGeneratePlan(', 'autoGeneratePlan');
assertCallerChecksResult('async function loadPlanFromPastedAnalysis(', 'loadPlanFromPastedAnalysis');
assertCallerChecksResult('async function _autoGenerateForModal(', '_autoGenerateForModal');

// _submitModalImport is assigned as window._submitModalImport = async function(...)
test('_submitModalImport captures and checks saveImportedPlan(clientId) result', function () {
  var idx = src.indexOf('window._submitModalImport = async function');
  assert.ok(idx > -1, '_submitModalImport found in HTML source');
  var start = src.indexOf('{', idx);
  var depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  var body = src.slice(start, i + 1);
  var m = body.match(/const\s+(_\w+)\s*=\s*await saveImportedPlan\(clientId\);/);
  assert.ok(m, '_submitModalImport must capture the return value of saveImportedPlan(clientId)');
  var varName = m[1];
  var checkRe = new RegExp('if\\s*\\(\\s*!' + varName + '\\s*\\)\\s*\\{[\\s\\S]{0,300}?return;');
  assert.ok(checkRe.test(body), '_submitModalImport must guard the post-save reload with "if (!' + varName + ') { ... return; }"');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
