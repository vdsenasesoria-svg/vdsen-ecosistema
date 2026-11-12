'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const vi = require('../assets/progression-variant-identity.js');
const policy = require('../assets/progression-magnitude-policy.js');
const consumer = require('../assets/progression-application-consumer.js');
const effective = require('../assets/progression-effective-prescription.js');
const shadow = require('../assets/progression-auto-apply-shadow.js');
const eligibility = require('../api/_clientEligibility.js');

const PID_PRESS = 'pid-press-001';
const PID_SQUAT = 'pid-squat-002';
const PLAN_ID = 'plan-meso-001';
const CLIENT_AYRTON = 'client-ayrton';
const CLIENT_OTHER = 'client-other';

const BASE_PLAN = {
  schema: 'vdsen-plan-v2',
  clientId: CLIENT_AYRTON,
  status: 'active',
  updatedAt: '2026-09-01T00:00:00.000Z',
  weeks: 12,
  daysPerWeek: 3,
  days: [
    {
      dayIndex: 0,
      label: 'Día 1 - Empuje',
      exercises: [
        {
          prescriptionExerciseId: PID_PRESS,
          exerciseId: 'ex-press-conv',
          exerciseName: 'Press Convergente Inclinado',
          alternatives: ['Press Inclinado con Barra', 'Press Inclinado Mancuernas'],
          sets: [
            { setIndex: 0, repsTarget: 10, rirTarget: 2, load: 100, restSeconds: 120 },
            { setIndex: 1, repsTarget: 10, rirTarget: 2, load: 100, restSeconds: 120 }
          ],
          repsRange: { min: 8, max: 12 }
        },
        {
          prescriptionExerciseId: PID_SQUAT,
          exerciseId: 'ex-squat-back',
          exerciseName: 'Sentadilla Trasera',
          alternatives: ['Sentadilla Hack'],
          sets: [
            { setIndex: 0, repsTarget: 8, rirTarget: 2, load: 140, restSeconds: 180 }
          ],
          repsRange: { min: 6, max: 10 }
        }
      ]
    }
  ]
};

function createEntry(opts) {
  return Object.assign({
    carga: opts.load || 100,
    reps: opts.reps || 10,
    rir: opts.rirPrescribed || 2,
    rir_real: opts.rirReal || 3,
    unit: opts.unit || 'KG',
    done: true,
    ts: opts.ts || '2026-09-02T10:00:00.000Z',
    prescriptionExerciseId: opts.prescriptionExerciseId || undefined,
    executionExerciseId: opts.executionExerciseId || undefined,
    exerciseNameSnapshot: opts.exerciseNameSnapshot || 'Press Convergente Inclinado',
    substitutedFrom: opts.substitutedFrom || undefined
  }, opts.extra || {});
}

// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA A: Continuidad independiente después de CONSUMED
// Alternancia: Original → A → Original → B → A
// ─────────────────────────────────────────────────────────────────────────────
test('T759-A: Continuidad independiente despues de CONSUMED (Original -> A -> Original -> B -> A)', () => {
  var varAId = vi.deriveExecutionId(PID_PRESS, 'Press Inclinado con Barra', BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  var varBId = vi.deriveExecutionId(PID_PRESS, 'Press Inclinado Mancuernas', BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  var records = {};
  var overlays = {};

  // 1. Original decision CONSUMED at Week 2 (100 -> 102.5 kg)
  records['rec_orig_w2'] = {
    key: 'rec_orig_w2', clientId: CLIENT_AYRTON, planId: PLAN_ID, prescriptionExerciseId: PID_PRESS, executionExerciseId: PID_PRESS,
    state: 'CONSUMED', createdAt: '2026-09-02T00:00:00.000Z', source: { week: 1, dayIndex: 0, calculatedAt: '2026-09-02T00:00:00.000Z' },
    nextExposure: { week: 2, dayIndex: 0 }, lifecycle: { overlayKey: 'ovl_rec_orig_w2' }
  };
  overlays['ovl_rec_orig_w2'] = {
    key: 'ovl_rec_orig_w2', schema: 'vdsen-next-exposure-overlay-v1', clientId: CLIENT_AYRTON, planId: PLAN_ID,
    prescriptionExerciseId: PID_PRESS, executionExerciseId: PID_PRESS, sourceRecordKey: 'rec_orig_w2',
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-09-02T00:00:00.000Z' },
    target: { week: 2, dayIndex: 0 }, dimension: 'LOAD', previousValue: 100, appliedValue: 102.5, unit: 'KG',
    status: 'CONSUMED', sets: [{ effective: { load: 102.5, repsTarget: 10, rirTarget: 2 } }]
  };

  // Check Week 3 for Original: carriedBaseline carries 102.5 kg
  var origEffW3 = effective.resolveEffective({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, pid: PID_PRESS, executionExerciseId: PID_PRESS,
    week: 3, dayIndex: 0, records: records, overlays: overlays, plan: BASE_PLAN, entries: {},
    baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(origEffW3.provenance, 'CARRIED_OVERLAY');
  assert.equal(origEffW3.sets[0].effective.load, 102.5, 'Original carries its consumed 102.5 kg');

  // Check Week 3 for Variant A (first exposure): carriedBaseline returns empty, effective.load is null (NO transfer from Original)
  var varAEffW3 = effective.resolveEffective({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, pid: PID_PRESS, executionExerciseId: varAId,
    week: 3, dayIndex: 0, records: records, overlays: overlays, plan: BASE_PLAN, entries: {},
    baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(varAEffW3.provenance, 'BASE_PLAN');
  assert.equal(varAEffW3.sets[0].effective.load, null, 'New Variant A does NOT adopt 102.5 kg from original');

  // 2. Variant A executes and progresses: overlay CONSUMED at Week 5 (80 -> 82 kg)
  records['rec_varA_w5'] = {
    key: 'rec_varA_w5', clientId: CLIENT_AYRTON, planId: PLAN_ID, prescriptionExerciseId: PID_PRESS, executionExerciseId: varAId,
    state: 'CONSUMED', createdAt: '2026-09-10T00:00:00.000Z', source: { week: 4, dayIndex: 0, calculatedAt: '2026-09-10T00:00:00.000Z' },
    nextExposure: { week: 5, dayIndex: 0 }, lifecycle: { overlayKey: 'ovl_rec_varA_w5' }
  };
  overlays['ovl_rec_varA_w5'] = {
    key: 'ovl_rec_varA_w5', schema: 'vdsen-next-exposure-overlay-v1', clientId: CLIENT_AYRTON, planId: PLAN_ID,
    prescriptionExerciseId: PID_PRESS, executionExerciseId: varAId, sourceRecordKey: 'rec_varA_w5',
    source: { week: 4, dayIndex: 0, calculatedAt: '2026-09-10T00:00:00.000Z' },
    target: { week: 5, dayIndex: 0 }, dimension: 'LOAD', previousValue: 80, appliedValue: 82, unit: 'KG',
    status: 'CONSUMED', sets: [{ effective: { load: 82, repsTarget: 10, rirTarget: 2 } }]
  };

  // Check Week 6 for Original: preserves 102.5 kg (does NOT become 82 kg!)
  var origEffW6 = effective.resolveEffective({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, pid: PID_PRESS, executionExerciseId: PID_PRESS,
    week: 6, dayIndex: 0, records: records, overlays: overlays, plan: BASE_PLAN, entries: {},
    baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(origEffW6.provenance, 'CARRIED_OVERLAY');
  assert.equal(origEffW6.sets[0].effective.load, 102.5, 'Original strictly preserves 102.5 kg without contamination from Variant A');

  // Check Week 7 for Variant B (first exposure): carriedBaseline returns empty, effective.load is null
  var varBEffW7 = effective.resolveEffective({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, pid: PID_PRESS, executionExerciseId: varBId,
    week: 7, dayIndex: 0, records: records, overlays: overlays, plan: BASE_PLAN, entries: {},
    baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(varBEffW7.provenance, 'BASE_PLAN');
  assert.equal(varBEffW7.sets[0].effective.load, null, 'Variant B does NOT adopt 102.5 kg from original or 82 kg from Variant A');

  // 3. Variant B executes and progresses: overlay CONSUMED at Week 9 (30 -> 32 kg)
  records['rec_varB_w9'] = {
    key: 'rec_varB_w9', clientId: CLIENT_AYRTON, planId: PLAN_ID, prescriptionExerciseId: PID_PRESS, executionExerciseId: varBId,
    state: 'CONSUMED', createdAt: '2026-09-20T00:00:00.000Z', source: { week: 8, dayIndex: 0, calculatedAt: '2026-09-20T00:00:00.000Z' },
    nextExposure: { week: 9, dayIndex: 0 }, lifecycle: { overlayKey: 'ovl_rec_varB_w9' }
  };
  overlays['ovl_rec_varB_w9'] = {
    key: 'ovl_rec_varB_w9', schema: 'vdsen-next-exposure-overlay-v1', clientId: CLIENT_AYRTON, planId: PLAN_ID,
    prescriptionExerciseId: PID_PRESS, executionExerciseId: varBId, sourceRecordKey: 'rec_varB_w9',
    source: { week: 8, dayIndex: 0, calculatedAt: '2026-09-20T00:00:00.000Z' },
    target: { week: 9, dayIndex: 0 }, dimension: 'LOAD', previousValue: 30, appliedValue: 32, unit: 'KG',
    status: 'CONSUMED', sets: [{ effective: { load: 32, repsTarget: 10, rirTarget: 2 } }]
  };

  // Check Week 10: Athlete returns to Variant A
  var varAEffW10 = effective.resolveEffective({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, pid: PID_PRESS, executionExerciseId: varAId,
    week: 10, dayIndex: 0, records: records, overlays: overlays, plan: BASE_PLAN, entries: {},
    baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(varAEffW10.provenance, 'CARRIED_OVERLAY');
  assert.equal(varAEffW10.sets[0].effective.load, 82, 'Variant A recovers its own baseline (82 kg) cleanly');

  // Check Week 10: Variant B preserves its own 32 kg
  var varBEffW10 = effective.resolveEffective({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, pid: PID_PRESS, executionExerciseId: varBId,
    week: 10, dayIndex: 0, records: records, overlays: overlays, plan: BASE_PLAN, entries: {},
    baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(varBEffW10.provenance, 'CARRIED_OVERLAY');
  assert.equal(varBEffW10.sets[0].effective.load, 32, 'Variant B preserves its own 32 kg');

  // Check Week 10: Original still preserves 102.5 kg
  var origEffW10 = effective.resolveEffective({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, pid: PID_PRESS, executionExerciseId: PID_PRESS,
    week: 10, dayIndex: 0, records: records, overlays: overlays, plan: BASE_PLAN, entries: {},
    baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(origEffW10.provenance, 'CARRIED_OVERLAY');
  assert.equal(origEffW10.sets[0].effective.load, 102.5, 'Original preserves 102.5 kg across all alternations');
});

// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA B & C: Rechazo de executionExerciseId falsificado / no autorizado
// ─────────────────────────────────────────────────────────────────────────────
test('T759-B_C: Rechazo en servidor de executionExerciseId falsificado o no autorizado aunque tenga formato :var:', () => {
  var forgedId = PID_PRESS + ':var:sentadilla_hack'; // Not in Press alternatives!
  var auth = vi.validateExecutionAuthorization(BASE_PLAN, PID_PRESS, forgedId);
  assert.equal(auth.ok, false);
  assert.equal(auth.reason, 'UNAUTHORIZED_ALTERNATIVE');

  var fakeRecord = {
    key: 'rec_forged_001', schema: 'vdsen-magnitude-shadow-v1', clientId: CLIENT_AYRTON, planId: PLAN_ID,
    prescriptionExerciseId: PID_PRESS, executionExerciseId: forgedId, state: 'PENDING',
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-09-02T12:00:00.000Z' },
    nextExposure: { week: 2, dayIndex: 0 },
    magnitude: {
      mode: 'SHADOW', numericApplyAllowed: false, schema: 'vdsen-magnitude-shadow-v1',
      methodologyFamily: 'VDSEN_EHRENSTEIN_APEKS', ruleAuthority: 'HEURISTIC_MAGNITUDE', evidenceLevel: 'C',
      ruleId: 'A', comparableExposureCount: 2, eligible: true,
      candidates: [{ dimension: 'LOAD', previousValue: 80, rawCandidate: 82, requestedValue: 82, appliedValue: 82, unit: 'KG', roundingReason: 'ROUNDED' }]
    }
  };

  var appPlan = consumer.planApplication({
    record: fakeRecord,
    context: {
      clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, plan: BASE_PLAN,
      trustedServerNumericApply: true, canaryScope: { enabled: true, clientIds: [CLIENT_AYRTON], prescriptionExerciseIds: [PID_PRESS] },
      equipmentResolution: { resolutionState: 'RESOLVED', equipmentId: 'eq-barbell', currentLoad: 80, requestedLoad: 82, realizableLoad: 82, unit: 'KG', roundingReason: 'EXACT_STEP', incrementSource: 'GYM_METADATA', incrementScope: 'GLOBAL', incrementRevision: 1, incrementConfiguredAt: '2026-09-01T00:00:00.000Z', incrementKind: 'STEP' }
    }
  });

  assert.equal(appPlan.wouldApply, false);
  assert.equal(appPlan.canApply, false);
  assert.ok(appPlan.blockers.includes('IDENTITY_UNRESOLVED'), 'Consumer blocks application of forged execution identity');
});

// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA D: Rechazo de identidad perteneciente a otro ejercicio del mismo cliente
// ─────────────────────────────────────────────────────────────────────────────
test('T759-D: Rechazo de identidad perteneciente a otro slot (SLOT_PID_MISMATCH)', () => {
  // Client attempts to evaluate squat variant under press slot
  var crossSlotId = PID_SQUAT + ':var:sentadilla_hack';
  var auth = vi.validateExecutionAuthorization(BASE_PLAN, PID_PRESS, crossSlotId);
  assert.equal(auth.ok, false);
  assert.equal(auth.reason, 'SLOT_PID_MISMATCH');

  // Policy rejects cross-slot PID
  var polRes = policy.evaluate({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, prescriptionExerciseId: PID_PRESS,
    executionExerciseId: crossSlotId, plan: BASE_PLAN,
    prescription: { prescriptionExerciseId: PID_PRESS, sets: BASE_PLAN.days[0].exercises[0].sets, repsRange: { min: 8, max: 12 } },
    exposures: []
  });
  assert.equal(polRes.eligible, false);
  assert.ok(polRes.reasonCodes.includes('UNAUTHORIZED_ALTERNATIVE'));
});

// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA E: Rechazo de identidad perteneciente a otro cliente
// ─────────────────────────────────────────────────────────────────────────────
test('T759-E: Rechazo de cliente foraneo (CLIENT_MISMATCH)', () => {
  var varAId = vi.deriveExecutionId(PID_PRESS, 'Press Inclinado con Barra', BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  var foreignRecord = {
    key: 'rec_foreign_001', schema: 'vdsen-magnitude-shadow-v1', clientId: CLIENT_OTHER, planId: PLAN_ID,
    prescriptionExerciseId: PID_PRESS, executionExerciseId: varAId, state: 'PENDING',
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-09-02T12:00:00.000Z' },
    nextExposure: { week: 2, dayIndex: 0 },
    magnitude: { mode: 'SHADOW', numericApplyAllowed: false, schema: 'vdsen-magnitude-shadow-v1', eligible: true, candidates: [{ dimension: 'LOAD', previousValue: 80, rawCandidate: 82, requestedValue: 82, appliedValue: 82, unit: 'KG' }] }
  };

  var appPlan = consumer.planApplication({
    record: foreignRecord,
    context: {
      clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, plan: BASE_PLAN,
      trustedServerNumericApply: true
    }
  });

  assert.equal(appPlan.wouldApply, false);
  assert.ok(appPlan.blockers.includes('CLIENT_MISMATCH'));
});

// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA F: Idempotencia y concurrencia por variante
// ─────────────────────────────────────────────────────────────────────────────
test('T759-F: Idempotencia y concurrencia de recomendaciones por variante', () => {
  var varAId = vi.deriveExecutionId(PID_PRESS, 'Press Inclinado con Barra', BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  var recs = {};
  // Recommendations in entries for both original and variant
  var entries = {
    'progrec_1_0': {
      calculatedAt: '2026-09-02T12:00:00.000Z',
      recommendations: [
        { prescriptionExerciseId: PID_PRESS, executionExerciseId: PID_PRESS, exerciseName: 'Press Convergente Inclinado', action: 'increase_load', newLoad: 102.5, newReps: 10 },
        { prescriptionExerciseId: PID_PRESS, executionExerciseId: varAId, exerciseName: 'Press Inclinado con Barra', action: 'increase_load', newLoad: 82, newReps: 10 }
      ]
    }
  };

  var mat1 = shadow.materializeRecords({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, plan: BASE_PLAN,
    entries: entries, records: recs, overlays: {}, at: '2026-09-02T13:00:00.000Z'
  });

  assert.equal(mat1.created.length, 2, 'Creates exactly 2 distinct records for original and variant');
  assert.equal(mat1.changed, true);

  // Second pass with same entries is strictly idempotent
  var mat2 = shadow.materializeRecords({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, plan: BASE_PLAN,
    entries: entries, records: mat1.records, overlays: {}, at: '2026-09-02T13:05:00.000Z'
  });

  assert.equal(mat2.changed, false, 'No change on idempotent second run');
  assert.equal(mat2.created.length, 0);
  assert.equal(mat2.staled.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA G: Prescripcion efectiva correcta tras cerrar y reabrir App Cliente
// ─────────────────────────────────────────────────────────────────────────────
test('T759-G: Prescripcion efectiva persistente al recargar estado en App Cliente', () => {
  var varAId = vi.deriveExecutionId(PID_PRESS, 'Press Inclinado con Barra', BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  var persistedOverlays = {
    ovl_rec_varA: {
      key: 'ovl_rec_varA', schema: 'vdsen-next-exposure-overlay-v1', clientId: CLIENT_AYRTON, planId: PLAN_ID,
      prescriptionExerciseId: PID_PRESS, executionExerciseId: varAId, sourceRecordKey: 'rec_varA',
      target: { week: 3, dayIndex: 0 }, dimension: 'LOAD', previousValue: 80, appliedValue: 82, unit: 'KG',
      status: 'APPLIED', sets: [{ effective: { load: 82, repsTarget: 10, rirTarget: 2 } }]
    }
  };
  var persistedRecords = {
    rec_varA: { key: 'rec_varA', clientId: CLIENT_AYRTON, planId: PLAN_ID, prescriptionExerciseId: PID_PRESS, executionExerciseId: varAId, state: 'APPLIED', createdAt: '2026-09-02T00:00:00.000Z', source: { week: 2, dayIndex: 0, calculatedAt: '2026-09-02T00:00:00.000Z' }, lifecycle: { overlayKey: 'ovl_rec_varA' } }
  };

  // Session 1: Client resolves effective prescription
  var session1 = effective.resolveEffective({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, pid: PID_PRESS, executionExerciseId: varAId,
    week: 3, dayIndex: 0, records: persistedRecords, overlays: persistedOverlays, plan: BASE_PLAN, entries: {},
    baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });

  // Client app restarts, reloads exact same JSON structures from storage
  var reloadedOverlays = JSON.parse(JSON.stringify(persistedOverlays));
  var reloadedRecords = JSON.parse(JSON.stringify(persistedRecords));
  var session2 = effective.resolveEffective({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, pid: PID_PRESS, executionExerciseId: varAId,
    week: 3, dayIndex: 0, records: reloadedRecords, overlays: reloadedOverlays, plan: BASE_PLAN, entries: {},
    baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });

  assert.deepEqual(session1, session2, 'Prescription after restart is 100% identical and deterministic');
  assert.equal(session2.appliedValue, 82);
});

// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA H: STOP individual y global desarma variantes por igual
// ─────────────────────────────────────────────────────────────────────────────
test('T759-H: STOP individual y global desarma variantes por igual', () => {
  var varAId = vi.deriveExecutionId(PID_PRESS, 'Press Inclinado con Barra', BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  var record = {
    key: 'rec_stop_001', schema: 'vdsen-magnitude-shadow-v1', clientId: CLIENT_AYRTON, planId: PLAN_ID,
    prescriptionExerciseId: PID_PRESS, executionExerciseId: varAId, state: 'PENDING',
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-09-02T12:00:00.000Z' }, nextExposure: { week: 2, dayIndex: 0 },
    magnitude: { mode: 'SHADOW', numericApplyAllowed: false, schema: 'vdsen-magnitude-shadow-v1', eligible: true, candidates: [{ dimension: 'LOAD', previousValue: 80, rawCandidate: 82, requestedValue: 82, appliedValue: 82, unit: 'KG' }] }
  };

  // 1. Global STOP: trustedServerNumericApply = false
  var globalStop = consumer.planApplication({
    record: record,
    context: { clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, plan: BASE_PLAN, trustedServerNumericApply: false }
  });
  assert.equal(globalStop.canApply, false);
  assert.ok(globalStop.blockers.includes('NUMERIC_APPLY_DISABLED'));

  // 2. Individual Canary STOP: client removed from canary
  var canaryStop = consumer.planApplication({
    record: record,
    context: {
      clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, plan: BASE_PLAN,
      trustedServerNumericApply: true, canaryScope: { enabled: true, clientIds: ['other-client'], prescriptionExerciseIds: [PID_PRESS] }
    }
  });
  assert.equal(canaryStop.canApply, false);
  assert.ok(canaryStop.blockers.includes('OUT_OF_CANARY_SCOPE'));
});

// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA I: Sustitución autorizada sin dos exposiciones: no progresar
// ─────────────────────────────────────────────────────────────────────────────
test('T759-I: Sustitución autorizada con solo 1 exposición comparable no progresa', () => {
  var varAId = vi.deriveExecutionId(PID_PRESS, 'Press Inclinado con Barra', BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  var subFrom = { prescriptionExerciseId: PID_PRESS, exerciseName: 'Press Convergente Inclinado' };

  var entries = {
    'log_1_0_0_s0': createEntry({ load: 80, reps: 10, rirReal: 3, executionExerciseId: varAId, exerciseNameSnapshot: 'Press Inclinado con Barra', substitutedFrom: subFrom }),
    'log_1_0_0_s1': createEntry({ load: 80, reps: 10, rirReal: 3, executionExerciseId: varAId, exerciseNameSnapshot: 'Press Inclinado con Barra', substitutedFrom: subFrom })
  };

  var exposures = policy.extractExposures(entries, varAId);
  assert.equal(exposures.length, 1, 'Only 1 exposure recorded');

  var polRes = policy.evaluate({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, prescriptionExerciseId: PID_PRESS, executionExerciseId: varAId,
    plan: BASE_PLAN, prescription: { prescriptionExerciseId: PID_PRESS, sets: BASE_PLAN.days[0].exercises[0].sets, repsRange: { min: 8, max: 12 } },
    exposures: exposures
  });

  assert.equal(polRes.eligible, false);
  assert.equal(polRes.comparableExposureCount, 1);
  assert.ok(polRes.reasonCodes.includes('INSUFFICIENT_COMPARABLE_EXPOSURES'));
});

// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA J: Transición PENDING -> APPLIED -> CONSUMED transaccional
// ─────────────────────────────────────────────────────────────────────────────
test('T759-J: Ciclo transaccional PENDING -> APPLIED -> CONSUMED por variante', () => {
  var varAId = vi.deriveExecutionId(PID_PRESS, 'Press Inclinado con Barra', BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');

  var record = {
    key: 'v1_test_trans_01', schema: 'vdsen-magnitude-shadow-v1', clientId: CLIENT_AYRTON, planId: PLAN_ID,
    prescriptionExerciseId: PID_PRESS, executionExerciseId: varAId, state: 'PENDING',
    source: { week: 2, dayIndex: 0, calculatedAt: '2026-09-10T12:00:00.000Z' }, nextExposure: { week: 3, dayIndex: 0 },
    magnitude: {
      mode: 'SHADOW', numericApplyAllowed: false, schema: 'vdsen-magnitude-shadow-v1',
      methodologyFamily: 'VDSEN_EHRENSTEIN_APEKS', ruleAuthority: 'HEURISTIC_MAGNITUDE', evidenceLevel: 'C',
      ruleId: 'A', comparableExposureCount: 2, eligible: true,
      candidates: [{ dimension: 'LOAD', previousValue: 80, rawCandidate: 82, requestedValue: 82, appliedValue: 82, unit: 'KG', roundingReason: 'ROUNDED' }]
    },
    revision: 1
  };

  // 1. Transition PENDING -> APPLIED
  var tApply = shadow.lifecycleTransition(record, 'APPLIED', {
    expectedRevision: 1, operationKey: 'op_apply_01', at: '2026-09-10T13:00:00.000Z',
    trustedServer: true, actorId: 'trusted-executor', reasonCode: 'APPLIED_BY_POLICY',
    patch: { overlayKey: 'ovl_v1_test_trans_01', appliedAt: '2026-09-10T13:00:00.000Z' }
  });

  assert.equal(tApply.ok, true);
  assert.equal(tApply.record.state, 'APPLIED');
  assert.equal(tApply.record.revision, 2);

  // 2. Transition APPLIED -> CONSUMED
  var tConsume = shadow.lifecycleTransition(tApply.record, 'CONSUMED', {
    expectedRevision: 2, operationKey: 'op_consume_01', at: '2026-09-17T10:00:00.000Z',
    trustedServer: true, actorId: 'trusted-executor', reasonCode: 'EXPOSURE_CONSUMED'
  });

  assert.equal(tConsume.ok, true);
  assert.equal(tConsume.record.state, 'CONSUMED');
  assert.equal(tConsume.record.revision, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA K: Ausencia de contaminación entre 10 clientes de prueba
// ─────────────────────────────────────────────────────────────────────────────
test('T759-K: Aislamiento estricto multi-tenant entre 10 clientes de prueba', () => {
  var clients = [];
  for (var i = 1; i <= 10; i++) {
    clients.push({
      clientId: 'client-cohort-' + i,
      planId: 'plan-' + i,
      load: 50 + i * 5,
      varLoad: 40 + i * 5
    });
  }

  clients.forEach(c => {
    var varId = vi.deriveExecutionId(PID_PRESS, 'Press Inclinado con Barra', BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
    var plan = Object.assign({}, BASE_PLAN, { clientId: c.clientId, id: c.planId });

    // Validate authorization for each client independently
    var auth = vi.validateExecutionAuthorization(plan, PID_PRESS, varId);
    assert.equal(auth.ok, true);
    assert.equal(auth.isAuthorized, true);

    // Cross check: client A's record evaluated in client B's context fails
    var otherClient = c.clientId === 'client-cohort-1' ? 'client-cohort-2' : 'client-cohort-1';
    var rec = {
      key: 'rec_' + c.clientId, schema: 'vdsen-magnitude-shadow-v1', clientId: c.clientId, planId: c.planId,
      prescriptionExerciseId: PID_PRESS, executionExerciseId: varId, state: 'PENDING',
      source: { week: 1, dayIndex: 0, calculatedAt: '2026-09-02T12:00:00.000Z' }, nextExposure: { week: 2, dayIndex: 0 },
      magnitude: { mode: 'SHADOW', numericApplyAllowed: false, schema: 'vdsen-magnitude-shadow-v1', eligible: true, candidates: [{ dimension: 'LOAD', previousValue: c.varLoad, rawCandidate: c.varLoad + 2, requestedValue: c.varLoad + 2, appliedValue: c.varLoad + 2, unit: 'KG' }] }
    };

    var crossApp = consumer.planApplication({
      record: rec,
      context: { clientId: otherClient, planId: c.planId, activePlanId: c.planId, plan: plan, trustedServerNumericApply: true }
    });
    assert.equal(crossApp.canApply, false);
    assert.ok(crossApp.blockers.includes('CLIENT_MISMATCH'), 'Multi-tenant isolation strictly enforced for client ' + c.clientId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA L: Compatibilidad T506, T689, T699 y T758
// ─────────────────────────────────────────────────────────────────────────────
test('T759-L: Compatibilidad armónica con T506, T689, T699 y T758', () => {
  // T506: entry with substitution keeps prescriptionExerciseId undefined, substitutedFrom populated
  var varAId = vi.deriveExecutionId(PID_PRESS, 'Press Inclinado con Barra', BASE_PLAN.days[0].exercises[0].alternatives, 'Press Convergente Inclinado');
  var subFrom = { prescriptionExerciseId: PID_PRESS, exerciseName: 'Press Convergente Inclinado', exerciseId: 'ex-press-conv' };
  var setLog = createEntry({ load: 80, executionExerciseId: varAId, exerciseNameSnapshot: 'Press Inclinado con Barra', substitutedFrom: subFrom });

  assert.equal(setLog.prescriptionExerciseId, undefined, 'T506 invariant: prescriptionExerciseId is undefined on substituted set');
  assert.equal(setLog.executionExerciseId, varAId, 'T758 invariant: executionExerciseId is decoupled');
  assert.deepEqual(setLog.substitutedFrom, subFrom);

  // T689: plan revision invalidates unconsumed overlays
  var revisedPlan = Object.assign({}, BASE_PLAN, { updatedAt: '2026-09-15T00:00:00.000Z' });
  var unconsumedOverlay = {
    key: 'ovl_rec_old', schema: 'vdsen-next-exposure-overlay-v1', clientId: CLIENT_AYRTON, planId: PLAN_ID,
    prescriptionExerciseId: PID_PRESS, executionExerciseId: varAId, sourceRecordKey: 'rec_old',
    target: { week: 3, dayIndex: 0 }, dimension: 'LOAD', previousValue: 80, appliedValue: 82, unit: 'KG', status: 'APPLIED',
    source: { week: 2, dayIndex: 0, calculatedAt: '2026-09-10T00:00:00.000Z' }, sets: [{ effective: { load: 82 } }]
  };
  var oldRecords = {
    rec_old: { key: 'rec_old', clientId: CLIENT_AYRTON, planId: PLAN_ID, prescriptionExerciseId: PID_PRESS, executionExerciseId: varAId, state: 'APPLIED', createdAt: '2026-09-10T00:00:00.000Z', source: { week: 2, dayIndex: 0, calculatedAt: '2026-09-10T00:00:00.000Z' }, lifecycle: { overlayKey: 'ovl_rec_old' } }
  };

  var effRevised = effective.resolveEffective({
    clientId: CLIENT_AYRTON, planId: PLAN_ID, activePlanId: PLAN_ID, pid: PID_PRESS, executionExerciseId: varAId,
    week: 3, dayIndex: 0, records: oldRecords, overlays: { ovl_rec_old: unconsumedOverlay }, plan: revisedPlan, entries: {},
    baseSets: BASE_PLAN.days[0].exercises[0].sets, unit: 'KG', canonicalOverlayRead: true
  });

  assert.equal(effRevised.provenance, 'BASE_PLAN');
  assert.equal(effRevised.reason, 'TARGET_INVALIDATED', 'T689 invariant: plan revision invalidates unconsumed overlay');
});
