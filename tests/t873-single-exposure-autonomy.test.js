'use strict';
// T873 — Single-exposure autonomy without requiring artificial additional workouts.
// Verifies:
//   1. 1 valid exposure with justified VDSEN rule (A LOAD, A REPS, DP LOAD, C REST) -> eligible=true, minExposures=1, overlay applies to next pending session.
//   2. 1 valid exposure with MAINTAIN or COACH_REVIEW_REQUIRED (including Ayrton's authentic D3 35kg x 10 RIR 2 vs target RIR 3) -> no artificial increment.
//   3. 2-exposure persistence rules (S-ADD, S-HARD-TWICE, C+E, direction conflict) remain strictly gated at 2 comparable exposures.
//   4. 0 exposures -> INSUFFICIENT_COMPARABLE_EXPOSURES, base prescription preserved.
//   5. Separate PIDs for D1, D3, D5 sharing the same exercise name ("Press Convergente Inclinado") never contaminate each other.
//   6. No double applications, no retroactive modification of started sessions, Coach override priority preserved.
//   7. Pilot contract scopes only Ayrton's real D2 quadriceps PID (506fb437-f151-499a-bbdb-512cd4d0b7c6) while D3 remains separate and Numeric Apply OFF.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));
const structural = require(path.join(root, 'assets/progression-structural-policy.js'));
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const effective = require(path.join(root, 'assets/progression-effective-prescription.js'));
const equipment = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const pilotContract = require(path.join(root, 'api/_numericPilotContract.js'));

const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const PLAN_ID = 'yoQVsI7drVJbcHOg4sZQ';
const PID_D1 = '5976b808-9efd-4a9d-86c9-0219fa4da167';
const PID_D3 = '453d6665-79a7-4052-a5a4-6cfc0f410187';
const PID_D5 = '4fcef626-9dda-4239-b0a6-d7833ba20073';
const PILOT_PID_D2 = '506fb437-f151-499a-bbdb-512cd4d0b7c6';
const T0 = Date.parse('2026-11-23T10:00:00.000Z');

function loadWithFlagOn(relPath) {
  const src = fs.readFileSync(path.join(root, relPath), 'utf8')
    .replace('var NUMERIC_APPLY_ENABLED = false;', 'var NUMERIC_APPLY_ENABLED = true;');
  const mod = { exports: {} };
  vm.runInNewContext(src, { module: mod, exports: mod.exports, require, console, Date, Math, Object, Array, Number, String, JSON, RegExp, Set, Map, Promise });
  return mod.exports;
}

const PLAN = {
  clientId: UID,
  weeks: 13,
  updatedAt: '2026-11-22T00:00:00.000Z',
  days: [
    {
      dayIndex: 0,
      exercises: [
        {
          prescriptionExerciseId: PID_D1,
          exerciseId: 'press-convergente-inclinado',
          exerciseName: 'Press Convergente Inclinado',
          muscleGroup: 'pectoral',
          fatigueCost: 3,
          sets: [0, 1, 2].map((i) => ({ setIndex: i, repsTarget: 8, rirTarget: 3, restSeconds: 150 })),
        },
      ],
    },
    {
      dayIndex: 2,
      exercises: [
        {
          prescriptionExerciseId: PID_D3,
          exerciseId: 'press-convergente-inclinado',
          exerciseName: 'Press Convergente Inclinado',
          muscleGroup: 'pectoral',
          fatigueCost: 3,
          sets: [0, 1].map((i) => ({ setIndex: i, repsTarget: 10, rirTarget: 3, restSeconds: 120 })),
        },
      ],
    },
    {
      dayIndex: 4,
      exercises: [
        {
          prescriptionExerciseId: PID_D5,
          exerciseId: 'press-convergente-inclinado',
          exerciseName: 'Press Convergente Inclinado',
          muscleGroup: 'pectoral',
          fatigueCost: 3,
          sets: [0, 1].map((i) => ({ setIndex: i, repsTarget: 10, rirTarget: 3, restSeconds: 120 })),
        },
      ],
    },
  ],
};

function makeD3Logs(week, overrides = {}) {
  const e = {};
  [0, 1].forEach((s) => {
    e[`log_${week}_2_0_s${s}`] = Object.assign(
      {
        done: true,
        carga: '35',
        reps: '10',
        unit: 'KG',
        rir: 3,
        rir_real: 4,
        ics: 10,
        pump: 'ALTO',
        prescriptionExerciseId: PID_D3,
        ts: T0 + week * 86400000 + s * 1000,
      },
      overrides
    );
  });
  return e;
}

test('T873.1 Single valid exposure with justified VDSEN rule (A LOAD, A REPS, DP LOAD, C REST) is eligible without a 2nd session', () => {
  assert.equal(policy.MIN_COMPARABLE_EXPOSURES, 1);
  assert.equal(policy.MIN_PERSISTENCE_EXPOSURES, 2);
  assert.equal(policy.NUMERIC_APPLY_ENABLED, false);

  // Rule A LOAD (target RIR 3, observed RIR 4 -> +2.5% load on 35 kg = 35.875)
  const dLoad = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN,
    prescription: PLAN.days[1].exercises[0],
    exposures: policy.extractExposures(makeD3Logs(1, { rir: 3, rir_real: 4 }), PID_D3, { planId: PLAN_ID, clientId: UID }),
  });
  assert.equal(dLoad.eligible, true);
  assert.equal(dLoad.comparableExposureCount, 1);
  assert.equal(dLoad.minExposures, 1);
  assert.equal(dLoad.ruleId, 'A');
  assert.equal(dLoad.dimension, 'LOAD');
  assert.equal(dLoad.directionConsistency, 'NOT_APPLICABLE');
  assert.equal(dLoad.candidates[0].rawCandidate, 35.875);

  // Rule A REPS (target RIR 1, range 8-12, observed 10 reps at RIR 2 -> +1 rep = 11)
  const rxReps = { prescriptionExerciseId: PID_D3, repsRange: { min: 8, max: 12 }, sets: [0, 1].map((i) => ({ setIndex: i, repsTarget: 10, rirTarget: 1, restSeconds: 120 })) };
  const dReps = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN,
    prescription: rxReps,
    exposures: policy.extractExposures(makeD3Logs(1, { reps: '10', rir: 1, rir_real: 2 }), PID_D3, { planId: PLAN_ID, clientId: UID }),
  });
  assert.equal(dReps.eligible, true);
  assert.equal(dReps.ruleId, 'A');
  assert.equal(dReps.dimension, 'REPS');
  assert.equal(dReps.candidates[0].finalCandidate, 11);

  // Rule DP LOAD (ceiling 12 reps at prescribed RIR 1 -> +2.5% load)
  const dDp = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN,
    prescription: rxReps,
    exposures: policy.extractExposures(makeD3Logs(1, { reps: '12', rir: 1, rir_real: 1 }), PID_D3, { planId: PLAN_ID, clientId: UID }),
  });
  assert.equal(dDp.eligible, true);
  assert.equal(dDp.ruleId, 'DP');
  assert.equal(dDp.dimension, 'LOAD');

  // Rule C REST (+30s on first occurrence: RIR exact, reps incomplete)
  const dRest = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN,
    prescription: PLAN.days[1].exercises[0],
    exposures: policy.extractExposures(makeD3Logs(1, { reps: '8', rir: 3, rir_real: 3 }), PID_D3, { planId: PLAN_ID, clientId: UID }),
  });
  assert.equal(dRest.eligible, true);
  assert.equal(dRest.ruleId, 'C');
  assert.equal(dRest.dimension, 'REST');
  assert.equal(dRest.candidates[0].finalCandidate, 150);
});

test('T873.2 Single exposure with MAINTAIN or COACH_REVIEW_REQUIRED (including Ayrton authentic D3) produces zero artificial increments', () => {
  // Exact authentic Ayrton D3 session (23 nov 2026): 35 KG x 10 @ RIR 2 vs target RIR 3, ICS 10
  const dAyrton = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN,
    prescription: PLAN.days[1].exercises[0],
    exposures: policy.extractExposures(makeD3Logs(1, { carga: '35', reps: '10', rir: 3, rir_real: 2, ics: 10 }), PID_D3, { planId: PLAN_ID, clientId: UID }),
  });
  assert.equal(dAyrton.comparableExposureCount, 1);
  assert.equal(dAyrton.ruleId, 'D');
  assert.equal(dAyrton.eligible, false);
  assert.equal(dAyrton.candidates.length, 0);
  assert.equal(dAyrton.coachReviewRequired.branch, 'D');

  // Exact on-target execution: 35 KG x 10 @ RIR 3 -> MAINTAIN, no adjustment
  const dMaintain = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN,
    prescription: PLAN.days[1].exercises[0],
    exposures: policy.extractExposures(makeD3Logs(1, { carga: '35', reps: '10', rir: 3, rir_real: 3, ics: 10 }), PID_D3, { planId: PLAN_ID, clientId: UID }),
  });
  assert.equal(dMaintain.comparableExposureCount, 1);
  assert.equal(dMaintain.ruleId, 'MAINTAIN');
  assert.equal(dMaintain.eligible, false);
  assert.equal(dMaintain.candidates.length, 0);
  assert.ok(dMaintain.reasonCodes.includes('NO_ADJUSTMENT_NEEDED'));
});

test('T873.3 Persistence-dependent rules (S-ADD, S-HARD-TWICE, C+E, direction conflict) strictly preserve 2-exposure comparison', () => {
  const rx = PLAN.days[1].exercises[0];
  const entries1 = makeD3Logs(1, { carga: '35', reps: '10', rir: 3, rir_real: 3, ics: 10 });
  const entries2 = Object.assign({}, entries1, makeD3Logs(2, { carga: '35', reps: '10', rir: 3, rir_real: 3, ics: 10 }));

  // S-ADD: 1 exposure -> structural does NOT add a set; 2 exposures -> S-ADD with minExposures=2
  const oneExp = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN, prescription: rx,
    exposures: policy.extractExposures(entries1, PID_D3, { planId: PLAN_ID, clientId: UID }),
    context: { structural: { entries: entries1, targetWeek: 2, carriedSets: {} } },
  });
  assert.notEqual(oneExp.ruleId, 'S-ADD');

  const twoExp = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN, prescription: rx,
    exposures: policy.extractExposures(entries2, PID_D3, { planId: PLAN_ID, clientId: UID }),
    context: { structural: { entries: entries2, targetWeek: 3, carriedSets: {} } },
  });
  assert.equal(twoExp.ruleId, 'S-ADD');
  assert.equal(twoExp.minExposures, 2);
  assert.equal(twoExp.eligible, true);
  assert.equal(twoExp.candidates[0].finalCandidate, 3);

  // S-HARD-TWICE: 1 hard exposure -> S-FREEZE-HARD (minExposures=1); 2 consecutive hard exposures -> S-HARD-TWICE (minExposures=2)
  const hard1 = makeD3Logs(1, { rir: 3, rir_real: 1, ics: 9 });
  const hard2 = Object.assign({}, hard1, makeD3Logs(2, { rir: 3, rir_real: 1, ics: 9 }));
  const dHard1 = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN, prescription: rx,
    exposures: policy.extractExposures(hard1, PID_D3, { planId: PLAN_ID, clientId: UID }),
    context: { structural: { entries: hard1, targetWeek: 2, carriedSets: {} } },
  });
  assert.equal(dHard1.ruleId, 'S-FREEZE-HARD');
  assert.equal(dHard1.minExposures, 1);

  const dHard2 = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN, prescription: rx,
    exposures: policy.extractExposures(hard2, PID_D3, { planId: PLAN_ID, clientId: UID }),
    context: { structural: { entries: hard2, targetWeek: 3, carriedSets: {} } },
  });
  assert.equal(dHard2.ruleId, 'S-HARD-TWICE');
  assert.equal(dHard2.minExposures, 2);

  // C+E persistence: 2nd consecutive C escalates to COACH_REVIEW_REQUIRED (minExposures=2)
  const c2 = Object.assign({}, makeD3Logs(1, { reps: '8', rir: 3, rir_real: 3 }), makeD3Logs(2, { reps: '8', rir: 3, rir_real: 3 }));
  const dCE = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN, prescription: rx,
    exposures: policy.extractExposures(c2, PID_D3, { planId: PLAN_ID, clientId: UID }),
  });
  assert.equal(dCE.ruleId, 'C+E');
  assert.equal(dCE.minExposures, 2);
  assert.equal(dCE.eligible, false);
  assert.equal(dCE.coachReviewRequired.branch, 'C+E');

  // Conflicting direction across 2 exposures (DOWN then UP) stays blocked
  const conflict = Object.assign({}, makeD3Logs(1, { reps: '10', rir: 3, rir_real: 1 }), makeD3Logs(2, { reps: '10', rir: 3, rir_real: 4 }));
  const dConf = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN, prescription: rx,
    exposures: policy.extractExposures(conflict, PID_D3, { planId: PLAN_ID, clientId: UID }),
  });
  assert.equal(dConf.directionConsistency, 'CONFLICTING');
  assert.equal(dConf.eligible, false);
  assert.ok(dConf.reasonCodes.includes('CONFLICTING_DIRECTION_ACROSS_EXPOSURES'));
});

test('T873.4 Zero exposures preserves base prescription with INSUFFICIENT_COMPARABLE_EXPOSURES', () => {
  const d0 = policy.evaluate({
    clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN,
    prescription: PLAN.days[1].exercises[0],
    exposures: [],
  });
  assert.equal(d0.comparableExposureCount, 0);
  assert.equal(d0.eligible, false);
  assert.equal(d0.candidates.length, 0);
  assert.ok(d0.reasonCodes.includes('INSUFFICIENT_COMPARABLE_EXPOSURES'));
});

test('T873.5 Independent PIDs (D1, D3, D5) sharing the same exercise name never contaminate each other', () => {
  const entries = Object.assign(
    {},
    makeD3Logs(1, { carga: '35', reps: '10', rir: 3, rir_real: 4, prescriptionExerciseId: PID_D3 }),
    {
      log_1_0_0_s0: { done: true, carga: '40', reps: '8', unit: 'KG', rir: 3, rir_real: 1, ics: 9, prescriptionExerciseId: PID_D1, ts: T0 + 100 },
      log_1_4_0_s0: { done: true, carga: '30', reps: '10', unit: 'KG', rir: 3, rir_real: 3, ics: 9, prescriptionExerciseId: PID_D5, ts: T0 + 200 },
    }
  );
  const expD1 = policy.extractExposures(entries, PID_D1, { planId: PLAN_ID, clientId: UID });
  const expD3 = policy.extractExposures(entries, PID_D3, { planId: PLAN_ID, clientId: UID });
  const expD5 = policy.extractExposures(entries, PID_D5, { planId: PLAN_ID, clientId: UID });
  assert.equal(expD1.length, 1);
  assert.equal(expD3.length, 1);
  assert.equal(expD5.length, 1);
  assert.equal(expD3[0].sets[0].load, '35');
  assert.equal(expD1[0].sets[0].load, '40');
  assert.equal(expD5[0].sets[0].load, '30');

  const d3 = policy.evaluate({ clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D3, plan: PLAN, prescription: PLAN.days[1].exercises[0], exposures: expD3 });
  const d1 = policy.evaluate({ clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D1, plan: PLAN, prescription: PLAN.days[0].exercises[0], exposures: expD1 });
  const d5 = policy.evaluate({ clientId: UID, planId: PLAN_ID, prescriptionExerciseId: PID_D5, plan: PLAN, prescription: PLAN.days[2].exercises[0], exposures: expD5 });
  assert.equal(d3.ruleId, 'A');
  assert.equal(d3.eligible, true);
  assert.equal(d1.ruleId, 'D');
  assert.equal(d1.eligible, false);
  assert.equal(d5.ruleId, 'MAINTAIN');
  assert.equal(d5.eligible, false);
});

test('T873.6 Single-exposure overlay applies to next pending session only, blocks started sessions, respects Coach override, and prevents double application', () => {
  const consumerOn = loadWithFlagOn('assets/progression-application-consumer.js');
  const effectiveOn = loadWithFlagOn('assets/progression-effective-prescription.js');
  const entries = makeD3Logs(1, { carga: '35', reps: '10', rir: 3, rir_real: 4 });
  const calcAt = '2026-11-24T12:00:00.000Z';
  const rec = shadow.buildRecord(
    {
      clientId: UID, planId: PLAN_ID, activePlanId: PLAN_ID, plan: PLAN, entries,
      week: 1, dayIndex: 2, calculatedAt: calcAt, sourceMatches: true, sourcePidCount: 1,
      recommendation: { prescriptionExerciseId: PID_D3, exerciseId: 'press-convergente-inclinado', exerciseName: 'Press Convergente Inclinado', action: 'increase_load', newLoad: 36, newReps: 10 },
    },
    '2026-11-24T12:01:00.000Z'
  );
  assert.equal(rec.state, 'PENDING');
  assert.equal(rec.magnitude.eligible, true);
  assert.equal(rec.magnitude.minExposures, 1);

  const eqRes = equipment.resolveAdvisoryLoad({ magnitude: rec.magnitude });
  const ctx = {
    clientId: UID, planId: PLAN_ID, activePlanId: PLAN_ID, plan: PLAN, entries,
    interventions: [], equipmentResolution: eqRes, existingOverlays: {},
    now: '2026-11-24T12:05:00.000Z', resolveNextExposure: shadow.resolveNextExposure,
  };

  // Applies cleanly to Week 2 D3
  const dOk = consumerOn.planApplication({ record: rec, context: ctx });
  assert.equal(dOk.canApply, true, JSON.stringify(dOk.blockers));
  assert.equal(dOk.guard.ok, true);
  assert.equal(dOk.overlay.target.week, 2);
  assert.equal(dOk.overlay.target.dayIndex, 2);
  assert.equal(dOk.overlay.appliedValue, 36);

  // Visible in effective prescription for Week 2 D3 (next pending session) without touching Week 1 D3
  const overlays = { [dOk.overlay.key]: Object.assign({}, dOk.overlay, { status: 'APPLIED' }) };
  const appliedRec = Object.assign({}, rec, { state: 'APPLIED', lifecycle: { overlayKey: dOk.overlay.key, appliedAt: '2026-11-24T12:05:00.000Z' } });
  const effW2Off = effective.resolveEffective({
    clientId: UID, planId: PLAN_ID, activePlanId: PLAN_ID, plan: PLAN, entries, overlays,
    records: { [rec.key]: appliedRec },
    interventions: [], pid: PID_D3, week: 2, dayIndex: 2,
    baseSets: PLAN.days[1].exercises[0].sets,
  });
  assert.equal(effW2Off.provenance, 'BASE_PLAN');
  assert.equal(effW2Off.reason, 'NUMERIC_APPLY_DISABLED');
  const effW2 = effectiveOn.resolveEffective({
    clientId: UID, planId: PLAN_ID, activePlanId: PLAN_ID, plan: PLAN, entries, overlays,
    records: { [rec.key]: appliedRec },
    interventions: [], pid: PID_D3, week: 2, dayIndex: 2,
    baseSets: PLAN.days[1].exercises[0].sets,
  });
  assert.equal(effW2.provenance, effectiveOn.PROVENANCE.CANONICAL_OVERLAY, JSON.stringify(effW2));
  assert.equal(effW2.appliedValue, 36);

  // No double application if overlay already exists
  const dDup = consumerOn.planApplication({ record: rec, context: Object.assign({}, ctx, { existingOverlays: overlays }) });
  assert.equal(dDup.canApply, false);

  // No retroactive modification if Week 2 D3 already started
  const startedEntries = Object.assign({}, entries, { log_2_2_0_s0: { done: true, carga: '35', reps: '10', prescriptionExerciseId: PID_D3 } });
  const dStarted = consumerOn.planApplication({ record: rec, context: Object.assign({}, ctx, { entries: startedEntries }) });
  assert.equal(dStarted.canApply, false);
  assert.ok(dStarted.blockers.includes('TARGET_ALREADY_STARTED'));

  // Coach override takes priority
  const dCoach = consumerOn.planApplication({
    record: rec,
    context: Object.assign({}, ctx, { interventions: [{ targetType: 'EXERCISE', targetId: PID_D3, planId: PLAN_ID, decidedAt: '2026-11-24T12:02:00.000Z', action: 'MODIFY' }] }),
  });
  assert.equal(dCoach.canApply, false);
  assert.ok(dCoach.blockers.includes('COACH_OVERRIDE'));
});

test('T873.7 Pilot contract binds scoped D2 quadriceps PID, keeps independent D3 PID and Numeric Apply OFF', () => {
  assert.equal(pilotContract.UID, UID);
  assert.equal(pilotContract.PLAN, PLAN_ID);
  assert.equal(pilotContract.PID, PILOT_PID_D2);
  assert.notEqual(pilotContract.PID, PID_D3);
  assert.equal(consumer.NUMERIC_APPLY_ENABLED, false);
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false);
  assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
});
