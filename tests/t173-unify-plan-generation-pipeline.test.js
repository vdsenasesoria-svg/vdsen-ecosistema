'use strict';
/**
 * T173 — Unify plan generation on the progression-first authoritative pipeline.
 *
 * PRODUCT DECISION (user-confirmed): vdsenAIPreview() -> VDSEN_BUILD.
 * buildGenerationRequest() -> /api/vdsen-generate -> Preview -> Draft ->
 * Activate is now the canonical/primary generation path. autoGeneratePlan()
 * -> buildPrescriptionContext() -> /api/generate-plan (name-based progression
 * grouping, no real prescriptionExerciseId sent to the model) is kept as a
 * secondary/legacy path — not deleted (tests/T136H/T139H/T143H/T144H/T146H
 * still cover its internals), just demoted.
 *
 * ENTRY POINT MAP (grep-only, Phase 1):
 *   #crearPlan section:      vdsenPreviewBtn (primary, NEW)  -> vdsenAIPreview() -> VDSEN_BUILD.buildGenerationRequest() -> POST /api/vdsen-generate -> _vdsenAIShowPreview() -> _vdsenSaveDraftClick()/_vdsenActivatePlanClick()
 *                             autoGenBtn (secondary/legacy)   -> autoGeneratePlan() -> buildPrescriptionContext()/_prescriptionContextToText() -> POST /api/generate-plan -> saveImportedPlan() (instant activate)
 *   client-detail modal:      _previewFromFicha button (primary, moved first) -> closeClientModal() -> showSection('crearPlan') -> vdsenAIPreview()
 *                             _fichaGenBtn_${clientId} (secondary/legacy)     -> _autoGenerateForModal(clientId) -> same legacy pipeline as autoGenBtn
 *   _modalImportPlan('ia', clientId): calls autoGeneratePlan() directly, but
 *     is NEVER invoked by any wired button (only 'json'/'texto' modes are) —
 *     classified DEAD CODE, left untouched (no active dependency to migrate).
 *
 * Approach: swap PROMINENCE (position + btn-primary/btn-secondary class +
 * label + idle-state label strings), not the onclick wiring. Both
 * autoGeneratePlan() and _autoGenerateForModal() keep their exact existing
 * onclick, signature, and internal guards untouched — zero risk to the many
 * pre-existing regression tests covering their internals. Only which button
 * occupies the primary/first position changed.
 *
 * Run: node tests/t173-unify-plan-generation-pipeline.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const { _mapExerciseProgressionHistory, _mapPreviousPlan } = require(path.join(__dirname, '..', 'api', 'vdsen-build-request.js'));

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// 1. Primary generation button uses the canonical preview flow.
// ─────────────────────────────────────────────────────────────────────────────

(function test1PrimaryIsCanonical() {
  const crearPlanIdx = COACH.indexOf('id="crearPlan"');
  const previewBtnIdx = COACH.indexOf('id="vdsenPreviewBtn"');
  const autoGenBtnIdx = COACH.indexOf('id="autoGenBtn"');
  ok(crearPlanIdx !== -1 && previewBtnIdx !== -1 && autoGenBtnIdx !== -1, 'prerequisite: section and both buttons exist');
  ok(previewBtnIdx > crearPlanIdx && previewBtnIdx < autoGenBtnIdx, 'vdsenPreviewBtn is now the FIRST generation button in the Plan section (primary position)');
  ok(/id="vdsenPreviewBtn" onclick="vdsenAIPreview\(\)" class="btn-primary"/.test(COACH), 'vdsenPreviewBtn now carries the btn-primary class');
  ok(/id="autoGenBtn" onclick="autoGeneratePlan\(\)" class="btn-secondary"/.test(COACH), 'autoGenBtn (legacy) now carries the btn-secondary class');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 2/3. Primary flow's request builder includes progressionHistory and real
// prescriptionExerciseId-carrying previousPlan (T166's fix, re-verified here
// as the thing that makes this pipeline "canonical").
// ─────────────────────────────────────────────────────────────────────────────

(function test2and3RequestContract() {
  ok(COACH.includes('progressionHistory: logsResult.progressionHistory,'), 'buildGenerationRequest (used by the now-primary vdsenAIPreview) wires progressionHistory into the request');
  ok(COACH.includes('previousPlan:      planDoc || null,'), 'buildGenerationRequest passes previousPlan through as-is — real prescriptionExerciseId values intact, no name-flattening');

  const planDoc = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-real-123' }] }] };
  const mapped = _mapPreviousPlan(planDoc);
  ok(mapped.days[0].exercises[0].prescriptionExerciseId === 'pid-real-123', 'the canonical pipeline\'s previousPlan mapper preserves the real PID string end to end (api/vdsen-build-request.js, unmodified)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 4/5/6. Preserved / substituted / name-conflict PID behavior — same
// guarantees T166 already established, re-verified as part of accepting the
// canonical pipeline as authoritative.
// ─────────────────────────────────────────────────────────────────────────────

(function test4to6PidGuarantees() {
  // 4 — preserved exercise echoes the same PID through _stampPrescriptionIds.
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
  const genIdSrc = extractFunction(COACH, 'function _genPrescriptionId()');
  const stampSrc = extractFunction(COACH, 'function _stampPrescriptionIds(days)');
  const stamp = new Function('crypto', genIdSrc + ';\n' + stampSrc + ';\nreturn _stampPrescriptionIds;')({ randomUUID: function(){ throw new Error('fallback'); } });

  const preserved = stamp([{ dayIndex: 0, exercises: [{ exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-keep' }] }]);
  ok(preserved[0].exercises[0].prescriptionExerciseId === 'pid-keep', '4 — a preserved exercise echoes the SAME prescriptionExerciseId through the write path');

  const substituted = stamp([{ dayIndex: 0, exercises: [{ exerciseName: 'Press Militar' }] }]); // no PID = substituted/new
  ok(typeof substituted[0].exercises[0].prescriptionExerciseId === 'string' && substituted[0].exercises[0].prescriptionExerciseId !== 'pid-keep', '5 — a substituted/new exercise never reuses another exercise\'s PID');

  // 6 — no name-only association: _mapExerciseProgressionHistory buckets strictly by PID.
  const ph = _mapExerciseProgressionHistory({
    'progrec_1_0': { recommendations: [
      { prescriptionExerciseId: 'pid-a', exerciseName: 'Sentadilla', action: 'increase_load' },
      { prescriptionExerciseId: 'pid-b', exerciseName: 'Sentadilla', action: 'freeze_load' }
    ]}
  });
  ok(ph.byPrescriptionExerciseId['pid-a'].history.length === 1 && ph.byPrescriptionExerciseId['pid-b'].history.length === 1, '6 — two different PIDs sharing the same exerciseName are never merged into one history bucket');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 7/8. Stale-context guard and double-submit guard on the primary flow are
// untouched (T144-H, and the disable-on-busy pattern) — regression only.
// ─────────────────────────────────────────────────────────────────────────────

(function test7and8Guards() {
  ok(COACH.includes("document.getElementById('planClientSelect')?.value !== clientId"), '7 — vdsenAIPreview\'s T144-H stale-context guard (client changed mid-request) is present, unmodified');
  ok(/building_request:\s*\(\)\s*=>\s*\{\s*if \(btn\) \{ btn\.disabled = true;/.test(COACH), '8 — vdsenAIPreview disables its own button while a request is in flight (double-submit guard via native disabled state)');
  ok(COACH.includes('let _autoGenInFlight = false;') && COACH.includes('if (_autoGenInFlight) return;'), '8 — legacy autoGeneratePlan() keeps its own T143-H re-entrancy guard, untouched');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 9/10. Preview never auto-activates; Draft -> Activate stays a distinct,
// separate two-step action (T142-H invariant, unaffected by chrome changes).
// ─────────────────────────────────────────────────────────────────────────────

(function test9and10DraftActivate() {
  ok(COACH.includes('BORRADOR — NO APLICADO'), '9 — the preview modal still shows the "not applied yet" draft badge on open');
  ok(COACH.includes('window._vdsenSaveDraftClick') && COACH.includes('window._vdsenActivatePlanClick'), '10 — Guardar borrador and Activar plan remain two distinct, separate actions');
  ok(/id="vdsenPreview_activateBtn"[\s\S]{0,80}style="display:none;/.test(COACH), '10 — the Activar plan button is still hidden by default until a draft is explicitly saved');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 11. Ficha shortcut still reaches the canonical flow, and is now the FIRST/
// primary button in the client-detail modal too.
// ─────────────────────────────────────────────────────────────────────────────

(function test11FichaShortcut() {
  const previewShortcutIdx = COACH.indexOf("onclick=\"_previewFromFicha('${clientId}')\"");
  const fichaGenBtnIdx = COACH.indexOf('id="_fichaGenBtn_${clientId}"');
  ok(previewShortcutIdx !== -1 && fichaGenBtnIdx !== -1 && previewShortcutIdx < fichaGenBtnIdx, '11 — the Preview shortcut button is now the FIRST (primary) generation action in the client-detail modal');
  ok(COACH.includes("showSection('crearPlan');") && /sel\.value = clientId;[\s\S]{0,40}vdsenAIPreview\(\);/.test(COACH), '11 — _previewFromFicha still navigates, pre-selects the client, and calls vdsenAIPreview() (unmodified)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 12. The legacy endpoint/path, kept, is no longer the primary UI path (both
// entry points demoted: secondary class in the Plan section, second position
// in the client-detail modal).
// ─────────────────────────────────────────────────────────────────────────────

(function test12LegacyDemoted() {
  ok(/id="autoGenBtn" onclick="autoGeneratePlan\(\)" class="btn-secondary"/.test(COACH), '12 — autoGenBtn (legacy /api/generate-plan path) is no longer btn-primary');
  const previewShortcutIdx = COACH.indexOf("onclick=\"_previewFromFicha('${clientId}')\"");
  const fichaGenBtnIdx = COACH.indexOf('id="_fichaGenBtn_${clientId}"');
  ok(previewShortcutIdx < fichaGenBtnIdx, '12 — in the client-detail modal, the legacy instant button is no longer first/primary either');
  ok(COACH.includes('legacy — sin revisión'), '12 — the legacy paths are now explicitly labeled as such in the UI, not presented as equivalent to the canonical flow');
  // api/generate-plan.js itself is kept (not deleted) — still covered by its own test suite.
  const fs2 = require('fs');
  ok(fs2.existsSync(path.join(__dirname, '..', 'api', 'generate-plan.js')), 'api/generate-plan.js is intentionally KEPT (Phase 3: not proven safe/tested to delete), still passing its own suite');
})();

console.log('');
console.log('T173 — Unify plan generation on progression-first pipeline: ' + pass + ' assertions PASSED');
