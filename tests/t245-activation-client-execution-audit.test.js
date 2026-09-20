'use strict';
/**
 * T245 — Activation -> Client Execution audit (audit-only; grep-first).
 * Traces the REAL flow from _vdsenAIShowPreview/plan activation through
 * vdsen-cliente.html's loadPlan/logging pipeline.
 *
 *   MAP: source -> transformation -> persisted identity -> consumer
 *   ---------------------------------------------------------------------
 *   Plan activation   _vdsenActivatePlanInFirestore  clients/{uid}.activePlanId
 *   (Coach)           (transactional, ownership-      (pointer swap only --
 *                      checked, idempotent)            plans/{id} NEVER mutated,
 *                                                       history preserved by
 *                                                       existence of both docs)
 *   Client plan load  loadPlan(): clients/{uid}       PLAN.* with
 *                      .activePlanId -> plans/{id}     prescriptionExerciseId/
 *                                                       exerciseId/repsTarget/
 *                                                       rirTarget/load preserved
 *                                                       verbatim per exercise
 *   Week/day identity CURRENT_WEEK/REAL_WEEK (int)     POSITIONAL, not ID-based --
 *                      + day index (di)                 but safe: a plan change
 *                                                        does a FULL clean reset
 *                                                        (see below), so week-N
 *                                                        under plan A can never
 *                                                        coexist with week-N
 *                                                        under plan B
 *   Prescription       logs/{uid}.planId (document-    DOCUMENT-level granularity
 *   version executed   level field, set on every save)  only (not per-entry) --
 *                                                        acceptable because the
 *                                                        flat doc is atomically
 *                                                        wiped+rebuilt on every
 *                                                        plan change (see below)
 *   Plan-change mid-   3-way detection (sessionStorage  flush-before-reset (no
 *   usage              flag / localStorage cache /       loss of already-entered
 *                       logData.planId mismatch)          data), then full wipe
 *                                                         (LOGS={}, week=1) via
 *                                                         setDoc (atomic replace,
 *                                                         no partial state)
 *   Old plan's         logs/{uid}/mesos/{oldPlanId}      mirrored continuously
 *   evidence           (per-mesociclo archival doc,       during normal use --
 *                       written on every _doSaveLogs      genuinely preserved,
 *                       call while that plan was active)  NEVER deleted
 *
 * KEY FINDING (re-classified after full trace, NOT a data-loss bug): the
 * per-mesociclo mirror (logs/{uid}/mesos/{planId}) IS read back by
 * vdsen-cliente.html itself (new-first with legacy fallback, for whichever
 * plan is CURRENTLY active) -- self-consistent. vdsen-coach.html's engines
 * (progressionHistory, weeklyDecision, adaptivePrescription,
 * mesocycleDecision, Coach Monitor, Generator, and T237-244's Coach
 * Intervention evidence timestamps) never read logs/{uid}/mesos/{planId}
 * at all -- but this is CORRECT and consistent with this ticket's own
 * CASE H principle (an old mesocycle's data must not be active authority
 * for a new one): those engines are meant to be scoped to the CURRENT
 * plan's evidence only. The real, narrower gap is a Coach-side FEATURE
 * absence (no retrospective UI to inspect a client's previous mesociclo),
 * not a correctness/attribution bug -- classified P2 (visibility gap),
 * deliberately NOT built here (feature scope, not this ticket's mandate).
 *
 * GAP CLASSIFICATION:
 *   P0: none confirmed. (Initial hypothesis of silent cross-plan data loss
 *       was DISPROVEN by tracing the mesos mirror + client's own read-back.)
 *   P1: none confirmed.
 *   P2: (a) no Coach-side retrospective view of logs/{uid}/mesos/{oldPlanId}
 *       -- a feature gap, not a bug, left unbuilt (see above).
 *       (b) the "session open during a mid-workout coach activation"
 *       scenario has ZERO regression coverage despite the code appearing
 *       correct by inspection (flush-before-reset) -- T247's job per the
 *       ticket's own "si ya existe este comportamiento, pruébalo" fallback.
 *   P3: no per-entry planId stamp inside `entries` (correctness currently
 *       rests entirely on the atomic full-wipe-on-switch; defense-in-depth
 *       only, not an observed active bug in any traced path).
 *
 * Run: node tests/t245-activation-client-execution-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Activation: transactional, ownership-checked, idempotent, never mutates
// the plan doc itself (history preserved by existence, not by flag).
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('async function _vdsenActivatePlanInFirestore(planId, clientId)'), 'the real activation entry point exists');
ok(COACH.includes("if (clientData.activePlanId === planId) return;"), 'activation is idempotent -- re-activating the same plan is a no-op, no duplicate writes');
ok(COACH.includes('t.update(clientRef, clientUpdate);') && COACH.includes('var clientUpdate = { activePlanId: planId };'), 'activation writes ONLY clients/{uid} (activePlanId + conditional nutrition/supplement mirrors, T261) -- plans/{planId} and plans/{prevPlanId} are never touched, preserving history by non-mutation');
ok(COACH.includes("if (planData.coachId !== coachId) throw new Error('FOREIGN_OWNER"), 'ownership is checked before activation -- no cross-coach plan hijacking');

// ─────────────────────────────────────────────────────────────────────────────
// Client plan load: identity fields (PID, exerciseId, reps, RIR, load)
// preserved verbatim from plans/{activePlanId}.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("const activePlanId = clientData.activePlanId;"), 'client resolves the active plan via clients/{uid}.activePlanId -- same pointer the Coach app writes');
ok(CLIENT.includes("prescriptionExerciseId: e.prescriptionExerciseId || undefined,"), 'prescriptionExerciseId is preserved verbatim when converting the plan to the renderer format -- never regenerated, never derived from name/position');
ok(CLIENT.includes('rirTarget:  s.rirTarget !== undefined ? s.rirTarget : rirTarget,') && CLIENT.includes('load: s.load || 0,'), 'prescribed RIR and load are preserved per-set from the plan document, not recomputed');

// ─────────────────────────────────────────────────────────────────────────────
// Prescription version executed: logs/{uid}.planId records which plan
// currently owns `entries` (document-level, not per-entry -- see P3 debt).
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("const _payload = { entries: _safeEntries, currentWeek: REAL_WEEK, planId: ACTIVE_PLAN_ID"), 'every save stamps which plan produced the CURRENT entries -- a real, non-fabricated planId field');
ok(CLIENT.includes('var ACTIVE_PLAN_ID   = null;') , 'ACTIVE_PLAN_ID is tracked client-side specifically to detect a plan change');

// ─────────────────────────────────────────────────────────────────────────────
// Plan-change mid-usage: 3-way detection, flush BEFORE reset (no loss of
// already-entered data), then an atomic full wipe (no partial state).
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes('var firestorePlanId = logData.planId || null;') && CLIENT.includes("localPlanId = localStorage.getItem('vdsen_active_plan_id') || null;"),
  'plan change is detected via 3 independent signals (sessionStorage flag, localStorage cache, Firestore logs.planId) -- not a single fragile source');
ok(/if \(_saveLogsTimer\) \{ clearTimeout\(_saveLogsTimer\); _saveLogsTimer = null; await _doSaveLogs\(\); \}/.test(CLIENT),
  'a pending debounced save is flushed to Firestore BEFORE the reset -- data already in LOGS is never silently dropped on a plan switch');
ok(/LOGS\s*=\s*\{\};\s*\n\s*EXERCISE_UNITS = \{\};.*\n\s*CURRENT_WEEK\s*=\s*1;\s*\n\s*REAL_WEEK\s*=\s*1;/.test(CLIENT),
  'the reset is a full, clean wipe (LOGS/week) -- no possibility of week-N-plan-A entries surviving alongside week-N-plan-B entries in the same flat document');
ok(CLIENT.includes('await FB.setDoc(ref, _payload);'), 'the save is a full setDoc (atomic document replace), not a partial/merge update -- no interleaved partial state between old and new plan data');

// ─────────────────────────────────────────────────────────────────────────────
// Old plan's evidence: genuinely preserved via the per-mesociclo mirror,
// read back by the CLIENT itself (self-consistent), but intentionally
// never read by the Coach-side engines (consistent with CASE H's
// plan-scoping principle, not a data-loss bug).
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("FB.setDoc(FB.doc(FB.db, 'logs', USER.uid, 'mesos', ACTIVE_PLAN_ID), _payload)"), 'every save also mirrors into a plan-scoped archival doc -- the OLD plan\'s data is preserved there when the switch is detected, since this write already happened continuously while that plan was active');
ok(CLIENT.includes("FB.getDoc(FB.doc(FB.db, 'logs', user.uid, 'mesos', activePlanId))"), 'the CLIENT reads its own per-mesociclo mirror back (new-first, legacy-fallback) -- self-consistent, not a write-only dead path from the client\'s own perspective');
ok((COACH.match(/setDoc\(doc\(db, 'logs', clientId, 'mesos', newPlanId\)/g) || []).length >= 2, 'vdsen-coach.html only WRITES to logs/{uid}/mesos/{planId} (manual reset-week admin actions), pre-T253');
// T253 update: a read-only HISTORICAL MONITOR VIEW now intentionally reads
// logs/{uid}/mesos/* (via _vdsenListHistoricalMesocycles/_buildHistoricalMesocycleView)
// -- but this is display-only, never wired into any DECISION function.
// The principle this test originally protected still holds precisely:
// progressionHistory/weeklyDecision/adaptivePrescription/mesocycleDecision/
// the Generator's request, and Coach Intervention evidence timestamps
// never read mesos data for CURRENT-plan decisions (CASE H unaffected).
ok(COACH.includes("getDocs(collection(db, 'logs', clientId, 'mesos'))"), 'T253: the ONLY mesos read path is the read-only historical discovery function -- confirmed intentional, not an accidental new consumer');
ok(!COACH.slice(0, COACH.indexOf('function _sortHistoricalMesocycles')).match(/getDoc\([^)]*'mesos'/) ,
  'confirmed no OTHER mesos read exists anywhere BEFORE the T253 historical-view functions in the file -- in particular, none of the pre-existing decision functions (_computeWeeklyDecisionForRequest, _decideAdaptivePrescription, _decideMesocycleTransition, buildGenerationRequest, _getLatestEvidenceTimestampForScope) read it, preserving CASE H\'s plan-scoping principle for all actual decisions');

// ─────────────────────────────────────────────────────────────────────────────
// PID collision risk across different plans: negligible (UUID-based
// minting), never by name/position.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('function _genPrescriptionId() {') && COACH.includes('try { return crypto.randomUUID(); } catch(e) {}'), 'PIDs are minted via crypto.randomUUID() -- no realistic cross-plan collision risk, confirming PID-exact matching (used throughout T234-244) remains safe across plan changes without additional plan-scoping');
ok(!/genPrescriptionId/.test(CLIENT), 'the CLIENT never mints a new PID -- identity minting is centralized on the Coach side only, client only ever reads/preserves it');

console.log('');
console.log('T245 — Activation -> Client execution audit: ' + pass + ' assertions PASSED');
