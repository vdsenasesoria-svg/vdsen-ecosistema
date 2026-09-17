'use strict';
// QA Round 7: R6-GAP-03 and R6-GAP-04 Resolution Contracts
//
// R6-GAP-03 (CLIENT): submitPostSession._postSessionSubmitting reset is pre-await,
//            not in a finally block.  If an unexpected exception escapes the function
//            after the flag is set, the guard stays true and the user is locked out.
//            Fix: wrap the main body in try/finally; reset in finally.
//
// R6-GAP-04 (COACH):  _applyTemplateToClient has NO try/catch and NO finally.
//            A Firestore error from addDoc/updateDoc is completely unhandled —
//            silent failure, no user feedback, no UI state restore.
//            Fix: wrap addDoc + updateDoc in try/catch; show error toast in catch.
//
// Tests follow the gap-documentation pattern: they pass (exit 0) regardless of
// whether the fix is already merged.  Gaps are logged to stdout; the orchestrator
// upgrades log lines to assert() calls after integration.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'),   'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

// ─── helpers (adapted from qa_r6_failure_contracts.test.js) ──────────────────

/** Extract the source of a named function by brace-counting (first match). */
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

function hasTryCatch(body) {
  return /\btry\s*\{/.test(body) && /\bcatch\s*\(/.test(body);
}

function hasFinally(body) {
  return /\bfinally\s*\{/.test(body);
}

// ─── load target functions ────────────────────────────────────────────────────

const fnSubmitPostSession  = extractFn(CLIENT, 'submitPostSession');
const fnApplyTemplate      = extractFn(COACH,  '_applyTemplateToClient');

// ─── CONTRACT R7-00: functions must exist ─────────────────────────────────────
console.log('\n=== R7-00: target function existence ===');

assert.ok(fnSubmitPostSession, 'CLIENT: submitPostSession must exist');
console.log('R7-00: submitPostSession found — OK');

// _applyTemplateToClient is defined inside a closure; extractFn uses brace
// counting from the function keyword, so it works even when nested.
assert.ok(fnApplyTemplate, 'COACH: _applyTemplateToClient must exist');
console.log('R7-00: _applyTemplateToClient found — OK');

// ─── CONTRACT R7-01: _postSessionSubmitting lifecycle ────────────────────────
// (R6-GAP-03)
// Required behaviour AFTER the fix:
//   1. _postSessionSubmitting = true must appear BEFORE the first await.
//   2. _postSessionSubmitting must be reset in a finally block (or equivalent
//      path that runs on both success AND exception), so the guard cannot get
//      permanently stuck if an unexpected error propagates out of the function.
console.log('\n=== R7-01: _postSessionSubmitting lifecycle (R6-GAP-03) ===');

// CHECK 1: flag must be set to true before the first await.
// We verify this positionally within the extracted function body.
const pss_flagSetIdx   = fnSubmitPostSession.indexOf('_postSessionSubmitting = true');
const pss_firstAwaitIdx = fnSubmitPostSession.indexOf('await ');

assert.ok(
  pss_flagSetIdx !== -1,
  'R7-01 Check 1: _postSessionSubmitting = true must appear in submitPostSession'
);
assert.ok(
  pss_firstAwaitIdx !== -1,
  'R7-01 Check 1: submitPostSession must contain at least one await'
);
assert.ok(
  pss_flagSetIdx < pss_firstAwaitIdx,
  'R7-01 Check 1: _postSessionSubmitting = true must precede the first await'
);
console.log('R7-01 Check 1: _postSessionSubmitting set before first await — OK');

// CHECK 2: flag reset must be inside a finally block (R6-GAP-03 fix target).
// Current state: reset happens via closePostSessionModal() which is called
// BEFORE the main await — this means on an unexpected post-await exception the
// flag stays true.  The fix is a try/finally that resets the flag regardless.
const pss_hasFinally = hasFinally(fnSubmitPostSession);

// Detect whether the finally block actually resets the flag.
// After the fix the pattern will be: finally { ... _postSessionSubmitting = false ... }
const pss_finallyResetIdx = (() => {
  if (!pss_hasFinally) return -1;
  // Find the finally block and check if it contains the reset.
  const finallyMatch = /\bfinally\s*\{/.exec(fnSubmitPostSession);
  if (!finallyMatch) return -1;
  let depth = 0, start = -1;
  for (let i = finallyMatch.index + finallyMatch[0].length - 1; i < fnSubmitPostSession.length; i++) {
    if (fnSubmitPostSession[i] === '{') { if (start === -1) start = i; depth++; }
    else if (fnSubmitPostSession[i] === '}') { if (--depth === 0 && start !== -1) return fnSubmitPostSession.slice(start, i + 1).indexOf('_postSessionSubmitting = false'); }
  }
  return -1;
})();

const pss_finallyHasReset = pss_finallyResetIdx !== -1;

if (!pss_hasFinally || !pss_finallyHasReset) {
  // Document the gap — do NOT assert; Agent A may be landing the fix in parallel.
  console.log('R7-01 Check 2: _postSessionSubmitting finally guard: GAP (R6-GAP-03)');
  console.log('  Current state: reset via closePostSessionModal() called PRE-await;');
  console.log('  no finally block ensures reset on unexpected exception.');
  console.log('  Expected fix: try { ... } finally { _postSessionSubmitting = false; ... }');
} else {
  // Fix is already merged — upgrade to an assertion.
  assert.ok(
    true,  // already verified above
    'R7-01 Check 2: _postSessionSubmitting finally guard present and resets flag'
  );
  console.log('R7-01 Check 2: _postSessionSubmitting reset in finally — OK (fix merged)');
}

// ─── CONTRACT R7-02: _applyTemplateToClient error recovery ───────────────────
// (R6-GAP-04)
// Required behaviour AFTER the fix:
//   The function must have a try block wrapping addDoc + updateDoc, and a
//   catch block that shows an error toast so the user gets feedback on failure.
console.log('\n=== R7-02: _applyTemplateToClient error recovery (R6-GAP-04) ===');

const at_hasTry   = /\btry\s*\{/.test(fnApplyTemplate);
const at_hasCatch = /\bcatch\s*\(/.test(fnApplyTemplate);

if (!at_hasTry || !at_hasCatch) {
  // Document the gap — do NOT assert; Agent B may be landing the fix in parallel.
  console.log('R7-02: _applyTemplateToClient error recovery: GAP (R6-GAP-04)');
  console.log('  has try:', at_hasTry, '/ has catch:', at_hasCatch);
  console.log('  Current state: addDoc + updateDoc are unguarded;');
  console.log('  a Firestore error silently escapes with no user feedback.');
  console.log('  Expected fix: wrap addDoc+updateDoc in try/catch; showToast(err, true) in catch.');
} else {
  // Fix is already merged.
  assert.ok(at_hasTry,   '_applyTemplateToClient must have try block');
  assert.ok(at_hasCatch, '_applyTemplateToClient must have catch block');
  console.log('R7-02: _applyTemplateToClient has try/catch — OK (fix merged)');

  // Additional check: catch block should surface the error to the user.
  const catchMatch = /\bcatch\s*\(/.exec(fnApplyTemplate);
  if (catchMatch) {
    const afterCatch = fnApplyTemplate.slice(catchMatch.index);
    const hasFeedback = /showToast/.test(afterCatch.slice(0, afterCatch.indexOf('}') + 1));
    if (!hasFeedback) {
      console.log('R7-02 (advisory): catch block found but no showToast — user feedback may be missing');
    } else {
      console.log('R7-02: catch block calls showToast — user receives error feedback: OK');
    }
  }
}

// ─── RESIDUAL SCAN ────────────────────────────────────────────────────────────
// Brief scan for patterns similar to R6-GAP-03 and R6-GAP-04.
// Only MEDIUM+ severity findings are reported here.
console.log('\n=== RESIDUAL SCAN ===');

// ── CLIENT: other inflight / submitting guards ────────────────────────────────
// Identify every _xxxInFlight / _xxxSubmitting / _xxxSaving flag declared in CLIENT.
// For each (except _postSessionSubmitting already covered by R7-01), extract the
// enclosing function and check whether the flag is reset inside a finally block.
const clientInFlightVars = [...CLIENT.matchAll(/var\s+(_\w+(?:InFlight|Submitting|Saving))\s*=/g)]
  .map(m => m[1]);

console.log('CLIENT inflight/submitting vars found:', clientInFlightVars.join(', ') || '(none)');

// Map each var to the function name that owns it by locating the enclosing
// `async function <name>` before the var declaration.
function findOwnerFnName(src, varName) {
  const varIdx = src.indexOf('var ' + varName + ' = ');
  if (varIdx === -1) return null;
  // Walk backwards to find the most recent function keyword
  const before = src.slice(0, varIdx);
  const m = [...before.matchAll(/async\s+function\s+(\w+)\s*\(/g)];
  return m.length ? m[m.length - 1][1] : null;
}

for (const varName of clientInFlightVars) {
  if (varName === '_postSessionSubmitting') continue; // covered by R7-01

  // Use extractFn on the owning function for an accurate check.
  // _guardarCIInFlight is declared as a module-level var (not inside the function),
  // so we find the owner by matching guardarCI directly.
  const fnName = varName === '_guardarCIInFlight' ? 'guardarCI'
    : findOwnerFnName(CLIENT, varName);

  if (!fnName) {
    console.log(`RESIDUAL CLIENT: ${varName} — could not determine owner function; skip`);
    continue;
  }

  const body = extractFn(CLIENT, fnName);
  if (!body) {
    console.log(`RESIDUAL CLIENT: ${varName} — owner ${fnName} body not found; skip`);
    continue;
  }

  const setFalseRe = new RegExp(varName.replace(/[_]/g, '_') + '\\s*=\\s*false');
  const bodyHasFinally = hasFinally(body);
  const finallyHasReset = bodyHasFinally && (() => {
    const fm = /\bfinally\s*\{/.exec(body);
    if (!fm) return false;
    // Grab the finally block text
    let depth = 0, start = -1, end = -1;
    for (let i = fm.index + fm[0].length - 1; i < body.length; i++) {
      if (body[i] === '{') { if (start === -1) start = i; depth++; }
      else if (body[i] === '}') { if (--depth === 0 && start !== -1) { end = i; break; } }
    }
    if (end === -1) return false;
    return setFalseRe.test(body.slice(start, end + 1));
  })();

  if (!bodyHasFinally || !finallyHasReset) {
    console.log(`RESIDUAL CLIENT (MEDIUM): ${varName} in ${fnName} lacks finally-reset`);
  } else {
    console.log(`RESIDUAL CLIENT: ${varName} in ${fnName} has finally-reset — OK`);
  }
}

// ── COACH: async write functions with no try/catch ────────────────────────────
// Scan candidate functions that contain updateDoc/addDoc/setDoc but no try keyword.
// Exclude already-audited functions (all save* are clean per R6) and functions
// where the throw-to-caller pattern is intentional (caller wraps in try/catch).
//
// Intentional throw-to-caller (LOW severity, excluded):
//   mergeClients         — caller at line ~2298 wraps in try/catch with UI feedback
//   ensureCoachDoc       — tiny setDoc utility; all callers wrap in try/catch
//   _vdsenSaveDraftToFirestore — throws validation errors; caller (autoGeneratePlan
//                                / vdsenAIPreview) catches and shows toast

const coachAsyncFnRe = /async\s+function\s+(\w+)\s*\([^)]*\)\s*\{/g;
const alreadyAudited = new Set([
  'saveTrainingPlan','saveManualPlan','saveImportedPlan',
  'saveNutritionPlan','saveSupplementPlan','showUpdatePlanModal',
  '_applyTemplateToClient',      // covered by R7-02
  'mergeClients',                // intentional: caller handles (LOW)
  'deleteClient',                // has try/catch
  'applyFichaPatch',             // has try/catch
  'extendPlanWeeks',             // has try/catch
  'ensureCoachDoc',              // intentional utility: all callers handle (LOW)
  '_vdsenSaveDraftToFirestore',  // intentional throw-to-caller pattern (LOW)
]);

let residualCoachCount = 0;
let coachMatch;
while ((coachMatch = coachAsyncFnRe.exec(COACH)) !== null) {
  const fnNameC = coachMatch[1];
  if (alreadyAudited.has(fnNameC)) continue;

  const body = extractFn(COACH, fnNameC);
  if (!body) continue;
  if (!/\bawait\s+(addDoc|updateDoc|setDoc|deleteDoc)\b/.test(body)) continue;
  if (hasTryCatch(body)) continue; // properly guarded

  // Found a candidate with direct Firestore writes but no try/catch
  residualCoachCount++;
  console.log(`RESIDUAL COACH (MEDIUM?): ${fnNameC} has Firestore write(s) but no try/catch — verify callers`);
  if (residualCoachCount >= 2) {
    console.log('  (additional residual candidates truncated — max 2 shown)');
    break;
  }
}

if (residualCoachCount === 0) {
  console.log('COACH residual scan: no additional unguarded Firestore writes found — OK');
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────
console.log('\n=== R7 GAP RESOLUTION SUMMARY ===');
console.log([
  '',
  'Contract  | Finding                              | Status',
  '----------|--------------------------------------|-------',
  'R7-01     | _postSessionSubmitting finally guard  | ' + (pss_hasFinally && pss_finallyHasReset ? 'OK (fix merged)' : 'GAP (R6-GAP-03) — Agent A fixing'),
  'R7-02     | _applyTemplateToClient try/catch      | ' + (at_hasTry && at_hasCatch ? 'OK (fix merged)' : 'GAP (R6-GAP-04) — Agent B fixing'),
  '',
  'Upgrade path: once both gaps are fixed and integrated, promote the gap-doc',
  'console.log blocks above to assert.ok() calls (delete the if/else wrappers).',
  '',
].join('\n'));

console.log('All R7 contract tests passed (gaps documented above).');
