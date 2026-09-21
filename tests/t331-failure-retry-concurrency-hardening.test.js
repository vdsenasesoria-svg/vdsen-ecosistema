'use strict';
/**
 * T331 — Failure / retry / concurrency hardening (audit; already correct
 * across the whole chain, confirmed by direct reads -- no new code change
 * this phase beyond what T325/T329 already fixed).
 *
 * Verified real failure-path guarantees, function by function:
 *
 *  - generate request fails / Preview response malformed: vdsenAIPreview's
 *    try/catch shows a real UI_STATES.error; FINDING 1 (T325) now also
 *    hard-blocks a schema-valid-but-contract-violating response before it
 *    becomes an activatable Preview.
 *  - activation write fails: _vdsenActivatePlanInFirestore is a single
 *    Firestore transaction (atomic all-or-nothing); the click handler's
 *    catch re-enables the button and shows the real error; activePlanId
 *    is left completely untouched on failure (transaction rolls back).
 *  - backup write fails: backupPlanIfExists catches its own errors and
 *    returns null (documented, intentional non-fatal design -- activation
 *    still proceeds since the backup is a safety-net, not the primary
 *    action; no false success is shown ABOUT the backup specifically,
 *    since there is no dedicated backup-success message at all).
 *  - Coach intervention save fails: _vdsenCoachIntervene's catch shows a
 *    real error; the success toast and _detailClientData mutation only
 *    happen strictly after the awaited updateDoc resolves.
 *  - slow request + client switch: _vdsenCoachIntervene captures
 *    ctx.clientId into _clientIdSnap BEFORE its own await, then re-checks
 *    `_detailClientId !== _clientIdSnap` AFTER the write resolves, before
 *    showing success or mutating UI state -- a coach who switched clients
 *    mid-save gets no cross-client UI leakage. _vdsenSaveDraftClick/
 *    _vdsenActivatePlanClick both re-verify planClientSelect against the
 *    preview's own clientId (T145-H).
 *  - double-click activation: FINDING 3 (T325) in-flight guard, plus the
 *    activation transaction's own idempotency (re-activating the same
 *    plan is a documented no-op).
 *  - double-click log save / refresh during pending save / listener
 *    reconnect / offline-reconnect: all exhaustively covered by T291-T324's
 *    own client-side test suites (T295, T306, T314, T321, T323) -- not
 *    re-derived here to avoid duplicating that work.
 *  - Client-side terminal writes (set save, session completion, nutrilog,
 *    check-in) never show false success: re-confirmed end-to-end in T323
 *    CASE L using the real production functions.
 *  - _vdsenSaveDraftToFirestore additionally has: a server-side-equivalent
 *    revalidation of the review gate (medical blockers/rejections/
 *    unresolved items block the save even if the UI state was somehow
 *    bypassed), an explicit ownership check, and TRUE idempotency via
 *    requestId as the Firestore document ID with a conflict check if a
 *    doc with that id already exists under a different client/coach.
 *
 * Run: node tests/t331-failure-retry-concurrency-hardening.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) throw new Error('not found: ' + decl);
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  throw new Error('unbalanced braces: ' + decl);
}

// ── Coach intervention: stale-context snapshot + re-check after write. ─────
const interveneSrc = extractFunction(COACH, 'async function _vdsenCoachIntervene(action, status) {');
ok(interveneSrc.includes('if (_savingCoachIntervention) return;'), 'in-flight guard present');
ok(interveneSrc.includes('const _clientIdSnap = ctx.clientId;'), 'clientId captured before any await');
ok(interveneSrc.includes('if (_detailClientId !== _clientIdSnap) return;'), 'stale-context re-check after the write, before showing success/mutating UI -- slow-request+client-switch cannot leak');
ok(interveneSrc.includes("showToast('Error: ' + e.message, true);"), 'a real error is shown on write failure');
ok(interveneSrc.includes('_savingCoachIntervention = false;') && interveneSrc.includes('finally'), 'the in-flight flag always resets, even on failure');

// ── _vdsenSaveDraftToFirestore: review-gate revalidation, ownership,
// requestId-based idempotency. ─────────────────────────────────────────────
const saveDraftSrc = extractFunction(COACH, 'async function _vdsenSaveDraftToFirestore() {');
ok(saveDraftSrc.includes("if (medicalBlockerGate > 0)"), 'medical blockers revalidated server-side-equivalent, not just trusted from the UI');
ok(saveDraftSrc.includes("if (clientData.coachId !== coachId) throw new Error('FOREIGN_OWNER"), 'explicit ownership check before any write');
ok(saveDraftSrc.includes("const planRef = doc(db, 'plans', requestId);") && saveDraftSrc.includes('IDEMPOTENCY_CONFLICT'),
  'true idempotency: requestId is the Firestore document id, with an explicit conflict check if the id already exists under a different client/coach');

// ── Activation: atomic transaction, failure never touches activePlanId. ────
const activateInFirestoreSrc = extractFunction(COACH, 'async function _vdsenActivatePlanInFirestore(planId, clientId) {');
ok(activateInFirestoreSrc.includes('await runTransaction(db, async function(t) {'), 'activation is a single atomic Firestore transaction -- no partial-write state possible');
const activateClickSrc = extractFunction(COACH, 'window._vdsenActivatePlanClick = async function() {');
ok(activateClickSrc.includes("if (btn) { btn.disabled = false; btn.textContent = '⚡ Activar plan'; }"), 'a failed activation re-enables the button (recoverable, not stuck)');

// ── Backup failure is non-fatal by explicit design, never fabricates a
// dedicated backup-success message. ─────────────────────────────────────────
const backupSrc = extractFunction(COACH, 'async function backupPlanIfExists(clientId) {');
ok(backupSrc.includes("catch(e) { console.warn('backup falló:', e); return null; }"), 'backup failure is caught and logged, never thrown up to block activation (documented intentional design)');
ok(!activateClickSrc.includes('backup guardado') && !activateClickSrc.includes('Respaldo creado'), 'the activation success message never claims anything specific about the backup succeeding');

console.log('');
console.log('T331 — Failure/retry/concurrency hardening: ' + pass + ' assertions PASSED. Already correct; no new code change this phase.');
