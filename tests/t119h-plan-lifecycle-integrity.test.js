/**
 * T119-H — Plan lifecycle integrity: prescriptionExerciseId preservation + updatedAt coverage
 *
 * Bundles three QA-R3 findings:
 *
 * QA-R3-01 (CRITICAL): showUpdatePlanModal's exercise normalization discarded
 * prescriptionExerciseId, so _stampPrescriptionIds regenerated fresh UUIDs for every
 * exercise on every "Actualizar plan en sitio" — silently breaking POSITION ≠ IDENTITY.
 * Fix: prescriptionExerciseId is now carried through the normalization; stamp preserves
 * it (or assigns fresh UUIDs only for genuinely new/missing exercises).
 *
 * QA-R3-02 (MEDIUM): Template-applied plans and AI draft plans lacked updatedAt.
 * The client listener guards `if (!updatedAt) return`, so these plans were silently
 * dropped — clients never saw the first activation, and the first coach edit also failed.
 * Fix: updatedAt added to _applyTemplateToClient, the standalone template-assign path,
 * and the VDSEN AI draft document.
 *
 * QA-R3-03 (LOW): duplicatePlan and duplicatePlanToClient spread ...planData without
 * overriding updatedAt, potentially inheriting a stale or missing timestamp.
 * Fix: explicit updatedAt: new Date().toISOString() after the spread in both.
 *
 * Run: node tests/t119h-plan-lifecycle-integrity.test.js
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
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

console.log('T119-H — Plan lifecycle integrity (QA-R3-01/02/03)');

// ── QA-R3-01: showUpdatePlanModal prescriptionExerciseId preservation ──

test('showUpdatePlanModal normalize block carries prescriptionExerciseId', function() {
  // The normalize block is an arrow function inside _updApplyBtn.onclick inside showUpdatePlanModal.
  // The fix adds prescriptionExerciseId to the exercise map.
  var fnIdx = src.indexOf('async function showUpdatePlanModal(');
  assert.ok(fnIdx > -1, 'showUpdatePlanModal found');
  // Find the exercise normalization map within this function scope (up to next top-level fn)
  var fnEnd = src.indexOf('\n  async function ', fnIdx + 10);
  var fnChunk = fnEnd > -1 ? src.slice(fnIdx, fnEnd) : src.slice(fnIdx, fnIdx + 5000);
  assert.ok(
    fnChunk.indexOf('prescriptionExerciseId: ex.prescriptionExerciseId') > -1,
    'prescriptionExerciseId carried in exercise normalization'
  );
});

test('_stampPrescriptionIds preserves existing IDs', function() {
  var body = extractFnBody(src, 'function _stampPrescriptionIds(');
  assert.ok(body, '_stampPrescriptionIds found');
  // Key logic: if id exists and not seen → return ex unchanged
  assert.ok(
    body.indexOf('ex.prescriptionExerciseId') > -1,
    'checks ex.prescriptionExerciseId'
  );
  assert.ok(
    body.indexOf('if (id && !seen[id])') > -1 || body.indexOf('id && !seen') > -1,
    'has existing-id preservation guard'
  );
});

// ── QA-R3-02: updatedAt in all three creation paths ──

test('_applyTemplateToClient addDoc includes updatedAt', function() {
  var body = extractFnBody(src, 'async function _applyTemplateToClient(');
  assert.ok(body, '_applyTemplateToClient found');
  var addDocIdx = body.indexOf('addDoc(collection(db');
  assert.ok(addDocIdx > -1, 'addDoc found');
  var chunk = body.slice(addDocIdx, addDocIdx + 600);
  assert.ok(chunk.indexOf('updatedAt') > -1, 'updatedAt present in addDoc payload');
});

test('standalone template-assign path (addDoc in plans) includes updatedAt', function() {
  // This is the assign-template-to-client via the templateList UI
  // Find by its unique marker: generatedBy: 'template:'+template.name
  var markerIdx = src.indexOf("generatedBy: 'template:'+template.name");
  assert.ok(markerIdx > -1, "generatedBy: 'template:'+template.name marker found");
  var chunk = src.slice(markerIdx, markerIdx + 300);
  assert.ok(chunk.indexOf('updatedAt') > -1, 'updatedAt present near template.name assignment');
});

test('VDSEN AI draft draftDoc includes updatedAt', function() {
  // draftDoc is defined near serverTimestamp() calls
  var draftDocIdx = src.indexOf('const draftDoc = {');
  assert.ok(draftDocIdx > -1, 'draftDoc found');
  var chunk = src.slice(draftDocIdx, draftDocIdx + 1500);
  assert.ok(chunk.indexOf('updatedAt') > -1, 'updatedAt present in draftDoc');
});

// ── QA-R3-03: duplicatePlan / duplicatePlanToClient explicit updatedAt ──

test('duplicatePlan sets explicit updatedAt after spread', function() {
  var body = extractFnBody(src, 'async function duplicatePlan(');
  assert.ok(body, 'duplicatePlan found');
  // newPlan spread must have explicit updatedAt
  assert.ok(
    body.indexOf('updatedAt: new Date().toISOString()') > -1 ||
    body.indexOf("updatedAt:new Date().toISOString()") > -1,
    'explicit updatedAt in duplicatePlan newPlan'
  );
});

test('duplicatePlanToClient sets explicit updatedAt after spread', function() {
  var body = extractFnBody(src, 'async function duplicatePlanToClient(');
  assert.ok(body, 'duplicatePlanToClient found');
  assert.ok(
    body.indexOf('updatedAt: new Date().toISOString()') > -1 ||
    body.indexOf("updatedAt:new Date().toISOString()") > -1,
    'explicit updatedAt in duplicatePlanToClient addDoc payload'
  );
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
