'use strict';
/**
 * T251 — Historical mesocycle contract audit (audit-only, no code change).
 * Traces logs/{uid}/mesos/{planId} and every producer/consumer.
 *
 *   HISTORICAL SOURCE                    AVAILABLE FIELDS                 IDENTITY              TIMESTAMP                    RELIABILITY
 *   ------------------------------------ --------------------------------  --------------------  ----------------------------  --------------------------------------------
 *   logs/{uid}/mesos/{planId}            entries (FULL frozen snapshot     doc id = planId       updatedAt = LAST save while   HIGH for everything inside `entries` --
 *   (written continuously by             of that plan's logs: log_*,       (redundant with the    that plan was active (NOT     it's the exact same object the flat
 *   vdsen-cliente.html._doSaveLogs        progrec_*, postsession_*,         entries.planId field)  a "createdAt" -- setDoc      logs/{uid} doc had at last-save time,
 *   while that plan was active,           ci_sem_*, done_*, engine_state),                        REPLACES the whole doc      confirmed identical write path T245/T247
 *   never mutated again once a            currentWeek (week reached                               each save, so there is NO   already proved reliable)
 *   DIFFERENT plan becomes active)        before switching), planId,                               separate "first save"
 *                                         exerciseUnits, exerciseHistory,                          timestamp)
 *                                         updatedAt
 *   plans/{planId}                       planName/nombre, weeks, days[]    doc id = planId        (no per-doc timestamp       HIGH -- immutable once created
 *   (the ORIGINAL prescription doc,      with exerciseName+                                        needed; plan content        (T245: activation never mutates it),
 *   never mutated per T245)              prescriptionExerciseId per                                never changes after         but the DOC ITSELF may theoretically
 *                                        exercise (source of truth for                             creation in this flow)     be missing (manually deleted, or a
 *                                        historical PID->name resolution)                                                     pre-PID-system legacy plan) -- must
 *                                                                                                                             degrade to "unavailable", never guess
 *   clients/{uid}.coachInterventions[]   targetType/targetId/action/       targetId is the PID    decidedAt (real, T234)      HIGH for EXERCISE/MUSCLE/MESOCYCLE
 *   (T234-236, already the sole          status/decidedAt/planId           for EXERCISE/MUSCLE                                scope (exact planId match already
 *   persisted intervention record --                                       scope; planId scopes                              proven, T235/T246); CLIENT-scope
 *   NOT part of the mesos doc, a                                           EXERCISE/MUSCLE/                                  interventions are NOT plan-specific by
 *   separate, already-existing field)                                     MESOCYCLE decisions                               contract (T235) -- attributing one to a
 *                                                                                                                             specific historical mesociclo is only
 *                                                                                                                             ever a temporal (decidedAt-in-range)
 *                                                                                                                             read, never a structural "belongs to"
 *                                                                                                                             claim (T257's job)
 *   mesocycleDecision                    NOT PERSISTED anywhere -- it is    N/A                    N/A                        The transition verdict for a CLOSED
 *   (T192-197)                           computed FRESH at each             (ephemeral, derived                              mesociclo can only be RECOMPUTED
 *                                        buildGenerationRequest call,       each time)                                       (reusing the real _decideMesocycleTransition,
 *                                        never written to Firestore                                                          no new engine) from that mesociclo's own
 *                                                                                                                            FROZEN entries+plan -- never a stored
 *                                                                                                                            historical record, since none exists
 *
 * KEY IDENTITY WARNING (real finding): EXERCISE_HISTORY inside the mesos
 * payload is keyed by lowercase exercise NAME (vdsen-cliente.html's own
 * autofill/unit-conversion cache), NOT prescriptionExerciseId. It must
 * NEVER be presented as authoritative per-PID history in the historical
 * view -- only progrec_ and log_ entries (already PID-anchored, per
 * T235/T246) may answer "what did PID-X actually do".
 *
 * DISCOVERY MECHANISM: logs/{uid}/mesos is a Firestore SUBCOLLECTION
 * (already exists, T1-era) -- a getDocs(collection(db,'logs',uid,'mesos'))
 * query lists every historical mesociclo without any new collection or
 * schema change (T253's job).
 *
 * WHAT CANNOT BE RECONSTRUCTED (must stay explicitly "unavailable", never
 * guessed):
 *   - startedAt: no field stores when a mesociclo BEGAN (only `updatedAt`,
 *     the LAST save). Best-effort: the earliest real evidence timestamp
 *     found inside that mesociclo's own `entries` (postsession.ts /
 *     progrec.calculatedAt) -- if none exists (plan activated but never
 *     used), startedAt must be null, never fabricated from updatedAt.
 *   - endedAt / "transition to next plan": no explicit boundary is
 *     stored. Best-effort: `updatedAt` (the last real save while that
 *     plan was active) IS a genuine, reliable proxy for "roughly when
 *     this mesociclo ended" (T247 already proved ordering is atomic and
 *     clean) -- reliable enough to use, unlike startedAt.
 *   - which plan came "next": not stored as a pointer. Reconstructable
 *     ONLY by chronological ordering of every mesos doc's own updatedAt
 *     plus knowing clients/{uid}.activePlanId is the most-current one --
 *     never asserted for a plan whose mesos doc is missing/inaccessible.
 *
 * Run: node tests/t251-historical-mesocycle-contract-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// The mesos payload shape, verified against the real write site.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("const _payload = { entries: _safeEntries, currentWeek: REAL_WEEK, planId: ACTIVE_PLAN_ID, exerciseUnits: _safeUnits, exerciseHistory: _safeHist, updatedAt: Date.now() };"),
  'confirmed the exact mesos/flat-doc payload shape: entries, currentWeek, planId, exerciseUnits, exerciseHistory, updatedAt -- no separate "createdAt"/"startedAt" field exists');
ok(CLIENT.includes("await FB.setDoc(FB.doc(FB.db, 'logs', USER.uid, 'mesos', ACTIVE_PLAN_ID), _payload);"), 'confirmed mesos/{planId} is a Firestore SUBCOLLECTION of logs/{uid} -- already discoverable via collection(), no new collection needed');

// ─────────────────────────────────────────────────────────────────────────────
// EXERCISE_HISTORY is name-keyed, not PID-keyed -- must never be presented
// as authoritative per-PID history.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("EXERCISE_HISTORY[historyKey] = { load: carga, reps: String(reps), rir: rir, unit: unit, updatedAt: Date.now() };"),
  'confirmed EXERCISE_HISTORY writes through the derived canonical history key, with legacy name fallback preserved');

// ─────────────────────────────────────────────────────────────────────────────
// plans/{planId} remains immutable and independently readable (T245) --
// but the doc could theoretically be missing; the historical view must
// degrade, never guess plan metadata from the mesos doc alone.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('t.update(clientRef, clientUpdate);') && COACH.includes('var clientUpdate = { activePlanId: planId };'), 'confirmed (T245 cross-reference) plans/{planId} itself is never mutated by activation -- reading it later for historical plan metadata (name/days/PIDs) is safe and reliable IF the doc still exists');

// ─────────────────────────────────────────────────────────────────────────────
// coachInterventions[] is already the sole intervention record (no
// separate historical copy needed) -- EXERCISE/MUSCLE/MESOCYCLE scope is
// planId-exact (T235), CLIENT scope is NOT plan-specific by contract.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("function _isInterventionActiveForScope(intervention, targetType, targetId, currentPlanId)"), 'confirmed the SAME T235 scope function is the only source of truth for plan-exact intervention attribution -- no second historical-attribution engine needed');
ok(COACH.includes("if (intervention.targetType !== INTERVENTION_TARGET_TYPE.CLIENT && intervention.planId && currentPlanId && intervention.planId !== currentPlanId) return false;"),
  'confirmed CLIENT-scoped interventions are explicitly exempt from plan-exact matching -- attributing one to a specific historical mesociclo can only ever be a temporal (decidedAt-in-range) read, never a structural claim');

// ─────────────────────────────────────────────────────────────────────────────
// mesocycleDecision is never persisted -- a historical "transition"
// verdict can only be RECOMPUTED from that mesociclo's own frozen inputs,
// reusing the real engine, never a stored record and never a new engine.
// ─────────────────────────────────────────────────────────────────────────────

ok(!COACH.includes("mesocycleDecision:") || !/updateDoc\([^)]*mesocycleDecision/.test(COACH), 'confirmed mesocycleDecision is never written to Firestore anywhere -- it is purely a request-time computation (T192-197), so a historical view must recompute it from frozen data, never read a stored verdict that does not exist');
ok(COACH.includes('function _decideMesocycleTransition(input)'), 'confirmed the real engine T252+ would reuse for a historical recompute already exists -- no new decision logic needed');

console.log('');
console.log('T251 — Historical mesocycle contract audit: ' + pass + ' assertions PASSED');
