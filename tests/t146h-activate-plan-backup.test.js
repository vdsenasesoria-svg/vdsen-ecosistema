'use strict';
/**
 * T146 — Active plan transition integrity.
 *
 * Scope: _vdsenActivatePlanClick, _vdsenActivatePlanInFirestore,
 * saveImportedPlan/backupPlanIfExists, activePlanId/status/updatedAt.
 *
 * Audit findings:
 *   - _vdsenActivatePlanInFirestore runs inside runTransaction: ownership
 *     checks (coachId match on both plan and client), status check (only
 *     draft_approved plans can activate), and — critically — is already
 *     IDEMPOTENT: `if (clientData.activePlanId === planId) return;` makes a
 *     double invocation (or a retry after a UI glitch) a safe no-op with no
 *     duplicate write. It writes ONLY to clients/{clientId} and deliberately
 *     never mutates plans/{planId} or plans/{prevPlanId} — history is
 *     preserved by the outgoing plan doc's continued existence, not by a
 *     status flag on it. This is a sound, intentional design.
 *   - The click handler is further protected against a real double-click by
 *     window.confirm() itself, which blocks all page interaction until
 *     dismissed, before btn.disabled is even set.
 *   - _vdsenSaveDraftToFirestore uses the AI response's own requestId as a
 *     deterministic Firestore doc ID with an explicit idempotency check —
 *     a concurrent double-save produces the same document content twice
 *     (self-healing), not corruption.
 *   - backupPlanIfExists already wraps its own read+write in try/catch and
 *     returns null on any failure — a backup failure can never throw up
 *     into the caller or block activation (matches the pattern already
 *     relied on by saveManualPlan/duplicatePlan/_applyTemplateToClient).
 *
 * Real bug found: _vdsenActivatePlanInFirestore never wrote to the
 * `plans_backup` collection when replacing an existing active plan — every
 * OTHER plan-replacing path in this file (saveManualPlan, duplicatePlan,
 * _applyTemplateToClient, _autoGenerateForModal, saveImportedPlan) calls
 * backupPlanIfExists(clientId) before overwriting activePlanId. The coach's
 * "🔍 Comparar con plan anterior" feature queries plans_backup by clientId
 * specifically (not plans/{id} directly), so a plan activated through the
 * Preview -> Approve -> Activate flow left that comparison feature silently
 * showing "no previous plan" even though a previous plan existed and was
 * correctly preserved as a plans/{id} document.
 *
 * Fix: call backupPlanIfExists(clientId) right before
 * _vdsenActivatePlanInFirestore(planId, clientId) in _vdsenActivatePlanClick
 * — same call-order convention as every other replacing path. No-ops safely
 * (returns null) when there is no existing active plan (first activation).
 *
 * Run: node tests/t146h-activate-plan-backup.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}

const activateClickFn = extractFunction(COACH, 'window._vdsenActivatePlanClick = async function()');
assert.ok(activateClickFn, '_vdsenActivatePlanClick must exist');

// ─────────────────────────────────────────────────────────────────────────────
// Fix: backupPlanIfExists called right before the Firestore activation write.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  activateClickFn.includes('await backupPlanIfExists(clientId);'),
  'T146-H: _vdsenActivatePlanClick must back up the outgoing plan before activating the new one'
);

const backupIdx   = activateClickFn.indexOf('await backupPlanIfExists(clientId);');
const activateIdx = activateClickFn.indexOf('await _vdsenActivatePlanInFirestore(planId, clientId);');
assert.ok(backupIdx !== -1 && activateIdx !== -1 && backupIdx < activateIdx,
  'T146-H: backupPlanIfExists must run BEFORE _vdsenActivatePlanInFirestore, not after');

// Must run after the confirm() dialog and the T145-H context guard (no wasted
// backup writes for an action the coach then cancels, or for a stale context).
const confirmIdx = activateClickFn.indexOf('if (!confirmed) return;');
const contextGuardIdx = activateClickFn.indexOf("!== clientId");
assert.ok(confirmIdx !== -1 && confirmIdx < backupIdx,
  'T146-H: backup must run after the confirm() gate, not before');
assert.ok(contextGuardIdx !== -1 && contextGuardIdx < backupIdx,
  'T146-H: backup must run after the T145-H stale-context guard');

console.log('_vdsenActivatePlanClick backs up the outgoing plan before activating — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guards — transaction idempotency, ownership/status checks,
// immutable plan-doc design, and error handling all remain unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const activateTxFn = extractFunction(COACH, 'async function _vdsenActivatePlanInFirestore(planId, clientId)');
assert.ok(activateTxFn, '_vdsenActivatePlanInFirestore must exist');

assert.ok(
  activateTxFn.includes('if (clientData.activePlanId === planId) return;'),
  'T146-H regression: the transaction must still be idempotent on repeated activation of the same plan'
);
assert.ok(
  /if \(planData\.status !== 'draft_approved'\) throw/.test(activateTxFn),
  'T146-H regression: activation must still require status === draft_approved'
);
assert.ok(
  activateTxFn.includes("if (planData.coachId !== coachId) throw") &&
  activateTxFn.includes("if (clientData.coachId !== coachId) throw"),
  'T146-H regression: ownership checks on both plan and client must remain'
);
assert.ok(
  !/t\.update\(planRef/.test(activateTxFn) && !/t\.delete\(/.test(activateTxFn),
  'T146-H regression: the transaction must still never mutate/delete the plan doc(s) — activePlanId is the sole canonical pointer'
);

assert.ok(
  /catch \(err\) \{[\s\S]*?btn\.disabled = false[\s\S]*?d2Status\.innerHTML/.test(activateClickFn),
  'T146-H regression: activation failure must still re-enable the button and show an error, not a false success'
);

const backupFn = extractFunction(COACH, 'async function backupPlanIfExists(clientId)');
assert.ok(backupFn, 'backupPlanIfExists must exist');
assert.ok(
  /try\s*\{[\s\S]*catch\(e\)\s*\{\s*console\.warn/.test(backupFn),
  'T146-H regression: backupPlanIfExists must still swallow its own errors and never throw into callers'
);

console.log('Transaction idempotency, ownership/status checks, and error handling unchanged — OK');

console.log('');
console.log('T146 — active plan transition integrity: ALL ASSERTIONS PASSED');
