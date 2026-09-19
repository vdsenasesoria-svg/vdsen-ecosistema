'use strict';
/**
 * T170 — Client/Coach progression synchronization.
 *
 * BUSCAR finding: T165 (this same round) made the CLIENT skip auto-applying
 * a progression recommendation whose calculatedAt predates the plan's
 * updatedAt (coach edited the exercise's reps/RIR/sets after the rec was
 * computed). But the COACH monitor's _categorizeRec (T163) only knew about
 * the identity (PID) mismatch case — a coach-edit-staleness rec was still
 * shown as a normal PROGRESS_LOAD/etc. card, implying it would apply next
 * exposure, when the client actually silently skips it. Both sides read the
 * same persisted progrec_ + plan docs; they must agree on what "current"
 * means.
 *
 * FIX: _categorizeRec now also checks _isCoachEditStale (same expression as
 * the client's _progRecStale, T165) and routes it into REVIEW — reusing the
 * existing category (no new state invented) — with an accurate distinct
 * message (identity vs stale-after-edit) in _renderRecCard.
 *
 * Run: node tests/t170-client-coach-progression-sync.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Structural: Coach's staleness check uses the exact same expression as the
// Client's T165 fix — same source of truth, same rule, both sides.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("function _isCoachEditStale(r) {\n        return !!(p && p.updatedAt && r.calculatedAt && Date.parse(p.updatedAt) > Date.parse(r.calculatedAt));\n      }"), 'Coach _isCoachEditStale uses the identical expression to Client\'s T165 _progRecStale (same source of truth)');
ok(CLIENT.includes('Date.parse(PLAN.updatedAt) > Date.parse(progrec.calculatedAt)'), 'Client T165 staleness expression (regression check — unchanged by this ticket)');
ok(COACH.includes("if (_isIdentityStale(r) || _isCoachEditStale(r)) return 'REVIEW';"), '_categorizeRec now routes BOTH identity mismatch AND coach-edit staleness into REVIEW');
ok(COACH.includes('_isIdentityStale(r)\n            ? \'⚠️ Identidad no resuelta'), 'the REVIEW card shows the correct message for identity mismatch');
ok(COACH.includes('Editaste el plan después de calcularse esta recomendación'), 'the REVIEW card shows a distinct, accurate message for coach-edit staleness (not the identity-mismatch text)');

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral: reimplements the exact categorization decision against
// synthetic plan/rec pairs, proving Coach and Client reach the SAME verdict
// on whether a recommendation is live or not.
// ─────────────────────────────────────────────────────────────────────────────

function clientWouldAutoApply(planUpdatedAt, rec, ejPid) {
  var stale = !!(planUpdatedAt && rec.calculatedAt && Date.parse(planUpdatedAt) > Date.parse(rec.calculatedAt));
  return !!(rec && ejPid && rec.prescriptionExerciseId === ejPid && !stale);
}

function coachCategorization(planUpdatedAt, planPidSet, r) {
  var identityStale = !!(r.prescriptionExerciseId && planPidSet.size && !planPidSet.has(r.prescriptionExerciseId));
  var editStale = !!(planUpdatedAt && r.calculatedAt && Date.parse(planUpdatedAt) > Date.parse(r.calculatedAt));
  if (identityStale || editStale) return 'REVIEW';
  if (r.action === 'increase_load') return 'PROGRESS_LOAD';
  return 'KEEP';
}

(function testBothSidesAgreeOnCoachEditStaleness() {
  var rec = { prescriptionExerciseId: 'pid-1', calculatedAt: '2026-01-10T10:00:00.000Z', action: 'increase_load' };
  var planUpdatedAt = '2026-01-10T12:00:00.000Z'; // coach edited after the rec was calculated
  var planPidSet = new Set(['pid-1']);

  var clientApplies = clientWouldAutoApply(planUpdatedAt, rec, 'pid-1');
  var coachCat = coachCategorization(planUpdatedAt, planPidSet, rec);

  ok(clientApplies === false, 'Client: does NOT auto-apply a rec that predates the coach\'s plan edit (T165)');
  ok(coachCat === 'REVIEW', 'Coach: now ALSO shows this as REVIEW (not PROGRESS_LOAD) — matches what the Client will actually do');
})();

(function testBothSidesAgreeOnFreshRecommendation() {
  var rec = { prescriptionExerciseId: 'pid-1', calculatedAt: '2026-01-12T20:00:00.000Z', action: 'increase_load' };
  var planUpdatedAt = '2026-01-10T09:00:00.000Z'; // coach edited BEFORE the rec was calculated — rec is fresh
  var planPidSet = new Set(['pid-1']);

  var clientApplies = clientWouldAutoApply(planUpdatedAt, rec, 'pid-1');
  var coachCat = coachCategorization(planUpdatedAt, planPidSet, rec);

  ok(clientApplies === true, 'Client: DOES auto-apply a fresh rec (calculated after the last plan edit)');
  ok(coachCat === 'PROGRESS_LOAD', 'Coach: shows it as a normal PROGRESS_LOAD card — matches Client behavior');
})();

(function testBothSidesAgreeOnIdentityMismatch() {
  var rec = { prescriptionExerciseId: 'pid-old', calculatedAt: '2026-01-10T10:00:00.000Z', action: 'increase_load' };
  var planPidSet = new Set(['pid-new']); // exercise was substituted — old PID no longer in plan

  var clientApplies = clientWouldAutoApply(null, rec, 'pid-new'); // ej.prescriptionExerciseId is now pid-new
  var coachCat = coachCategorization(null, planPidSet, rec);

  ok(clientApplies === false, 'Client: does not auto-apply a rec tied to a substituted (no longer present) PID — T161 regression');
  ok(coachCat === 'REVIEW', 'Coach: still shows REVIEW for identity mismatch (T163 regression, unaffected by the T170 addition)');
})();

console.log('');
console.log('T170 — Client/Coach progression synchronization: ' + pass + ' assertions PASSED');
