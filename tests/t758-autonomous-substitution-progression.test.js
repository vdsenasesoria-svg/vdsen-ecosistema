'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const vi = require('../assets/progression-variant-identity.js');
const policy = require('../assets/progression-magnitude-policy.js');
const consumer = require('../assets/progression-application-consumer.js');
const effective = require('../assets/progression-effective-prescription.js');
const eligibility = require('../api/_clientEligibility.js');
const shadow = require('../assets/progression-auto-apply-shadow.js');

const PID = 'pid-press-001';
const PLAN_ID = 'plan-meso-001';
const CLIENT_A = 'client-ayrton';
const CLIENT_B = 'client-atleta-2';

const BASE_PLAN = {
  schema: 'vdsen-plan-v2',
  clientId: CLIENT_A,
  status: 'active',
  updatedAt: '2026-09-01T00:00:00.000Z',
  weeks: 6,
  daysPerWeek: 3,
  days: [
    {
      dayIndex: 0,
      label: 'Día 1 - Empuje',
      exercises: [
        {
          exerciseName: 'Press Convergente Inclinado',
          prescriptionExerciseId: PID,
          alternatives: ['Press Inclinado con Barra', 'Press Inclinado Mancuernas'],
          repsRange: { min: 8, max: 12 },
          sets: [
            { setIndex: 0, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 100 },
            { setIndex: 1, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 100 },
            { setIndex: 2, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 100 }
          ]
        }
      ]
    }
  ]
};

function createEntry(opts) {
  var isSub = !!opts.substitutedFrom;
  return {
    done: true,
    carga: String(opts.load || 100),
    reps: String(opts.reps || 10),
    unit: opts.unit || 'KG',
    rir: opts.rirPrescribed || 2,
    rir_real: String(opts.rirReal !== undefined ? opts.rirReal : 3),
    ics: opts.ics || 8,
    pump: opts.pump || 2,
    ts: opts.ts || Date.now(),
    prescriptionExerciseId: isSub ? undefined : PID,
    executionExerciseId: opts.executionExerciseId,
    exerciseNameSnapshot: opts.exerciseNameSnapshot || 'Press Convergente Inclinado',
    substitutedFrom: opts.substitutedFrom
  };
}

test('T758.1 Original exercise with two comparable exposures progresses autonomously', () => {
  var entries = {};
  [0, 1, 2].forEach(s => {
    entries['log_1_0_0_s' + s] = createEntry({ load: 100, reps: 10, rirReal: 3 });
  });
  [0, 1, 2].forEach(s => {
    entries['log_2_0_0_s' + s] = createEntry({ load: 100, reps: 10, rirReal: 3 });
  });

  var exposures = policy.extractExposures(entries, PID, { planId: PLAN_ID, clientId: CLIENT_A });
  assert.equal(exposures.length, 2, 'Must extract exactly 2 comparable exposures for original PID');

  var result = policy.evaluate({
    clientId: CLIENT_A, planId: PLAN_ID, prescriptionExerciseId: PID,
    plan: BASE_PLAN,
    prescription: { prescriptionExerciseId: PID, sets: BASE_PLAN.days[0].exercises[0].sets, repsRange: { min: 8, max: 12 } },
    exposures: exposures
  });

  assert.equal(result.eligible, true);
  assert.equal(result.ruleId, 'A');
  assert.equal(result.candidates[0].dimension, 'LOAD');
  assert.equal(result.candidates[0].rawCandidate, 102.5, 'Original load progresses from 100 to 102.5 (+2.5%)');
});

test('T758.2 Authorized substitution with two comparable exposures progresses independently with own values', () => {
  var subName = 'Press Inclinado con Barra';
  var varId = vi.deriveExecutionId(PID, subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  assert.equal(varId, PID + ':var:press-inclinado-con-barra');

  var entries = {};
  var subFrom = { prescriptionExerciseId: PID, exerciseName: 'Press Convergente Inclinado' };

  // Week 1: 3 sets with 80 kg
  [0, 1, 2].forEach(s => {
    entries['log_1_0_0_s' + s] = createEntry({
      load: 80, reps: 10, rirReal: 3, executionExerciseId: varId,
      exerciseNameSnapshot: subName, substitutedFrom: subFrom
    });
  });
  // Week 2: 3 sets with 80 kg
  [0, 1, 2].forEach(s => {
    entries['log_2_0_0_s' + s] = createEntry({
      load: 80, reps: 10, rirReal: 3, executionExerciseId: varId,
      exerciseNameSnapshot: subName, substitutedFrom: subFrom
    });
  });

  // Extract for original: must be 0
  var origExposures = policy.extractExposures(entries, PID, { planId: PLAN_ID, clientId: CLIENT_A });
  assert.equal(origExposures.length, 0, 'Original PID must have 0 exposures (no pollution from variant)');

  // Extract for variant: must be 2
  var varExposures = policy.extractExposures(entries, varId, { planId: PLAN_ID, clientId: CLIENT_A });
  assert.equal(varExposures.length, 2, 'Variant must have 2 exposures');

  var result = policy.evaluate({
    clientId: CLIENT_A, planId: PLAN_ID, prescriptionExerciseId: PID,
    plan: BASE_PLAN,
    prescription: { prescriptionExerciseId: PID, sets: BASE_PLAN.days[0].exercises[0].sets, repsRange: { min: 8, max: 12 } },
    exposures: varExposures
  });

  assert.equal(result.eligible, true);
  assert.equal(result.candidates[0].dimension, 'LOAD');
  assert.equal(result.candidates[0].previousValue, 80);
  assert.equal(result.candidates[0].rawCandidate, 82, 'Variant load progresses from 80 to 82 (+2.5% of 80 kg)');
});

test('T758.3 Switching original -> substitution -> original preserves both baselines without transfer', () => {
  var subName = 'Press Inclinado con Barra';
  var varId = vi.deriveExecutionId(PID, subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  var subFrom = { prescriptionExerciseId: PID, exerciseName: 'Press Convergente Inclinado' };

  var entries = {};
  // Week 1: Original @ 100 kg
  [0, 1, 2].forEach(s => { entries['log_1_0_0_s' + s] = createEntry({ load: 100, reps: 10, rirReal: 2 }); });
  // Week 2: Sub @ 80 kg
  [0, 1, 2].forEach(s => {
    entries['log_2_0_0_s' + s] = createEntry({ load: 80, reps: 10, rirReal: 2, executionExerciseId: varId, exerciseNameSnapshot: subName, substitutedFrom: subFrom });
  });
  // Week 3: Original @ 100 kg
  [0, 1, 2].forEach(s => { entries['log_3_0_0_s' + s] = createEntry({ load: 100, reps: 10, rirReal: 2 }); });

  var origExps = policy.extractExposures(entries, PID, { planId: PLAN_ID, clientId: CLIENT_A });
  var varExps = policy.extractExposures(entries, varId, { planId: PLAN_ID, clientId: CLIENT_A });

  assert.equal(origExps.length, 2, 'Original has weeks 1 and 3');
  assert.equal(origExps[0].sets[0].load, '100');
  assert.equal(origExps[1].sets[0].load, '100');

  assert.equal(varExps.length, 1, 'Variant has week 2');
  assert.equal(varExps[0].sets[0].load, '80');
});

test('T758.4 Switching substitution A -> substitution B -> substitution A isolates both variants', () => {
  var subA = 'Press Inclinado con Barra';
  var subB = 'Press Inclinado Mancuernas';
  var varA = vi.deriveExecutionId(PID, subA, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  var varB = vi.deriveExecutionId(PID, subB, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  assert.notEqual(varA, varB);

  var entries = {};
  var subFrom = { prescriptionExerciseId: PID, exerciseName: 'Press Convergente Inclinado' };

  // W1: Var A @ 80kg
  [0, 1, 2].forEach(s => { entries['log_1_0_0_s' + s] = createEntry({ load: 80, executionExerciseId: varA, exerciseNameSnapshot: subA, substitutedFrom: subFrom }); });
  // W2: Var B @ 34kg
  [0, 1, 2].forEach(s => { entries['log_2_0_0_s' + s] = createEntry({ load: 34, executionExerciseId: varB, exerciseNameSnapshot: subB, substitutedFrom: subFrom }); });
  // W3: Var A @ 80kg
  [0, 1, 2].forEach(s => { entries['log_3_0_0_s' + s] = createEntry({ load: 80, executionExerciseId: varA, exerciseNameSnapshot: subA, substitutedFrom: subFrom }); });

  var expA = policy.extractExposures(entries, varA, { planId: PLAN_ID, clientId: CLIENT_A });
  var expB = policy.extractExposures(entries, varB, { planId: PLAN_ID, clientId: CLIENT_A });

  assert.equal(expA.length, 2);
  assert.equal(expB.length, 1);
  assert.equal(expA[0].sets[0].load, '80');
  assert.equal(expB[0].sets[0].load, '34');
});

test('T758.5 Independent history recovery per variant', () => {
  var subName = 'Press Inclinado con Barra';
  var varId = vi.deriveExecutionId(PID, subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  var subFrom = { prescriptionExerciseId: PID, exerciseName: 'Press Convergente Inclinado' };

  var entries = {};
  [0, 1, 2].forEach(s => { entries['log_1_0_0_s' + s] = createEntry({ load: 100, reps: 10, rirReal: 2 }); });
  [0, 1, 2].forEach(s => { entries['log_2_0_0_s' + s] = createEntry({ load: 80, reps: 8, rirReal: 1, executionExerciseId: varId, exerciseNameSnapshot: subName, substitutedFrom: subFrom }); });

  var expOrig = policy.extractExposures(entries, PID);
  var expVar = policy.extractExposures(entries, varId);

  assert.equal(expOrig.length, 1);
  assert.equal(expOrig[0].sets[0].load, '100');
  assert.equal(expVar.length, 1);
  assert.equal(expVar[0].sets[0].load, '80');
});

test('T758.6 Absence of automatic load transfer between variants', () => {
  var subName = 'Press Inclinado con Barra';
  var varId = vi.deriveExecutionId(PID, subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  var subFrom = { prescriptionExerciseId: PID, exerciseName: 'Press Convergente Inclinado' };

  var entries = {};
  [0, 1, 2].forEach(s => { entries['log_1_0_0_s' + s] = createEntry({ load: 80, reps: 10, rirReal: 3, executionExerciseId: varId, exerciseNameSnapshot: subName, substitutedFrom: subFrom }); });
  [0, 1, 2].forEach(s => { entries['log_2_0_0_s' + s] = createEntry({ load: 80, reps: 10, rirReal: 3, executionExerciseId: varId, exerciseNameSnapshot: subName, substitutedFrom: subFrom }); });

  var varExposures = policy.extractExposures(entries, varId);

  var varResult = policy.evaluate({
    clientId: CLIENT_A, planId: PLAN_ID, prescriptionExerciseId: PID,
    plan: BASE_PLAN,
    prescription: { prescriptionExerciseId: PID, sets: BASE_PLAN.days[0].exercises[0].sets, repsRange: { min: 8, max: 12 } },
    exposures: varExposures
  });

  assert.equal(varResult.candidates[0].previousValue, 80, 'Must base on variant history (80), not original (100)');
  assert.equal(varResult.candidates[0].rawCandidate, 82);
});

test('T758.7 Insufficient history keeps safe base plan (NEEDS_EVIDENCE)', () => {
  var subName = 'Press Inclinado con Barra';
  var varId = vi.deriveExecutionId(PID, subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  var subFrom = { prescriptionExerciseId: PID, exerciseName: 'Press Convergente Inclinado' };

  var entries = {};
  // Only 1 exposure of variant
  [0, 1, 2].forEach(s => { entries['log_1_0_0_s' + s] = createEntry({ load: 80, reps: 10, rirReal: 3, executionExerciseId: varId, exerciseNameSnapshot: subName, substitutedFrom: subFrom }); });

  var varExposures = policy.extractExposures(entries, varId);

  var varResult = policy.evaluate({
    clientId: CLIENT_A, planId: PLAN_ID, prescriptionExerciseId: PID,
    plan: BASE_PLAN,
    prescription: { prescriptionExerciseId: PID, sets: BASE_PLAN.days[0].exercises[0].sets, repsRange: { min: 8, max: 12 } },
    exposures: varExposures
  });

  assert.equal(varResult.eligible, false);
  assert.equal(varResult.comparableExposureCount, 1);
  assert.ok(varResult.reasonCodes.includes('INSUFFICIENT_COMPARABLE_EXPOSURES'));
});

test('T758.8 Unauthorized substitution: records training safely without applying numeric progression', () => {
  var unauthName = 'Press Militar Sentado'; // Not in alternatives
  var unauthId = vi.deriveExecutionId(PID, unauthName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  assert.ok(unauthId.includes(':unauth:'));
  var parsed = vi.parseExecutionId(unauthId);
  assert.equal(parsed.isAuthorized, false);

  var subFrom = { prescriptionExerciseId: PID, exerciseName: 'Press Convergente Inclinado' };
  var entries = {};
  [0, 1, 2].forEach(s => {
    entries['log_1_0_0_s' + s] = createEntry({ load: 50, executionExerciseId: unauthId, exerciseNameSnapshot: unauthName, substitutedFrom: subFrom });
  });

  var evalResult = eligibility.evaluateClientEligibility({
    clientId: CLIENT_A,
    client: { activePlanId: PLAN_ID, coachId: 'coach-1', createdAt: '2026-09-01T00:00:00.000Z' },
    plan: BASE_PLAN,
    requestedPlanId: PLAN_ID,
    entries: entries,
    now: Date.now()
  });

  assert.equal(evalResult.readyForMotorProgression, false, 'Unauthorized substitution cannot grant progression readiness');
});

test('T758.11 Lifecycle PENDING -> APPLIED -> CONSUMED for authorized variant', () => {
  var subName = 'Press Inclinado con Barra';
  var varId = vi.deriveExecutionId(PID, subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  var planWithRange = Object.assign({}, BASE_PLAN, {
    weeks: 4,
    days: [{
      dayIndex: 0,
      exercises: [{
        prescriptionExerciseId: PID,
        exerciseName: 'Press Convergente Inclinado',
        alternatives: ['Press Inclinado con Barra'],
        sets: [{ repsTarget: 10, rirTarget: 2, load: 80 }],
        repsRange: { min: 8, max: 12 }
      }]
    }]
  });

  var entries = {
    'log_1_0_0_s0': { carga: 80, reps: 10, unit: 'KG', done: true, rir: 2, rir_real: 3, executionExerciseId: varId, substitutedFrom: { prescriptionExerciseId: PID }, ts: '2026-09-05T00:00:00.000Z' },
    'log_2_0_0_s0': { carga: 80, reps: 10, unit: 'KG', done: true, rir: 2, rir_real: 3, executionExerciseId: varId, substitutedFrom: { prescriptionExerciseId: PID }, ts: '2026-09-08T00:00:00.000Z' }
  };

  var record = shadow.buildRecord({
    clientId: CLIENT_A, planId: PLAN_ID, activePlanId: PLAN_ID,
    plan: planWithRange,
    executionExerciseId: varId,
    recommendation: { prescriptionExerciseId: PID, executionExerciseId: varId, exerciseName: 'Press Inclinado con Barra', action: 'increase_load', newLoad: 82, newReps: 10 },
    entries: entries,
    week: 2, dayIndex: 0,
    calculatedAt: '2026-09-10T12:00:00.000Z',
    sourceMatches: true, sourcePidCount: 1
  }, '2026-09-10T13:00:00.000Z');

  var appPlan = consumer.planApplication({
    record: record,
    context: {
      clientId: CLIENT_A, planId: PLAN_ID, activePlanId: PLAN_ID,
      plan: planWithRange,
      entries: entries,
      trustedServerNumericApply: true,
      canaryScope: { enabled: true, clientIds: [CLIENT_A], prescriptionExerciseIds: [PID] },
      equipmentResolution: {
        resolutionState: 'RESOLVED',
        equipmentId: 'eq-barbell',
        currentLoad: 80,
        requestedLoad: 82,
        realizableLoad: 82,
        unit: 'KG',
        roundingReason: 'EXACT_STEP',
        incrementSource: 'GYM_METADATA',
        incrementScope: 'GLOBAL',
        incrementRevision: 1,
        incrementConfiguredAt: '2026-09-01T00:00:00.000Z',
        incrementKind: 'STEP'
      }
    }
  });

  assert.equal(appPlan.wouldApply, true);
  assert.equal(appPlan.canApply, true);
  assert.equal(appPlan.overlay.prescriptionExerciseId, PID);
  assert.equal(appPlan.overlay.executionExerciseId, varId);
  assert.equal(appPlan.overlay.appliedValue, 82);
});

test('T758.12 Prevention of double application across variants and exposures', () => {
  var subName = 'Press Inclinado con Barra';
  var varId = vi.deriveExecutionId(PID, subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  var existingOverlay = {
    key: 'ovl_rec_var_001',
    schema: 'vdsen-next-exposure-overlay-v1',
    clientId: CLIENT_A,
    planId: PLAN_ID,
    prescriptionExerciseId: PID,
    executionExerciseId: varId,
    target: { week: 3, dayIndex: 0 }
  };

  var record = {
    key: 'rec_var_002',
    clientId: CLIENT_A, planId: PLAN_ID, prescriptionExerciseId: PID, executionExerciseId: varId,
    state: 'PENDING',
    source: { week: 2, dayIndex: 0, calculatedAt: '2026-09-10T12:00:00.000Z' },
    nextExposure: { week: 3, dayIndex: 0 },
    magnitude: {
      mode: 'SHADOW', numericApplyAllowed: false, schema: 'vdsen-magnitude-shadow-v1',
      candidates: [{ dimension: 'LOAD', previousValue: 80, requestedValue: 82, appliedValue: 82, unit: 'KG' }]
    }
  };

  var appPlan = consumer.planApplication({
    record: record,
    context: {
      clientId: CLIENT_A, planId: PLAN_ID, activePlanId: PLAN_ID, plan: BASE_PLAN,
      existingOverlays: { ovl_rec_var_001: existingOverlay }
    }
  });

  assert.equal(appPlan.wouldApply, false);
  assert.ok(appPlan.blockers.includes('ALREADY_RECORDED'));
});

test('T758.13 Individual and global STOP disarms variant progressions equally', () => {
  var subName = 'Press Inclinado con Barra';
  var varId = vi.deriveExecutionId(PID, subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  var record = {
    key: 'rec_var_003',
    clientId: CLIENT_A, planId: PLAN_ID, prescriptionExerciseId: PID, executionExerciseId: varId,
    state: 'PENDING',
    source: { week: 2, dayIndex: 0, calculatedAt: '2026-09-10T12:00:00.000Z' },
    nextExposure: { week: 3, dayIndex: 0 },
    magnitude: {
      mode: 'SHADOW', numericApplyAllowed: false, schema: 'vdsen-magnitude-shadow-v1',
      candidates: [{ dimension: 'LOAD', previousValue: 80, requestedValue: 82, appliedValue: 82, unit: 'KG' }]
    }
  };

  // STOP: canary disabled
  var stopPlan = consumer.planApplication({
    record: record,
    context: {
      clientId: CLIENT_A, planId: PLAN_ID, activePlanId: PLAN_ID, plan: BASE_PLAN,
      canaryScope: { enabled: false, clientIds: [CLIENT_A], prescriptionExerciseIds: [PID] }
    }
  });

  assert.equal(stopPlan.wouldApply, false);
  assert.ok(stopPlan.blockers.includes('OUT_OF_CANARY_SCOPE'));
});

test('T758.14 Client isolation: Variant of Client A never impacts Client B', () => {
  var subName = 'Press Inclinado con Barra';
  var varIdA = vi.deriveExecutionId(PID, subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  var recordB = {
    key: 'rec_b',
    clientId: CLIENT_B, planId: 'plan-client-b', prescriptionExerciseId: PID, executionExerciseId: varIdA,
    state: 'PENDING',
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-09-10T12:00:00.000Z' },
    nextExposure: { week: 2, dayIndex: 0 },
    magnitude: { mode: 'SHADOW', numericApplyAllowed: false, schema: 'vdsen-magnitude-shadow-v1', candidates: [{ dimension: 'LOAD', previousValue: 80, appliedValue: 82, unit: 'KG' }] }
  };

  var appB = consumer.planApplication({
    record: recordB,
    context: { clientId: CLIENT_A, planId: PLAN_ID, activePlanId: PLAN_ID, plan: BASE_PLAN }
  });

  assert.equal(appB.wouldApply, false);
  assert.ok(appB.blockers.includes('CLIENT_MISMATCH'));
});

test('T758.16 Effective prescription visibility in App Cliente reflects selected variant', () => {
  var subName = 'Press Inclinado con Barra';
  var varId = vi.deriveExecutionId(PID, subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  var overlays = {
    ovl_rec_orig: {
      key: 'ovl_rec_orig', schema: 'vdsen-next-exposure-overlay-v1', clientId: CLIENT_A, planId: PLAN_ID,
      prescriptionExerciseId: PID, executionExerciseId: PID, sourceRecordKey: 'rec_orig',
      target: { week: 3, dayIndex: 0 }, dimension: 'LOAD', previousValue: 100, appliedValue: 105, unit: 'KG',
      status: 'APPLIED', components: null, sets: [{ effective: { load: 105, repsTarget: 10, rirTarget: 2 } }]
    },
    ovl_rec_var: {
      key: 'ovl_rec_var', schema: 'vdsen-next-exposure-overlay-v1', clientId: CLIENT_A, planId: PLAN_ID,
      prescriptionExerciseId: PID, executionExerciseId: varId, sourceRecordKey: 'rec_var',
      target: { week: 3, dayIndex: 0 }, dimension: 'LOAD', previousValue: 80, appliedValue: 85, unit: 'KG',
      status: 'APPLIED', components: null, sets: [{ effective: { load: 85, repsTarget: 10, rirTarget: 2 } }]
    }
  };

  var records = {
    rec_orig: { key: 'rec_orig', clientId: CLIENT_A, planId: PLAN_ID, prescriptionExerciseId: PID, state: 'APPLIED', createdAt: '2026-09-02T00:00:00.000Z', source: { week: 2, dayIndex: 0, calculatedAt: '2026-09-02T00:00:00.000Z' }, lifecycle: { overlayKey: 'ovl_rec_orig' } },
    rec_var: { key: 'rec_var', clientId: CLIENT_A, planId: PLAN_ID, prescriptionExerciseId: PID, state: 'APPLIED', createdAt: '2026-09-02T00:00:00.000Z', source: { week: 2, dayIndex: 0, calculatedAt: '2026-09-02T00:00:00.000Z' }, lifecycle: { overlayKey: 'ovl_rec_var' } }
  };

  // Athlete viewing original
  var origEff = effective.resolveEffective({
    clientId: CLIENT_A, planId: PLAN_ID, activePlanId: PLAN_ID,
    pid: PID, executionExerciseId: PID, week: 3, dayIndex: 0,
    records: records, overlays: overlays, plan: BASE_PLAN, entries: {}, baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });

  assert.equal(origEff.provenance, 'CANONICAL_OVERLAY');
  assert.equal(origEff.appliedValue, 105, 'Original receives 105 kg');

  // Athlete selects variant in session
  var varEff = effective.resolveEffective({
    clientId: CLIENT_A, planId: PLAN_ID, activePlanId: PLAN_ID,
    pid: PID, executionExerciseId: varId, week: 3, dayIndex: 0,
    records: records, overlays: overlays, plan: BASE_PLAN, entries: {}, baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });

  assert.equal(varEff.provenance, 'CANONICAL_OVERLAY');
  assert.equal(varEff.appliedValue, 85, 'Variant receives 85 kg');
});

test('T758.9_10 Coach defines authorized alternatives in plan; engine progresses autonomously without routine coach review', () => {
  var subName = 'Press Inclinado con Barra';
  var isAuth = vi.isAuthorizedAlternative(subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  assert.equal(isAuth, true, 'Coach pre-authorized the alternative in plan prescription');

  var varId = vi.deriveExecutionId(PID, subName, BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  var subFrom = { prescriptionExerciseId: PID, exerciseName: 'Press Convergente Inclinado' };

  var entries = {};
  [0, 1].forEach(s => { entries['log_1_0_0_s' + s] = createEntry({ load: 80, reps: 10, rirReal: 3, executionExerciseId: varId, exerciseNameSnapshot: subName, substitutedFrom: subFrom }); });
  [0, 1].forEach(s => { entries['log_2_0_0_s' + s] = createEntry({ load: 80, reps: 10, rirReal: 3, executionExerciseId: varId, exerciseNameSnapshot: subName, substitutedFrom: subFrom }); });

  var varExposures = policy.extractExposures(entries, varId);
  var varResult = policy.evaluate({
    clientId: CLIENT_A, planId: PLAN_ID, prescriptionExerciseId: PID,
    plan: BASE_PLAN,
    prescription: { prescriptionExerciseId: PID, sets: BASE_PLAN.days[0].exercises[0].sets, repsRange: { min: 8, max: 12 } },
    exposures: varExposures
  });

  assert.equal(varResult.eligible, true);
  assert.equal(varResult.coachReviewRequired, null, 'No routine coach review required for pre-authorized alternative');
  assert.deepEqual(varResult.coachReview, [], 'No manual coach intervention blockers generated');
});

test('T758.15 Backward compatibility: legacy logs without executionExerciseId read safely as original exercise', () => {
  var legacyEntries = {
    'log_1_0_0_s0': { carga: 100, reps: 10, rir: 2, rir_real: 3, unit: 'KG', done: true, prescriptionExerciseId: PID, ts: '2026-09-02T00:00:00.000Z' },
    'log_2_0_0_s0': { carga: 100, reps: 10, rir: 2, rir_real: 3, unit: 'KG', done: true, prescriptionExerciseId: PID, ts: '2026-09-09T00:00:00.000Z' }
  };

  // Original target extracts both legacy entries
  var origExposures = policy.extractExposures(legacyEntries, PID);
  assert.equal(origExposures.length, 2, 'Legacy entries without executionExerciseId match original PID');
  assert.equal(origExposures[0].prescriptionExerciseId, PID);
  assert.equal(origExposures[0].executionExerciseId, PID);

  // Variant target does not falsely match legacy entries
  var varId = vi.deriveExecutionId(PID, 'Press Inclinado con Barra', ['Press Inclinado con Barra'], 'Press Convergente Inclinado');
  var varExposures = policy.extractExposures(legacyEntries, varId);
  assert.equal(varExposures.length, 0, 'Variant target never extracts legacy entries of original exercise');
});
