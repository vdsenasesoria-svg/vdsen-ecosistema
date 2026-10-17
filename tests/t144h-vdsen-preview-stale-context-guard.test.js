'use strict';
/**
 * T144-H — AI generation request lifecycle: stale-context guard for the
 * Preview flow's slow (2-3 min) response.
 *
 * Scope per T144: autoGeneratePlan(), vdsenAIPreview(), the /api/vdsen-generate
 * fetch, clientId snapshot, associated buttons/guards.
 *
 * Audit findings:
 *   - clientId is captured once from #planClientSelect at the top of both
 *     autoGeneratePlan() and vdsenAIPreview(), and used consistently through
 *     to every downstream write/render — no stale-client Firestore write in
 *     either function (writes always target the originally-selected client).
 *   - Both functions' finally blocks unconditionally restore their button's
 *     disabled/text state — no stuck loading/guard in either function,
 *     regardless of success, failure, or a stale response.
 *   - autoGeneratePlan()'s "still applies its result while stale" exposure is
 *     low severity: its status/PDF/notify buttons render into the in-flow
 *     #autoGenStatus div (hidden by section CSS if the coach navigated away,
 *     and the embedded buttons still carry the correct original clientId in
 *     their onclick) — not a data-integrity or wrong-client-action bug.
 *   - vdsenAIPreview() had a real bug: on the VALID / NEEDS_COACH_REVIEW
 *     response paths, it unconditionally calls _vdsenAIShowPreview(), which
 *     force-displays vdsenPreviewModal — a `position:fixed;inset:0;z-index:2000`
 *     full-screen overlay covering the ENTIRE page, not scoped to any section.
 *     Since the request can take 2-3 minutes (per the button's own caption),
 *     a coach who changes #planClientSelect to a different client (or
 *     navigates to a completely different section) while waiting would have
 *     this stale generation's preview modal pop up over whatever they're
 *     doing now, and _vdsenCurrentPreview would be overwritten with the
 *     stale client's data — reachable by the "Guardar borrador aprobado" /
 *     "Activar plan" D.2 actions if the coach doesn't notice the mismatch.
 *
 * Fix: before either _vdsenAIShowPreview() call site, compare the live
 * #planClientSelect value against the snapshotted clientId (the same
 * snapshot/compare pattern already used throughout this file, e.g.
 * _clientIdSnap !== _detailClientId in T118-H/T123-H/T127-H). If the coach
 * has since selected a different client, skip popping the modal and show a
 * toast instead — _vdsenCurrentPreview is never set to the stale response,
 * so no stale AI result is ever reachable by the Guardar-borrador/Activar
 * actions. No AbortController needed: the fetch still completes normally
 * (no wasted-resources concern beyond what already existed), only the
 * disruptive UI side-effect is gated.
 *
 * Run: node tests/t144h-vdsen-preview-stale-context-guard.test.js
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

const previewFn = extractFunction(COACH, 'async function vdsenAIPreview()');
assert.ok(previewFn, 'vdsenAIPreview must exist');

// ─────────────────────────────────────────────────────────────────────────────
// Fix: both _vdsenAIShowPreview call sites must be guarded by a live
// #planClientSelect comparison against the snapshotted clientId.
// ─────────────────────────────────────────────────────────────────────────────

const showPreviewCallCount = (previewFn.match(/_vdsenAIShowPreview\(respJson, request, clientId\)/g) || []).length;
assert.strictEqual(showPreviewCallCount, 2, 'T144-H prerequisite: exactly 2 _vdsenAIShowPreview call sites (VALID and NEEDS_COACH_REVIEW)');

const guardCount = (previewFn.match(/document\.getElementById\('planClientSelect'\)\?\.value !== clientId/g) || []).length;
assert.strictEqual(guardCount, 2, 'T144-H: both _vdsenAIShowPreview call sites must be preceded by the stale-context guard');

// Each _vdsenAIShowPreview call must be reachable only from inside the
// non-stale branch (i.e., the guard's else-branch or after an early return
// for the stale case) — verify by checking the guard textually precedes each
// call within a bounded window (same status-branch block).
const chunks = previewFn.split('_vdsenAIShowPreview(respJson, request, clientId)');
assert.strictEqual(chunks.length, 3, 'T144-H prerequisite: split must produce 3 chunks around the 2 call sites');
for (let i = 0; i < 2; i++) {
  const precedingText = chunks[i].slice(-450);
  assert.ok(
    precedingText.includes("planClientSelect')?.value !== clientId"),
    'T144-H: the stale-context guard must appear immediately before _vdsenAIShowPreview call #' + (i + 1)
  );
}

console.log('Both _vdsenAIShowPreview call sites are guarded against stale client context — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guards — clientId snapshot unchanged, finally still restores
// button state unconditionally, autoGeneratePlan's own T143-H guard intact,
// no endpoint/prompt/model changed, no AbortController introduced.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /const clientId = document\.getElementById\('planClientSelect'\)\?\.value;/.test(previewFn),
  'T144-H regression: vdsenAIPreview must still capture clientId once at entry'
);
assert.ok(
  /finally\s*\{[\s\S]*?btn2\.disabled = false;[\s\S]*?\}/.test(previewFn),
  'T144-H regression: vdsenAIPreview finally must still unconditionally restore vdsenPreviewBtn'
);
assert.ok(
  previewFn.includes("fetch('/api/vdsen-generate'"),
  'T144-H regression: vdsenAIPreview must still call the same /api/vdsen-generate endpoint'
);
// (vdsenAIPreview already used a pre-existing AbortController for its own
// fetch timeout before this fix — this change adds no new cancellation
// mechanism, just a render-time context check.)

const autoGenFn = extractFunction(COACH, 'async function autoGeneratePlan()');
assert.ok(autoGenFn, 'autoGeneratePlan must exist');
assert.ok(
  /if\s*\(\s*_autoGenInFlight\s*\)\s*return;/.test(autoGenFn),
  'T144-H regression: autoGeneratePlan must still have its T143-H re-entrancy guard'
);
assert.ok(
  /const clientId = document\.getElementById\('planClientSelect'\)\.value;/.test(autoGenFn),
  'T144-H regression: autoGeneratePlan must still capture clientId once at entry'
);

console.log('clientId snapshot, finally restoration, endpoint and T143-H guard all unchanged — OK');

console.log('');
console.log('T144-H — AI generation request lifecycle: ALL ASSERTIONS PASSED');
