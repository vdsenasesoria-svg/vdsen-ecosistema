'use strict';
/**
 * T145-H — Preview action context guard: block Guardar borrador / Activar
 * plan from operating on a preview whose client no longer matches the
 * currently-selected client.
 *
 * Scope per T145: _vdsenCurrentPreview, _vdsenAIShowPreview(), the Guardar
 * borrador / Activar plan handlers, #planClientSelect.
 *
 * Bug found: _vdsenSaveDraftClick and _vdsenActivatePlanClick (the D.2
 * action handlers wired to "Guardar borrador aprobado" and "Activar plan")
 * operated purely on module state (_vdsenCurrentPreview.clientId /
 * _vdsenDraftPlanId) with no check against the LIVE #planClientSelect value.
 * The preview modal's close button (✕) only sets style.display='none' — it
 * never clears _vdsenCurrentPreview. So: open a preview for client A, close
 * the modal (or simply change the dropdown without closing it), select
 * client B in #planClientSelect, then trigger Guardar borrador or Activar
 * plan (both handlers are exposed as window.* and reachable independent of
 * the modal's own visibility) — the action would silently proceed against
 * client A's preview/draft while the visible UI context is B. Reproduces
 * exactly the steps in T145: Preview for A -> switch dropdown to B ->
 * Guardar/Activar still possible.
 *
 * Fix: both handlers now compare document.getElementById('planClientSelect')
 * .value against the preview's own clientId before doing anything else (no
 * Firestore read/write happens before this check) — the same
 * snapshot-vs-live-value context-guard pattern already used throughout this
 * file (T118-H/T123-H/T127-H's _clientIdSnap !== _detailClientId, and
 * T144-H's identical guard on _vdsenAIShowPreview). On mismatch: show a
 * short d2Status message and return — _vdsenCurrentPreview/_vdsenDraftPlanId
 * are left untouched (not cleared, not mutated), so switching back to
 * client A and clicking the same button again still works normally.
 *
 * Run: node tests/t145h-preview-action-context-guard.test.js
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

const saveDraftFn = extractFunction(COACH, 'window._vdsenSaveDraftClick = async function()');
const activateFn  = extractFunction(COACH, 'window._vdsenActivatePlanClick = async function()');
assert.ok(saveDraftFn, '_vdsenSaveDraftClick must exist');
assert.ok(activateFn, '_vdsenActivatePlanClick must exist');

// ─────────────────────────────────────────────────────────────────────────────
// Fix 1 — _vdsenSaveDraftClick: guard before any Firestore call.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /document\.getElementById\('planClientSelect'\)\?\.value !== _vdsenCurrentPreview\.clientId/.test(saveDraftFn),
  'T145-H: _vdsenSaveDraftClick must compare live #planClientSelect value against _vdsenCurrentPreview.clientId'
);

const saveGuardIdx = saveDraftFn.indexOf("!== _vdsenCurrentPreview.clientId");
const saveFirestoreCallIdx = saveDraftFn.indexOf('_vdsenSaveDraftToFirestore()');
assert.ok(saveGuardIdx !== -1 && saveFirestoreCallIdx !== -1 && saveGuardIdx < saveFirestoreCallIdx,
  'T145-H: the context guard in _vdsenSaveDraftClick must run before _vdsenSaveDraftToFirestore() is ever called');

console.log('_vdsenSaveDraftClick blocks before any Firestore write when context is stale — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2 — _vdsenActivatePlanClick: guard before the confirm dialog / write.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /document\.getElementById\('planClientSelect'\)\?\.value !== clientId/.test(activateFn),
  'T145-H: _vdsenActivatePlanClick must compare live #planClientSelect value against the preview\'s clientId'
);

const actGuardIdx   = activateFn.indexOf("!== clientId");
const actConfirmIdx = activateFn.indexOf('window.confirm(');
const actWriteIdx   = activateFn.indexOf('_vdsenActivatePlanInFirestore(');
assert.ok(actGuardIdx !== -1 && actConfirmIdx !== -1 && actGuardIdx < actConfirmIdx,
  'T145-H: the context guard in _vdsenActivatePlanClick must run before the confirm() dialog');
assert.ok(actGuardIdx < actWriteIdx,
  'T145-H: the context guard in _vdsenActivatePlanClick must run before _vdsenActivatePlanInFirestore()');

console.log('_vdsenActivatePlanClick blocks before confirm()/Firestore write when context is stale — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guards — normal (matching-context) flow untouched: existing
// prerequisite checks, draft/activate Firestore helpers, confirm dialog,
// and the two-step Guardar/Activar separation all remain exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  saveDraftFn.indexOf('if (!_vdsenCurrentPreview)') < saveDraftFn.indexOf("!== _vdsenCurrentPreview.clientId"),
  'T145-H regression: the pre-existing "no active preview" check must still run before the new context guard'
);
assert.ok(
  activateFn.indexOf('if (!_vdsenCurrentPreview || !_vdsenDraftPlanId) return;') < activateFn.indexOf("!== clientId"),
  'T145-H regression: the pre-existing "no preview/draft" check must still run before the new context guard'
);
assert.ok(
  activateFn.includes("'¿Activar plan para este cliente?"),
  'T145-H regression: the activation confirm() dialog text must be unchanged'
);
assert.ok(
  COACH.includes('window._vdsenSaveDraftClick') && COACH.includes('window._vdsenActivatePlanClick'),
  'T145-H regression: Guardar borrador and Activar plan remain two distinct, separate actions'
);

console.log('Matching-context flow (existing checks, confirm dialog, two-step separation) unchanged — OK');

console.log('');
console.log('T145-H — preview action context guard: ALL ASSERTIONS PASSED');
