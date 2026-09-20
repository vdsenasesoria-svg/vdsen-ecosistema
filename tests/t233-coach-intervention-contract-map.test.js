'use strict';
/**
 * T233 — Coach intervention contract map (audit-only; grep-first per
 * Efficiency Rules). Every existing place the Coach already writes a
 * decision, and whether a usable decision/provenance field already exists.
 *
 *   ACTION                    WRITER                 DOCUMENT              TIMESTAMP FIELD          IDENTITY SCOPE          CURRENT STALE EFFECT                      CURRENT DOWNSTREAM READERS
 *   ------------------------  ---------------------  --------------------  -----------------------  ----------------------  -----------------------------------------  --------------------------------------------
 *   Plan edit (saveTrainingPlan, saveImportedPlan,   plans/{planId}        updatedAt (ISO string)   whole PLAN (no per-PID  weeklyDecision/mesocycleDecision's own      _computeWeeklyDecisionForRequest,
 *   week/RIR bulk edits)      Coach (manual editor)                                                  granularity -- coarse)  editStale check: planDoc.updatedAt >         Coach Monitor T163/165/170/181/197
 *                                                                                                                             rec.calculatedAt -> COACH_REVIEW
 *   Plan activation           Coach (create/assign)  clients/{uid}          (none dedicated --       whole CLIENT            None -- activePlanId change is itself the  loadClientList, buildGenerationRequest
 *                             or Generator                                  activePlanId change only) activePlanId swap        signal a NEW plan exists
 *   Exercise substitution     Coach (plan editor) or  plans/{planId}.days[].exercises[].              per-EXERCISE (PID)      _stampPrescriptionIds (T159-166): a         progressionHistory (T160/166) --
 *   (new/changed PID)         Generator (T164 rule)   prescriptionExerciseId                                                  genuinely NEW PID starts with EMPTY         confirmed correct, no same-name inheritance
 *                                                                                                                             history by construction (no code needed)
 *   Progression override      NONE FOUND -- the Coach  N/A                  N/A                      N/A                      N/A                                          N/A
 *   (accept/reject a          currently has no UI
 *   calculateProgression      action to explicitly
 *   recommendation)           accept/reject a specific
 *                             progrec_ recommendation
 *   Pre-save AI-response      _vdsenReviewState        IN-MEMORY ONLY --    N/A (never persisted)    per generation-preview   Purely a client-side toggle for reviewing   None -- entirely local to the preview modal,
 *   review (accept/adjust/    (window._vdsenReviewAction) not written to                              flag/idx, NOT Monitor    AI-generated flags BEFORE a plan is even    unrelated scope to Monitor supervision
 *   reject a generation-      D.2.1                    Firestore at all                              supervision scope        saved -- resets on reload, not a durable
 *   preview flag/warning)                                                                                                     intervention record
 *
 * KEY FINDING: no usable persisted Coach-decision/provenance record exists
 * anywhere in the codebase today for the Monitor-supervision scope this
 * ticket covers. The two closest analogs are (a) plans/{planId}.updatedAt
 * (coarse, whole-plan, no action/reason/scope metadata) and (b)
 * _vdsenReviewState (in-memory only, different scope entirely -- pre-save
 * AI flag review, not post-activation Monitor supervision). T234 therefore
 * introduces ONE new additive array field, clients/{uid}.coachInterventions[],
 * modeled EXACTLY on the already-existing clients/{uid}.inbodyResults[]
 * array pattern (same document, append-only, {..., ts} records, sorted/
 * filtered by recency) -- no new collection, no structural schema
 * decision, per the Persistence Rule.
 *
 * Run: node tests/t233-coach-intervention-contract-map.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// The map's own claims, verified against real code.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("await updateDoc(doc(db, 'plans', planId), {"), 'confirmed plan edits write updatedAt to plans/{planId} -- the existing coarse staleness signal');
ok((COACH.match(/updatedAt: new Date\(\)\.toISOString\(\)/g) || []).length >= 3, 'confirmed multiple plan-edit call sites stamp updatedAt the same way (consistent existing convention)');

ok(COACH.includes('const prescriptionExerciseId = row.dataset.prescriptionId || _genPrescriptionId();'), 'confirmed exercise substitution/edit preserves or generates prescriptionExerciseId per exercise -- the existing PID-first identity mechanism');

ok(COACH.includes('window._vdsenReviewAction = function(requestId, idx, action)'), 'confirmed the ONLY existing "review action" UI pattern (_vdsenReviewAction) is for pre-save AI-response flags');
ok(COACH.includes('_vdsenReviewState[requestId][idx] = action;'), 'confirmed _vdsenReviewState is a plain in-memory object toggle');
ok(!/setDoc\([^)]*_vdsenReviewState/.test(COACH) && !/updateDoc\([^)]*_vdsenReviewState/.test(COACH), 'confirmed _vdsenReviewState is never written to Firestore anywhere');

// KEY FINDING: no existing coachIntervention-shaped field anywhere yet.
ok(!COACH.includes('coachIntervention'), 'KEY FINDING confirmed: no coachIntervention field/concept exists anywhere in vdsen-coach.html yet -- genuinely new ground for T234');

// Confirm the reuse precedent (inbodyResults array pattern) this ticket
// will model the new field on.
ok(COACH.includes('const results = Array.isArray(c.inbodyResults)') && COACH.includes('[...c.inbodyResults].sort((a,b)=>b.ts-a.ts)'),
  'confirmed the append-only, ts-sorted array pattern already established by clients/{uid}.inbodyResults[] -- the precedent T234 reuses for coachInterventions[]');

console.log('');
console.log('T233 — Coach intervention contract map: ' + pass + ' assertions PASSED');
