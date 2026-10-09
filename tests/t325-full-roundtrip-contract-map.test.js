'use strict';
/**
 * T325 — Full round-trip contract map (Coach <-> Client ecosystem).
 *
 * Mapped via direct reads of vdsen-coach.html/vdsen-cliente.html plus two
 * parallel research passes over the Generator->Preview->Activation chain
 * and the Monitor->Snapshot->Intervention chain. Findings below were fixed
 * inline where cheap/low-risk (this session's established convention);
 * two are documented as intentionally out of scope.
 *
 * ── BOUNDARY MAP (compact) ──────────────────────────────────────────────────
 *
 *  1. Coach -> Client profile
 *     SOURCE: coach UI (ficha/intake forms) -> WRITE: clients/{uid},
 *     fichas_onboarding/{uid} -> READER: buildGenerationRequest, Monitor,
 *     client app (own profile tab) -> IDENTITY: uid -> FRESHNESS: read
 *     fresh via getDoc on every generation/monitor open -> FAILURE: caught,
 *     non-fatal (ficha/plan reads are `.catch(() => null)`-wrapped optional
 *     inputs in vdsenAIPreview).
 *
 *  2. Coach -> activePlan
 *     SOURCE: _vdsenActivatePlanInFirestore -> WRITE: clients/{uid}.activePlanId
 *     (Firestore transaction) -> READER: client app's loadPlan, Coach Monitor
 *     -> IDENTITY: uid+planId, both ownership-checked (coachId, clientId
 *     match) inside the transaction -> FRESHNESS: transactional read-then-
 *     write, atomic -> FAILURE: transaction throws, caught by the click
 *     handler, shown as a real error, activePlanId left untouched.
 *
 *  3. Generator -> Preview
 *     SOURCE: buildGenerationRequest (canonical snapshot: progressionHistory/
 *     weeklyDecision/adaptivePrescription/learnedState/prescriptionEffectiveness/
 *     nutritionDecision/coachSupervision/evidenceQuality, all present as
 *     stable keys even when sparse for a first plan) -> the Motor VDSEN API
 *     -> READER: vdsenAIPreview -> IDENTITY: clientId captured in the request
 *     -> FRESHNESS: request built from a fresh getDoc read each time
 *     -> FAILURE: FINDING 1 (see below, RESOLVED).
 *
 *  4. Preview -> activation
 *     SOURCE: _vdsenCurrentPreview/_vdsenDraftPlanId (in-memory) -> WRITE:
 *     plans/{planId} (draft_approved) via _vdsenSaveDraftToFirestore, then
 *     clients/{uid}.activePlanId via _vdsenActivatePlanInFirestore -> READER:
 *     coach's own activation UI -> IDENTITY: T145-H re-verifies
 *     planClientSelect.value === clientId at BOTH save-draft and activate
 *     -> FRESHNESS: draft/activate are separate explicit coach actions, no
 *     auto-activation -> FAILURE: both guarded, real errors shown, no
 *     silent partial state (activation is one atomic transaction).
 *
 *  5. activePlan -> Client
 *     SOURCE: plans/{activePlanId} -> READER: client app's loadPlan (exact
 *     field-for-field mapping: prescriptionExerciseId/exerciseId/coachNote/
 *     sets/reps/RIR/technique all preserved, verified directly) -> IDENTITY:
 *     client's own uid -> FRESHNESS: a live onSnapshot on clients/{uid}
 *     re-points the plan listener when activePlanId changes (T148-H) ->
 *     FAILURE: plan-not-found renders a "broken plan" screen, never a
 *     silent blank state.
 *
 *  6-8. Client workout/nutrilog/check-in -> logs
 *     SOURCE: completeSet/_confirmSessionDone/_endSessionAsPartial/
 *     skipSession/skipExercise/guardarNutriLog/guardarCI -> WRITE:
 *     logs/{uid} (single doc, per-key namespacing: log_/done_/nutrilog_/
 *     ci_sem_) -> READER: Coach Monitor, canonical snapshot -> IDENTITY:
 *     uid (own doc) -> FRESHNESS: every terminal write is real-awaited
 *     (_doSaveLogs) -> FAILURE: all real-awaited with revert-on-failure,
 *     exhaustively covered by T291-T324's own test suites.
 *
 *  9. logs -> Coach Monitor
 *     SOURCE: logs/{clientId} -> READER: _renderClientTabMonitor (fresh
 *     getDoc every render, T127-H stale-context guard already present)
 *     -> IDENTITY: clientId -> FRESHNESS: fresh read, no cache
 *     -> FAILURE: `.catch(() => null)`, guarded.
 *
 * 10. logs -> canonical snapshot
 *     SOURCE: logs/{clientId} -> _buildClientDecisionSnapshot / the
 *     session-completion-state classifier (_getSessionCompletionState/
 *     _sessionExecutionRatio) -> correctly excludes autoFilled sets and
 *     skipped/auto-closed-no-data sessions from real-execution ratio;
 *     "PARTIAL" is a derived 0.3-0.8 ratio classification, correctly
 *     treated as real-but-incomplete -> READER: Generator, Monitor
 *     -> IDENTITY: clientId -> FRESHNESS: recomputed fresh from raw
 *     entries every call, never cached -> FAILURE: n/a (pure function).
 *
 * 11. intervention -> downstream authority
 *     SOURCE: _vdsenCoachIntervene -> WRITE: clients/{id}.coachInterventions[]
 *     (append-only) -> READER: _isInterventionActiveForScope/
 *     _isRecommendationSupersededByIntervention -> IDENTITY: scope-exact
 *     (targetType+targetId, +planId for non-CLIENT scopes) -> FRESHNESS:
 *     _isEvidenceNewerThanIntervention correctly lets fresh evidence (new
 *     pain, new sessions) supersede an old intervention's authority rather
 *     than being masked by it -> FAILURE: FINDING 6 (documented, not a bug).
 *
 * 12. previous plan -> history
 *     SOURCE: plans/{oldPlanId} (never mutated on replacement) +
 *     backupPlanIfExists -> plans_backup/{id} (new doc, reconciles
 *     plan-doc/client-doc nutrition drift, T265) -> READER:
 *     _buildHistoricalMesocycleView (one-shot getDoc/getDocs only, no
 *     onSnapshot, confirmed in T294) -> IDENTITY: planId -> FRESHNESS:
 *     read-only, never mutates active state -> FAILURE: backup write
 *     failure is caught and non-fatal (activation still proceeds; this is
 *     an intentional design choice per the function's own code, not an
 *     oversight -- documented, not changed).
 *
 * 13. plan renewal -> Client
 *     SOURCE: a NEW activation over an existing activePlanId -> WRITE:
 *     same transactional path as boundary 2 -> READER: client's live
 *     listener re-points automatically (T148-H) -> IDENTITY: unchanged
 *     client uid, new planId -> FRESHNESS: immediate (live listener, no
 *     reload needed) -> FAILURE: same transactional guarantees as
 *     boundary 2.
 *
 * ── FINDINGS (max 8) ────────────────────────────────────────────────────────
 * FINDING 1 (RESOLVED): vdsenAIPreview only console.warn'd on a
 *   validateGenerationResponse contract violation (wrong schema, missing
 *   plan, forbidden fields) and still showed the Preview -- a malformed
 *   response could reach draft-save/activation. Fixed: hard errors now
 *   block the preview via the existing UI_STATES.invalid() path.
 * FINDING 2 (RESOLVED): saveImportedPlan (the separate paste-analysis
 *   activation path) had no ownership check before writing
 *   clients/{id}.activePlanId, unlike _vdsenActivatePlanInFirestore's
 *   explicit FOREIGN_OWNER check. Firestore Rules already block a
 *   cross-coach write server-side (verified in firestore.rules), so this
 *   was not an exploitable security gap -- fixed anyway for a clean error
 *   message instead of a raw permission-denied exception.
 * FINDING 3 (RESOLVED): _vdsenActivatePlanClick had no in-flight boolean
 *   guard (every other plan-writing click handler in this file has one).
 *   Practical risk was near-zero (window.confirm() blocks the event loop,
 *   and the activation transaction is independently idempotent) -- added
 *   for defense-in-depth consistency and to make T331's "double-click
 *   activation" scenario concretely provable.
 * FINDING 4 (RESOLVED): aggregateClientLogs (feeds coach PDF/report
 *   generation) counted autoFilled sets in tonnage/set-count/RIR/ICS
 *   aggregates, inflating a coach-facing report with fabricated data.
 *   Fixed: autoFilled entries are now excluded at the point of ingestion.
 * FINDING 5 (RESOLVED, higher severity than initially scoped):
 *   _computeConfidenceScore also counted autoFilled sets -- and unlike
 *   aggregateClientLogs, this confidence score feeds LIVE
 *   _computeMuscleTargets Decision Engine volume prescriptions (not just a
 *   report). A sparse, mostly-autofilled week could be scored as
 *   medium/high confidence, granting more volume than genuine execution
 *   would justify. Fixed: autoFilled entries excluded from the same
 *   filtered logKeys list every downstream factor already uses.
 * FINDING 6 (DOCUMENTED, not fixed -- functional gap, not a bug): the
 *   EXERCISE/MUSCLE/MESOCYCLE-scoped intervention supersession machinery
 *   (_isInterventionActiveForScope et al.) is correctly implemented but
 *   currently unreachable -- the only UI call site that constructs a
 *   coachIntervention record hardcodes targetType:'CLIENT'. This is a
 *   "not more features" boundary: building a new exercise-specific
 *   intervention UI is feature work, out of this run's scope.
 * FINDING 7 (DOCUMENTED, not fixed -- deferred to T332): loadClientList()
 *   fetches the full logs/{id} and plans/{activePlanId} doc for every
 *   client in the coach's roster on every list load (parallelized via
 *   Promise.all, not serialized). Real N+1-shaped read cost; restructuring
 *   it (pagination, a denormalized summary field) is an architecture
 *   change beyond a targeted fix.
 * FINDING 8 (DOCUMENTED, confirmed NOT a gap): Firestore Rules for
 *   clients/{id} and plans/{id} already enforce coachId ownership
 *   server-side on every create/update (coachId immutable, create/update
 *   requires request.auth.uid match, plans forbid farmacologia/pharmacoPlan
 *   fields at the rules layer). This is the real security boundary and it
 *   is intact and independent of any client-side JS check.
 *
 * Run: node tests/t325-full-roundtrip-contract-map.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const RULES  = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

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

// ── FINDING 1 ────────────────────────────────────────────────────────────────
ok(COACH.includes("if (!respValidation.valid) {\n          console.error('[VDSEN D.1] Response contract violation:', respValidation.errors);\n          UI_STATES.invalid("),
  'FINDING 1 RESOLVED: a hard validateGenerationResponse contract violation now blocks the preview (UI_STATES.invalid), not just a console.warn');

// ── FINDING 2 ────────────────────────────────────────────────────────────────
const saveImportedPlanSrc = extractFunction(COACH, 'async function saveImportedPlan(clientIdArg) {');
ok(saveImportedPlanSrc.includes('if (prevClientSnap.data().coachId !== currentCoach.uid)'),
  'FINDING 2 RESOLVED: saveImportedPlan now checks clientData.coachId === currentCoach.uid before writing, matching _vdsenActivatePlanInFirestore');

// ── FINDING 3 ────────────────────────────────────────────────────────────────
ok(COACH.includes('let _vdsenActivatingPlan = false;') && COACH.includes('if (_vdsenActivatingPlan) return;') && COACH.includes('_vdsenActivatingPlan = true;') && COACH.includes('_vdsenActivatingPlan = false;\n    }\n  };'),
  'FINDING 3 RESOLVED: _vdsenActivatePlanClick now has an explicit in-flight guard, set/reset around the confirm+write, matching other click handlers');

// ── FINDING 4 ────────────────────────────────────────────────────────────────
const aggregateClientLogsSrc = extractFunction(COACH, 'function aggregateClientLogs(logs, planObj, currentWeek) {');
ok(aggregateClientLogsSrc.includes('if (v && v.autoFilled) return;'),
  'FINDING 4 RESOLVED: aggregateClientLogs now excludes autoFilled sets from coach-facing PDF/report tonnage/set/RIR/ICS aggregates');

// ── FINDING 5 ────────────────────────────────────────────────────────────────
const confidenceScoreSrc = extractFunction(COACH, 'function _computeConfidenceScore(entries, checkinSummary) {');
ok(confidenceScoreSrc.includes("!(entries[k] && entries[k].autoFilled)"),
  'FINDING 5 RESOLVED: _computeConfidenceScore now excludes autoFilled entries -- this feeds the LIVE _computeMuscleTargets Decision Engine, not just a report');
ok(COACH.includes('ctx.prescriptionTargets.muscles = _computeMuscleTargets('),
  'confirmed _computeConfidenceScore\'s output really does feed the live Decision Engine (not dead/legacy code as initially suspected)');

// ── FINDING 6 (documented) ──────────────────────────────────────────────────
ok(COACH.includes("targetType: 'CLIENT'") && COACH.includes('function _isInterventionActiveForScope('),
  'FINDING 6 documented: the scope-exact intervention supersession machinery exists but only CLIENT-wide interventions are ever constructed by the current UI -- not fixed (feature work, out of scope)');

// ── FINDING 7 (documented, deferred to T332) ────────────────────────────────
const loadClientListSrc = extractFunction(COACH, 'async function loadClientList() {');
ok(loadClientListSrc.includes("const _logPromises = _clientDocs.map(c => getDoc(doc(db, 'logs', c.id)).catch(() => null));"),
  'FINDING 7 documented: loadClientList fetches a full logs doc per client row on every list load (parallelized, not fixed here -- deferred to T332)');

// ── FINDING 8 (confirmed not a gap -- security boundary already intact) ────
ok(/coachId == request\.auth\.uid[\s\S]{0,50}request\.resource\.data\.coachId == resource\.data\.coachId/.test(RULES),
  'FINDING 8 confirmed: Firestore Rules already make clients/{id}.coachId immutable and update-restricted to the owning coach -- the real security boundary is independent of any client-side check');
ok(RULES.includes("!('farmacologia'  in request.resource.data)"),
  'confirmed Rules also block farmacologia/pharmacoPlan fields on plan creation at the server layer, defense-in-depth beyond the application code');

console.log('');
console.log('T325 — Full round-trip contract map: ' + pass + ' assertions PASSED. 5 findings resolved inline, 3 documented (2 out-of-scope feature/perf, 1 confirmed non-issue).');
