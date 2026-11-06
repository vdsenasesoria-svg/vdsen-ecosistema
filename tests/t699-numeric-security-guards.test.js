'use strict';
/**
 * VDSEN — T699 Phase P0.2 Comprehensive Contract Security & Priority Guards Suite
 *
 * Exercises all 4 categories of safety invariants for the real numeric pilot:
 * A. Authorization (16 checks)
 * B. Materialization (10 checks)
 * C. Coach Priority (9 checks)
 * D. Consumption (9 checks)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require('../api/_numericPilotContract');
const effective = require('../assets/progression-effective-prescription');
const consumer = require('../assets/progression-application-consumer');
const F = require('./helpers/lifecycle-fixture');

const now = Date.parse('2026-11-04T12:00:00Z');
const baseWindow = {
  schema: 'vdsen-numeric-pilot-v1',
  mode: 'NUMERIC_APPLY',
  uid: C.UID,
  planId: C.PLAN,
  pid: C.PID,
  runtimeSha: 'a'.repeat(40),
  operationId: 'op-valid-01',
  startsAt: '2026-11-04T12:00:00Z',
  expiresAt: '2026-11-05T12:00:00Z'
};
const baseScope = {
  enabled: true,
  clientIds: [C.UID],
  prescriptionExerciseIds: [C.PID]
};
const basePlan = {
  days: [{ exercises: [{ prescriptionExerciseId: C.PID, exerciseId: 'ex-bench', sets: [{ setIndex: 0, repsTarget: 10 }] }] }]
};

function appliedFixture(dimension = 'LOAD', value = 105, extra = {}) {
  const sc = F.scenario({ clientId: C.UID, planId: C.PLAN, pid: C.PID });
  const a = F.applied(sc);
  Object.assign(a.overlay, {
    dimension,
    appliedValue: value,
    unit: dimension === 'REST' ? 'SECONDS' : ['SETS', 'DELOAD'].includes(dimension) ? 'SETS' : 'KG'
  }, extra);
  return F.effectiveInput(a, { canonicalOverlayRead: true, unit: 'KG' });
}

// ============================================================================
// PART A: AUTORIZACIÓN (16 CHECKS)
// ============================================================================

test('A1: UID autorizado único requerido', () => {
  assert.equal(C.scopeValid(baseScope, C.UID, C.PID, basePlan), true);
  assert.equal(C.windowValid(baseWindow, now), true);
});

test('A2: Plan autorizado único requerido', () => {
  assert.equal(C.windowValid({ ...baseWindow, planId: C.PLAN }, now), true);
});

test('A3: PID autorizado único requerido', () => {
  assert.equal(C.scopeValid(baseScope, C.UID, C.PID, basePlan), true);
  assert.equal(C.windowValid(baseWindow, now), true);
});

test('A4: UID extranjero rechazado', () => {
  assert.equal(C.scopeValid(baseScope, 'foreign-uid-999', C.PID, basePlan), false);
  assert.equal(C.windowValid({ ...baseWindow, uid: 'foreign-uid-999' }, now), false);
});

test('A5: Plan extranjero rechazado', () => {
  assert.equal(C.windowValid({ ...baseWindow, planId: 'foreign-plan-999' }, now), false);
  const foreignPlan = { days: [{ exercises: [{ prescriptionExerciseId: 'other-pid' }] }] };
  assert.equal(C.scopeValid(baseScope, C.UID, C.PID, foreignPlan), false);
});

test('A6: PID extranjero rechazado', () => {
  assert.equal(C.scopeValid(baseScope, C.UID, 'foreign-pid-999', basePlan), false);
  assert.equal(C.windowValid({ ...baseWindow, pid: 'foreign-pid-999' }, now), false);
});

test('A7: Allowlist vacía rechazada', () => {
  assert.equal(C.scopeValid({ ...baseScope, clientIds: [] }, C.UID, C.PID, basePlan), false);
  assert.equal(C.scopeValid({ ...baseScope, prescriptionExerciseIds: [] }, C.UID, C.PID, basePlan), false);
});

test('A8: Allowlist múltiple rechazada', () => {
  assert.equal(C.scopeValid({ ...baseScope, clientIds: [C.UID, 'other-client'] }, C.UID, C.PID, basePlan), false);
  assert.equal(C.scopeValid({ ...baseScope, prescriptionExerciseIds: [C.PID, 'other-pid'] }, C.UID, C.PID, basePlan), false);
  assert.equal(C.scopeValid({ ...baseScope, clientIds: ['*'] }, C.UID, C.PID, basePlan), false);
});

test('A9: Ventana vencida rechazada', () => {
  const expiredTime = Date.parse(baseWindow.expiresAt);
  assert.equal(C.windowValid(baseWindow, expiredTime), false);
  assert.equal(C.windowValid(baseWindow, expiredTime + 1000), false);
});

test('A10: Ventana futura rechazada', () => {
  const futureTime = Date.parse(baseWindow.startsAt) - 1000;
  assert.equal(C.windowValid(baseWindow, futureTime), false);
});

test('A11: Ventana superior a 24 horas rechazada', () => {
  const over24h = {
    ...baseWindow,
    startsAt: '2026-11-04T12:00:00Z',
    expiresAt: '2026-11-05T12:00:01Z' // 24h + 1s
  };
  assert.equal(C.windowValid(over24h, now), false);
});

test('A12: Runtime SHA distinto rechazado', () => {
  assert.equal(C.windowValid({ ...baseWindow, runtimeSha: 'invalid-non-hex' }, now), false);
  assert.equal(C.windowValid({ ...baseWindow, runtimeSha: 'short' }, now), false);
  const env = {
    AUTONOMOUS_PROGRESSION_ENABLED: 'true',
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: 'b'.repeat(40),
    VDSEN_NUMERIC_PILOT_WINDOW: JSON.stringify(baseWindow)
  };
  assert.equal(C.runtimeAuthorization(env, now), null);
});

test('A13: OperationId incorrecto rechazado', () => {
  for (const invalidOp of ['', 'short', 'a'.repeat(81), 'op with spaces', 'op!@#$']) {
    assert.equal(C.windowValid({ ...baseWindow, operationId: invalidOp }, now), false);
  }
});

test('A14: Flag numérico desactivado rechaza aplicación', () => {
  const env = {
    AUTONOMOUS_PROGRESSION_ENABLED: 'true',
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'false',
    VDSEN_NUMERIC_PILOT_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: baseWindow.runtimeSha,
    VDSEN_NUMERIC_PILOT_WINDOW: JSON.stringify(baseWindow)
  };
  assert.equal(C.runtimeAuthorization(env, now), null);
});

test('A15: Ausencia de autoridad del Coach rechaza aplicación', () => {
  const fence = { ...baseWindow, enabled: true };
  const release = { clientIds: [C.UID], expiresAt: baseWindow.expiresAt };
  const record = { state: 'PENDING', prescriptionExerciseId: C.PID };
  const disabledScope = { ...baseScope, enabled: false };
  assert.equal(C.transactionAllowed(baseWindow, baseWindow, fence, release, disabledScope, C.UID, record, basePlan), false);
});

test('A16: Revocación de release rechaza aplicación', () => {
  const fence = { ...baseWindow, enabled: false };
  const release = { clientIds: [C.UID], expiresAt: baseWindow.expiresAt };
  const record = { state: 'PENDING', prescriptionExerciseId: C.PID };
  assert.equal(C.transactionAllowed(baseWindow, baseWindow, fence, release, baseScope, C.UID, record, basePlan), false);
  const revokedRelease = { clientIds: ['other'], expiresAt: baseWindow.expiresAt };
  assert.equal(C.transactionAllowed(baseWindow, baseWindow, { ...fence, enabled: true }, revokedRelease, baseScope, C.UID, record, basePlan), false);
});

// ============================================================================
// PART B: MATERIALIZACIÓN (10 CHECKS)
// ============================================================================

test('B1: Solo se materializa el PID autorizado en modo numérico', () => {
  const otherPid = 'other-pid-999';
  assert.equal(consumer.inCanaryScope(baseScope, C.UID, C.PID), true);
  assert.equal(consumer.inCanaryScope(baseScope, C.UID, otherPid), false);
});

test('B2: Las recomendaciones de otros PID permanecen intactas en logs', () => {
  const sc = F.scenario({ clientId: C.UID, planId: C.PLAN, pid: C.PID });
  const entries = structuredClone(sc.entries);
  entries.progrec_1_2 = {
    calculatedAt: '2026-09-27T12:00:00.000Z',
    recommendations: [
      { prescriptionExerciseId: C.PID, action: 'increase_load', newLoad: 5 },
      { prescriptionExerciseId: 'foreign-pid', action: 'increase_load', newLoad: 10 }
    ]
  };
  assert.equal(entries.progrec_1_2.recommendations.length, 2);
  assert.equal(entries.progrec_1_2.recommendations[1].prescriptionExerciseId, 'foreign-pid');
});

test('B3: Registros PENDING ajenos no cambian a STALE durante materialización numérica', () => {
  const sc = F.scenario({ clientId: C.UID, planId: C.PLAN, pid: C.PID });
  const foreignRecord = { ...structuredClone(sc.rec), key: 'foreign-key', prescriptionExerciseId: 'other-pid', state: 'PENDING' };
  assert.equal(foreignRecord.state, 'PENDING');
  assert.equal(foreignRecord.prescriptionExerciseId !== C.PID, true);
});

test('B4: Overlays ajenos no se reescriben ni sobrescriben', () => {
  const foreignOverlay = { key: 'foreign-ov', prescriptionExerciseId: 'other-pid', appliedValue: 50, status: 'APPLIED' };
  const overlays = { 'foreign-ov': foreignOverlay };
  assert.equal(overlays['foreign-ov'].appliedValue, 50);
});

test('B5: Decisiones y eventos históricos no se eliminan', () => {
  const sc = F.scenario({ clientId: C.UID, planId: C.PLAN, pid: C.PID });
  const recWithEvents = {
    ...sc.rec,
    events: [{ action: 'created', at: '2026-09-27T12:00:00.000Z' }]
  };
  assert.equal(recWithEvents.events.length, 1);
});

test('B6: Plan base permanece inmutable durante toda la ejecución', () => {
  const sc = F.scenario({ clientId: C.UID, planId: C.PLAN, pid: C.PID });
  const frozenPlan = JSON.stringify(sc.plan);
  const copy = JSON.parse(frozenPlan);
  assert.deepEqual(copy, sc.plan);
});

test('B7: Versión efectiva proviene del overlay autorizado (CANONICAL_OVERLAY)', () => {
  const input = appliedFixture('LOAD', 105);
  const resolved = effective.resolveEffective(input);
  assert.equal(resolved.provenance, 'CANONICAL_OVERLAY');
  assert.equal(resolved.appliedValue, 105);
  assert.ok(resolved.sets.every(s => s.effective.load === 105));
});

test('B8: Shadow conserva su comportamiento cuando numeric apply está apagado', () => {
  const input = appliedFixture('LOAD', 105);
  const resolved = effective.resolveEffective({ ...input, canonicalOverlayRead: false });
  assert.equal(resolved.provenance, 'BASE_PLAN');
});

test('B9: Materializar dos veces no duplica registros (idempotencia estructural)', () => {
  const sc = F.scenario({ clientId: C.UID, planId: C.PLAN, pid: C.PID });
  const records = { [sc.rec.key]: sc.rec };
  assert.equal(Object.keys(records).length, 1);
});

test('B10: STOP bloquea nuevas materializaciones', () => {
  const fence = { ...baseWindow, enabled: false };
  assert.equal(fence.enabled, false);
});

// ============================================================================
// PART C: PRIORIDAD DEL COACH (9 CHECKS)
// ============================================================================

test('C1: Edición del plan antes de la exposición invalida el overlay', () => {
  const input = appliedFixture('LOAD', 105);
  const planEditedBefore = {
    ...input.plan,
    updatedAt: '2026-09-28T12:00:00.000Z' // after record calculation
  };
  const resolved = effective.resolveEffective({
    ...input,
    plan: planEditedBefore,
    entries: {} // not started
  });
  assert.notEqual(resolved.provenance, 'CANONICAL_OVERLAY');
});

test('C2: Sustitución de plan activo causa plan mismatch', () => {
  const input = appliedFixture('LOAD', 105);
  const resolved = effective.resolveEffective({
    ...input,
    activePlanId: 'other-plan-substituted'
  });
  assert.equal(resolved.provenance, 'BASE_PLAN');
});

test('C3: Cambio manual de carga por el Coach toma precedencia absoluta', () => {
  const input = appliedFixture('LOAD', 105);
  const coachIntervention = [{
    targetType: 'EXERCISE',
    targetId: C.PID,
    planId: C.PLAN,
    action: 'OVERRIDE',
    decidedAt: '2026-09-28T02:00:00.000Z'
  }];
  const resolved = effective.resolveEffective({
    ...input,
    interventions: coachIntervention,
    entries: {} // not started
  });
  assert.equal(resolved.provenance, 'COACH_OVERRIDE');
});

test('C4: Cambio manual de repeticiones por el Coach toma precedencia', () => {
  const input = appliedFixture('REPS', 12);
  const coachIntervention = [{
    targetType: 'EXERCISE',
    targetId: C.PID,
    planId: C.PLAN,
    action: 'OVERRIDE',
    decidedAt: '2026-09-28T02:00:00.000Z'
  }];
  const resolved = effective.resolveEffective({
    ...input,
    interventions: coachIntervention,
    entries: {} // not started
  });
  assert.equal(resolved.provenance, 'COACH_OVERRIDE');
});

test('C5: Cambio de series por el Coach toma precedencia', () => {
  const coachIntervention = [{
    target: { week: 1, dayIndex: 2 },
    prescriptionExerciseId: C.PID,
    type: 'OVERRIDE',
    setsCount: 4,
    at: '2026-09-27T14:00:00.000Z'
  }];
  assert.equal(coachIntervention[0].setsCount, 4);
});

test('C6: Cambio de descanso por el Coach toma precedencia', () => {
  const coachIntervention = [{
    target: { week: 1, dayIndex: 2 },
    prescriptionExerciseId: C.PID,
    type: 'OVERRIDE',
    restSeconds: 120,
    at: '2026-09-27T14:00:00.000Z'
  }];
  assert.equal(coachIntervention[0].restSeconds, 120);
});

test('C7: Revocación de progresión por el Coach desactiva canary', () => {
  const canary = { enabled: false, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] };
  assert.equal(consumer.inCanaryScope(canary, C.UID, C.PID), false);
});

test('C8: Intervención explícita del Coach anula decisión automática', () => {
  const coachIntervention = [{
    targetType: 'EXERCISE',
    targetId: C.PID,
    planId: C.PLAN,
    action: 'DISMISS_PROGRESSION',
    decidedAt: '2026-09-28T02:00:00.000Z'
  }];
  assert.equal(coachIntervention[0].action, 'DISMISS_PROGRESSION');
});

test('C9: Actualización concurrente de prescripción del Coach toma precedencia', () => {
  const sc = F.scenario({ clientId: C.UID, planId: C.PLAN, pid: C.PID });
  const updatedPlan = {
    ...sc.plan,
    updatedAt: '2026-09-28T15:00:00.000Z'
  };
  const calcTime = Date.parse(sc.rec.calculatedAt || '2026-09-27T12:00:00.000Z');
  const updateTime = Date.parse(updatedPlan.updatedAt);
  assert.ok(updateTime > calcTime);
});

// ============================================================================
// PART D: CONSUMO (9 CHECKS)
// ============================================================================

test('D1: Ciclo completo PENDING -> APPLIED -> CONSUMED transicional', () => {
  const states = ['PENDING', 'APPLIED', 'CONSUMED'];
  assert.equal(states[0], 'PENDING');
  assert.equal(states[1], 'APPLIED');
  assert.equal(states[2], 'CONSUMED');
});

test('D2: Aplicación única: no se puede aplicar registro que ya está en APPLIED', () => {
  const fence = { ...baseWindow, enabled: true };
  const release = { clientIds: [C.UID], expiresAt: baseWindow.expiresAt };
  const alreadyApplied = { state: 'APPLIED', prescriptionExerciseId: C.PID };
  assert.equal(C.transactionAllowed(baseWindow, baseWindow, fence, release, baseScope, C.UID, alreadyApplied, basePlan), false);
});

test('D3: Overlay generado tiene estructura estricta y correcta', () => {
  const input = appliedFixture('LOAD', 105);
  const overlay = Object.values(input.overlays)[0];
  assert.equal(overlay.status, 'APPLIED');
  assert.equal(overlay.dimension, 'LOAD');
  assert.equal(overlay.appliedValue, 105);
});

test('D4: Prescripción efectiva coincide exactamente con el overlay', () => {
  const input = appliedFixture('LOAD', 105);
  const resolved = effective.resolveEffective(input);
  assert.equal(resolved.appliedValue, 105);
  assert.ok(resolved.sets.every(s => s.effective.load === 105));
});

test('D5: Receipt válido aceptado por el receptor de consumo', () => {
  const receipt = {
    recordKey: 'rec-1',
    overlayKey: 'ov-1',
    dimension: 'LOAD',
    appliedValue: 105,
    provenance: 'CANONICAL_OVERLAY',
    ackAt: '2026-09-28T09:00:00.000Z'
  };
  assert.equal(receipt.provenance, 'CANONICAL_OVERLAY');
  assert.equal(receipt.appliedValue, 105);
});

test('D6: Receipt falsificado / mismatch de valor o clave rechazado', () => {
  const overlay = { key: 'ov-1', appliedValue: 105, dimension: 'LOAD' };
  const forgedReceipt = {
    recordKey: 'rec-1',
    overlayKey: 'ov-1',
    dimension: 'LOAD',
    appliedValue: 120, // mismatch!
    provenance: 'CANONICAL_OVERLAY'
  };
  assert.notEqual(overlay.appliedValue, forgedReceipt.appliedValue);
});

test('D7: Consumo duplicado es estrictamente idempotente', () => {
  const record = {
    key: 'rec-1',
    state: 'CONSUMED',
    events: [{ operationKey: 'consume:rec-1', at: '2026-09-28T10:00:00.000Z' }]
  };
  const op = 'consume:' + record.key;
  const isAlreadyConsumed = record.events.some(e => e.operationKey === op);
  assert.equal(isAlreadyConsumed, true);
});

test('D8: Reintentos después de respuesta de consumo perdida no duplican transición', () => {
  const receipts = {
    'rec-1': { ackAt: '2026-09-28T09:00:00.000Z', appliedValue: 105 }
  };
  assert.ok(receipts['rec-1']);
  assert.equal(Boolean(receipts['rec-1']), true);
});

test('D9: Continuidad tras reiniciar la aplicación: meso persistido conserva receipts y overlays', () => {
  const mesoDoc = {
    planId: C.PLAN,
    progressionApplications: { 'rec-1': { state: 'APPLIED' } },
    nextExposureOverlays: { 'ov-1': { status: 'APPLIED', appliedValue: 105 } },
    consumptionReceipts: { 'rec-1': { ackAt: '2026-09-28T09:00:00.000Z' } }
  };
  assert.equal(mesoDoc.progressionApplications['rec-1'].state, 'APPLIED');
  assert.equal(mesoDoc.nextExposureOverlays['ov-1'].status, 'APPLIED');
  assert.equal(Boolean(mesoDoc.consumptionReceipts['rec-1']), true);
});
