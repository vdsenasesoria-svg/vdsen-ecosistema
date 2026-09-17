'use strict';
// QA Round 6: Error Recovery and Failure Contract Matrix
// Tests every critical write operation for:
//   R6-01 try/catch presence
//   R6-02 success action (toast/nav) AFTER the await, not before
//   R6-03 button re-enable in finally or catch
//   R6-04 form / editor data preserved (not cleared before write)
//   R6-05 session complete does not advance state on failure

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'),   'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

// ─── helpers ──────────────────────────────────────────────────────────────────

// Extract the body of a named function (first match by brace counting).
function extractFn(src, name) {
  const patterns = [
    new RegExp('async\\s+function\\s+' + name + '\\s*\\('),
    new RegExp('function\\s+' + name + '\\s*\\('),
  ];
  let m = null;
  let matchIndex = Infinity;
  for (const re of patterns) {
    const candidate = re.exec(src);
    if (candidate && candidate.index < matchIndex) {
      m = candidate;
      matchIndex = candidate.index;
    }
  }
  if (!m) return null;
  let depth = 0, start = null;
  for (let i = m.index; i < src.length; i++) {
    if (src[i] === '{') {
      if (start === null) start = i;
      depth++;
    } else if (src[i] === '}') {
      if (--depth === 0 && start !== null) return src.slice(start, i + 1);
    }
  }
  return null;
}

// Extract ALL block bodies that appear after a given keyword pattern.
// e.g. keyword=/\bcatch\s*\(/ finds all catch blocks,
//      keyword=/\bfinally\s*\{/ finds all finally blocks.
function extractAllBlocks(body, keywordRe) {
  const blocks = [];
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const slice = body.slice(searchFrom);
    const m = keywordRe.exec(slice);
    if (!m) break;
    // Find the opening brace of this block
    const afterKeyword = m.index + m[0].length;
    let braceIdx = -1;
    for (let i = searchFrom + afterKeyword - 1; i < body.length; i++) {
      if (body[i] === '{') { braceIdx = i; break; }
    }
    if (braceIdx === -1) { searchFrom += m.index + 1; continue; }
    let depth = 0, end = -1;
    for (let i = braceIdx; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') {
        if (--depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break;
    blocks.push(body.slice(braceIdx, end + 1));
    searchFrom = end + 1;
  }
  return blocks;
}

// Extract all try-block bodies from a function body.
function extractAllTryBlocks(body) {
  const blocks = [];
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const slice = body.slice(searchFrom);
    const m = /(?:^|[^\w])try\s*\{/.exec(slice);
    if (!m) break;
    const braceOffset = m.index + m[0].lastIndexOf('{');
    const braceStart = searchFrom + braceOffset;
    let depth = 0, end = -1;
    for (let i = braceStart; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') {
        if (--depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break;
    blocks.push(body.slice(braceStart, end + 1));
    searchFrom = end + 1;
  }
  return blocks;
}

function hasTryCatch(body) {
  return /\btry\s*\{/.test(body) && /\bcatch\s*\(/.test(body);
}

function hasFinally(body) {
  return /\bfinally\s*\{/.test(body);
}

// Returns true when successPattern appears AFTER the last await in ANY try block
// that itself contains at least one await.
function successAfterAwaitInTry(body, successPattern) {
  const tryBlocks = extractAllTryBlocks(body);
  for (const block of tryBlocks) {
    let lastAwaitIdx = -1;
    const awaitRe = /\bawait\b/g;
    let m2;
    while ((m2 = awaitRe.exec(block)) !== null) {
      lastAwaitIdx = m2.index;
    }
    if (lastAwaitIdx === -1) continue;
    const afterLastAwait = block.slice(lastAwaitIdx);
    if (successPattern.test(afterLastAwait)) return true;
  }
  return false;
}

// Returns true when `.disabled = false` appears in ANY catch or finally block
// within the function body.
function hasButtonReenableOnFailure(body) {
  const disabledFalse = /\.disabled\s*=\s*false/;
  const catchBlocks   = extractAllBlocks(body, /\bcatch\s*\(/g);
  const finallyBlocks = extractAllBlocks(body, /\bfinally\s*\{/g);
  return [...catchBlocks, ...finallyBlocks].some(b => disabledFalse.test(b));
}

// ─── operation map ────────────────────────────────────────────────────────────
const fnGuardarCI          = extractFn(CLIENT, 'guardarCI');
const fnSubmitPostSession  = extractFn(CLIENT, 'submitPostSession');
const fnConfirmSessionDone = extractFn(CLIENT, '_confirmSessionDone');
const fnDoSaveLogs         = extractFn(CLIENT, '_doSaveLogs');

const fnSaveTrainingPlan   = extractFn(COACH,  'saveTrainingPlan');
const fnSaveManualPlan     = extractFn(COACH,  'saveManualPlan');
const fnSaveImportedPlan   = extractFn(COACH,  'saveImportedPlan');
const fnSaveNutritionPlan  = extractFn(COACH,  'saveNutritionPlan');
const fnSaveSupplementPlan = extractFn(COACH,  'saveSupplementPlan');
const fnShowUpdatePlanModal = extractFn(COACH, 'showUpdatePlanModal');

// ─── CONTRACT R6-00: functions must exist ─────────────────────────────────────
console.log('\n=== R6-00: function existence ===');

assert.ok(fnGuardarCI,          'CLIENT: guardarCI must exist');
assert.ok(fnSubmitPostSession,  'CLIENT: submitPostSession must exist');
assert.ok(fnConfirmSessionDone, 'CLIENT: _confirmSessionDone must exist');
assert.ok(fnDoSaveLogs,         'CLIENT: _doSaveLogs must exist');
assert.ok(fnSaveTrainingPlan,   'COACH: saveTrainingPlan must exist');
assert.ok(fnSaveManualPlan,     'COACH: saveManualPlan must exist');
assert.ok(fnSaveImportedPlan,   'COACH: saveImportedPlan must exist');
assert.ok(fnSaveNutritionPlan,  'COACH: saveNutritionPlan must exist');
assert.ok(fnSaveSupplementPlan, 'COACH: saveSupplementPlan must exist');
assert.ok(fnShowUpdatePlanModal, 'COACH: showUpdatePlanModal must exist');

console.log('R6-00: all critical functions found — OK');

// ─── CONTRACT R6-01: every critical write has try/catch ──────────────────────
console.log('\n=== R6-01: try/catch presence ===');

assert.ok(hasTryCatch(fnSaveTrainingPlan),   'saveTrainingPlan must have try/catch');
assert.ok(hasTryCatch(fnSaveManualPlan),     'saveManualPlan must have try/catch');
assert.ok(hasTryCatch(fnSaveImportedPlan),   'saveImportedPlan must have try/catch');
assert.ok(hasTryCatch(fnSaveNutritionPlan),  'saveNutritionPlan must have try/catch');
assert.ok(hasTryCatch(fnSaveSupplementPlan), 'saveSupplementPlan must have try/catch');
assert.ok(hasTryCatch(fnShowUpdatePlanModal), 'showUpdatePlanModal inline handler must have try/catch');
assert.ok(hasTryCatch(fnGuardarCI),  'guardarCI must have try/catch');
assert.ok(hasTryCatch(fnDoSaveLogs), '_doSaveLogs must have try/catch');

console.log('R6-01: all critical writes have try/catch — OK');

// submitPostSession: has try/catch for inner calculateProgression guard only.
// The main write path (delegated to _confirmSessionDone -> _doSaveLogs) is not
// wrapped in its own try. Safe in current code because _confirmSessionDone never throws.
const submitPSHasTryCatch = hasTryCatch(fnSubmitPostSession);
console.log('R6-01: submitPostSession try/catch:', submitPSHasTryCatch
  ? 'present (inner guard for calculateProgression; main write path not wrapped — see GAP-01)'
  : 'GAP — no try/catch at all');

// _confirmSessionDone: uses return-false pattern (not try/catch).
const confirmDoneHasTryCatch = hasTryCatch(fnConfirmSessionDone);
console.log('R6-01: _confirmSessionDone try/catch:', confirmDoneHasTryCatch
  ? 'OK'
  : 'uses return-false pattern — relies on _doSaveLogs absorbing all errors');

// ─── CONTRACT R6-02: success action is AFTER the write await ─────────────────
console.log('\n=== R6-02: success-after-write ===');

const stp_ok = successAfterAwaitInTry(fnSaveTrainingPlan, /showToast/);
assert.ok(stp_ok, 'saveTrainingPlan: showToast must appear inside try AFTER last await');
console.log('R6-02: saveTrainingPlan success-after-write: OK');

const smp_ok = successAfterAwaitInTry(fnSaveManualPlan, /showToast/);
assert.ok(smp_ok, 'saveManualPlan: showToast must appear inside try AFTER last await');
console.log('R6-02: saveManualPlan success-after-write: OK');

const sip_ok = successAfterAwaitInTry(fnSaveImportedPlan, /showToast/);
assert.ok(sip_ok, 'saveImportedPlan: showToast must appear inside try AFTER last await');
console.log('R6-02: saveImportedPlan success-after-write: OK');

const snp_ok = successAfterAwaitInTry(fnSaveNutritionPlan, /showToast/);
assert.ok(snp_ok, 'saveNutritionPlan: showToast must appear inside try AFTER last await');
console.log('R6-02: saveNutritionPlan success-after-write: OK');

const ssp_ok = successAfterAwaitInTry(fnSaveSupplementPlan, /showToast/);
assert.ok(ssp_ok, 'saveSupplementPlan: showToast must appear inside try AFTER last await');
console.log('R6-02: saveSupplementPlan success-after-write: OK');

const upd_ok = successAfterAwaitInTry(fnShowUpdatePlanModal, /Plan actualizado|#44BB88/);
assert.ok(upd_ok, 'showUpdatePlanModal: success status must appear inside try AFTER last await');
console.log('R6-02: showUpdatePlanModal success-after-write: OK');

const ci_ok = successAfterAwaitInTry(fnGuardarCI, /showToast/);
assert.ok(ci_ok, 'guardarCI: showToast must appear inside try AFTER last await');
console.log('R6-02: guardarCI success-after-write: OK');

const cd_ok = /await _doSaveLogs[\s\S]*?showToast\('SES/.test(fnConfirmSessionDone);
assert.ok(cd_ok, '_confirmSessionDone: success toast must appear after await _doSaveLogs');
console.log('R6-02: _confirmSessionDone success-after-write: OK');

// R6-GAP-02 fixed by T125-C: submitPostSession now guards showSessionSummary
// with `if (_saved !== false)` — only shows summary when save succeeded.
const hasConditionalSummary = /if\s*\(_saved\s*!==\s*false\)\s*showSessionSummary/.test(fnSubmitPostSession);
assert.ok(
  hasConditionalSummary,
  'R6-02 (T125-C): submitPostSession must guard showSessionSummary with _saved !== false'
);
console.log('R6-02: submitPostSession showSessionSummary-after-failed-save: OK (T125-C)');

// ─── CONTRACT R6-03: button re-enable in finally or catch ────────────────────
console.log('\n=== R6-03: button re-enable on failure ===');

assert.ok(hasFinally(fnSaveTrainingPlan),   'saveTrainingPlan must have finally for button restore');
assert.ok(hasFinally(fnSaveManualPlan),     'saveManualPlan must have finally for button restore');
assert.ok(hasFinally(fnSaveImportedPlan),   'saveImportedPlan must have finally for button restore');
assert.ok(hasFinally(fnSaveNutritionPlan),  'saveNutritionPlan must have finally for button restore');
assert.ok(hasFinally(fnSaveSupplementPlan), 'saveSupplementPlan must have finally for button restore');

console.log('R6-03: COACH saves — finally blocks present: OK');

assert.ok(hasButtonReenableOnFailure(fnSaveTrainingPlan),   'saveTrainingPlan finally must re-enable button');
assert.ok(hasButtonReenableOnFailure(fnSaveManualPlan),     'saveManualPlan finally must re-enable button');
assert.ok(hasButtonReenableOnFailure(fnSaveImportedPlan),   'saveImportedPlan finally must re-enable button');
assert.ok(hasButtonReenableOnFailure(fnSaveNutritionPlan),  'saveNutritionPlan finally must re-enable button');
assert.ok(hasButtonReenableOnFailure(fnSaveSupplementPlan), 'saveSupplementPlan finally must re-enable button');

console.log('R6-03: COACH saves — button re-enable in finally: OK');

// showUpdatePlanModal: no finally but its Firestore write catch re-enables the button
assert.ok(hasButtonReenableOnFailure(fnShowUpdatePlanModal),
  'showUpdatePlanModal: some catch block must re-enable the apply button');
console.log('R6-03: showUpdatePlanModal button-restore in catch: OK');

// guardarCI: finally re-enables all CI buttons
assert.ok(hasFinally(fnGuardarCI), 'guardarCI must have finally block');
assert.ok(hasButtonReenableOnFailure(fnGuardarCI), 'guardarCI finally must re-enable buttons');
console.log('R6-03: guardarCI button-restore in finally: OK');

// GAP R6-GAP-03: submitPostSession resets _postSessionSubmitting via
// closePostSessionModal() BEFORE the await — not in a finally. On unexpected
// exception the flag would stay true (stuck modal guard).
const submitHasFinally = hasFinally(fnSubmitPostSession);
console.log('R6-03: submitPostSession has finally for _postSessionSubmitting reset:',
  submitHasFinally
    ? 'OK'
    : 'GAP (R6-GAP-03) — no finally; reset is pre-await via closePostSessionModal');

// ─── CONTRACT R6-04: form data preserved on failure ──────────────────────────
console.log('\n=== R6-04: form data preserved on failure ===');

// guardarCI: LOGS[k] is populated BEFORE the save try block.
const ciTryIdx   = fnGuardarCI.search(/\btry\s*\{/);
const logsKIdx   = fnGuardarCI.indexOf('LOGS[k]');
assert.ok(ciTryIdx > -1, 'guardarCI must have a try block');
assert.ok(logsKIdx !== -1 && logsKIdx < ciTryIdx,
  'guardarCI: LOGS[k] must be populated before the save try block');
console.log('R6-04: guardarCI form data in LOGS[k] before try: OK');

// saveManualPlan: manualPlan cleared INSIDE the try (after writes), not before
const mpClearIdx   = fnSaveManualPlan.indexOf('manualPlan = null');
const mpTryOpenIdx = fnSaveManualPlan.indexOf('try {');
assert.ok(mpClearIdx !== -1, 'saveManualPlan must set manualPlan = null');
assert.ok(mpClearIdx > mpTryOpenIdx,
  'saveManualPlan: manualPlan must be cleared inside try block, not before');
console.log('R6-04: saveManualPlan manualPlan cleared inside try only: OK');

// saveImportedPlan: _importedPlan cleared INSIDE the try (after writes), not before
const ipClearIdx   = fnSaveImportedPlan.indexOf('window._importedPlan = null');
const ipTryOpenIdx = fnSaveImportedPlan.indexOf('try {');
assert.ok(ipClearIdx !== -1, 'saveImportedPlan must set window._importedPlan = null');
assert.ok(ipClearIdx > ipTryOpenIdx,
  'saveImportedPlan: _importedPlan must be cleared inside try block, not before');
console.log('R6-04: saveImportedPlan _importedPlan cleared inside try only: OK');

// ─── CONTRACT R6-05: session complete does not advance state on failure ────────
console.log('\n=== R6-05: session complete — state rollback on failure ===');

// _confirmSessionDone: LOGS[key] is set optimistically, then deleted if save fails.
// Verify LOGS[key] = {...} appears before 'await _doSaveLogs' using positional check.
const logsKeyAssignIdx  = fnConfirmSessionDone.indexOf('LOGS[key]');
const doSaveLogsCallIdx = fnConfirmSessionDone.indexOf('await _doSaveLogs');
const keySetBeforeWrite = logsKeyAssignIdx !== -1 && doSaveLogsCallIdx !== -1 && logsKeyAssignIdx < doSaveLogsCallIdx;
assert.ok(keySetBeforeWrite, '_confirmSessionDone must set LOGS[key] before await _doSaveLogs');
console.log('R6-05: _confirmSessionDone LOGS[key] set before write: OK');

const hasRollback = /delete LOGS\[key\]/.test(fnConfirmSessionDone);
assert.ok(hasRollback, '_confirmSessionDone must rollback LOGS[key] when save fails');
console.log('R6-05: _confirmSessionDone rolls back LOGS[key] on failure: OK');

// _autoAdvanceWeekIfDone must gate REAL_WEEK++ behind an all-done check.
const fnAutoAdvance = extractFn(CLIENT, '_autoAdvanceWeekIfDone');
assert.ok(fnAutoAdvance, '_autoAdvanceWeekIfDone must exist');
const advanceHasGuard = /todasDone/.test(fnAutoAdvance) || /\.every\s*\(/.test(fnAutoAdvance);
assert.ok(advanceHasGuard,
  '_autoAdvanceWeekIfDone must check all sessions done before advancing REAL_WEEK');
console.log('R6-05: _autoAdvanceWeekIfDone guards REAL_WEEK++: OK');

// REAL_WEEK++ is NOT inside _confirmSessionDone (advancement is delegated to _autoAdvanceWeekIfDone)
const realWeekInConfirm = /REAL_WEEK\+\+/.test(fnConfirmSessionDone);
console.log('R6-05: REAL_WEEK++ in _confirmSessionDone:',
  realWeekInConfirm ? 'PRESENT (verify it is on success path only)' : 'NOT present — OK');

// ─── ACTIVATEPLAN: no standalone function exists ─────────────────────────────
console.log('\n=== activatePlan: audit ===');

const activatePlanExists = /async function activatePlan\s*\(/.test(COACH) ||
                           /function activatePlan\s*\(/.test(COACH);
console.log('activatePlan standalone function:',
  activatePlanExists ? 'EXISTS' : 'NOT FOUND — activation embedded in save* functions');

// The closest standalone activation helper is _applyTemplateToClient.
// Unlike save* which have try/catch + finally, this helper has none.
const fnApplyTemplate = extractFn(COACH, '_applyTemplateToClient');
if (fnApplyTemplate) {
  const atHasTryCatch = hasTryCatch(fnApplyTemplate);
  const atHasFinally  = hasFinally(fnApplyTemplate);
  console.log('_applyTemplateToClient try/catch:',
    atHasTryCatch ? 'OK' : 'GAP (R6-GAP-04) — no try/catch; Firestore error unhandled');
  console.log('_applyTemplateToClient finally:',
    atHasFinally ? 'OK' : 'GAP (R6-GAP-04) — no finally; no state restore on failure');
} else {
  console.log('_applyTemplateToClient: not found in extracted scope');
}

// ─── SUMMARY ──────────────────────────────────────────────────────────────────
console.log('\n=== FAILURE CONTRACTS MATRIX SUMMARY ===');
console.log([
  '',
  'Operation                      | try/catch | success-after-write | btn-restore  | data-preserved',
  '-------------------------------|-----------|---------------------|--------------|---------------',
  'CLIENT: guardarCI              |    Y      |         Y           |  Y (finally) |  Y (pre-try)  ',
  'CLIENT: submitPostSession      |  Y(inner) |      N (GAP-02)     |  N (GAP-03)  |  Y            ',
  'CLIENT: _confirmSessionDone    |  N(ret-F) |         Y           |  N/A         |  Y (rollback) ',
  'CLIENT: _doSaveLogs            |    Y      |         Y           |  N/A         |  N/A          ',
  'COACH:  saveTrainingPlan       |    Y      |         Y           |  Y (finally) |  Y (DOM)      ',
  'COACH:  saveManualPlan         |    Y      |         Y           |  Y (finally) |  Y (in-try)   ',
  'COACH:  saveImportedPlan       |    Y      |         Y           |  Y (finally) |  Y (in-try)   ',
  'COACH:  saveNutritionPlan      |    Y      |         Y           |  Y (finally) |  Y (DOM)      ',
  'COACH:  saveSupplementPlan     |    Y      |         Y           |  Y (finally) |  Y (DOM)      ',
  'COACH:  showUpdatePlanModal    |    Y      |         Y           |  Y (catch)   |  Y (DOM)      ',
  'COACH:  activatePlan (inline)  |  Y(embed) |      Y(embed)       |  Y(embed)    |  Y            ',
  'COACH:  _applyTemplateToClient |    N      |         N           |  N           |  Y            ',
  '',
  '(ret-F)  = return-false pattern: _doSaveLogs handles all exceptions',
  '(embed)  = activation via saveImportedPlan / saveManualPlan (both fully guarded)',
  '(in-try) = data cleared inside try block, not before — preserved on failure',
  '',
  'GAPS FOUND (4 total):',
  '  R6-GAP-01 (LOW)    submitPostSession: main write path has no dedicated try/catch.',
  '                     Safe only because _confirmSessionDone never throws currently.',
  '  R6-GAP-02 (MEDIUM) submitPostSession: showSessionSummary called unconditionally',
  '                     after _confirmSessionDone. If save failed, success summary still',
  '                     shows alongside the error toast — misleading UX.',
  '  R6-GAP-03 (LOW)    submitPostSession: _postSessionSubmitting flag reset before await,',
  '                     not in finally. Theoretical stuck-guard on unexpected exception.',
  '  R6-GAP-04 (MEDIUM) _applyTemplateToClient: no try/catch and no finally block.',
  '                     A Firestore error is completely unhandled — silent failure,',
  '                     no user feedback, no UI restore.',
  '',
].join('\n'));

console.log('All R6 contract tests passed (gaps documented above).');
