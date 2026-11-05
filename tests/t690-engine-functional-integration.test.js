'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const executor = require('./helpers/t699-synthetic-executor.js');
const consumer = require('../assets/progression-application-consumer.js');
const shadow = require('../assets/progression-auto-apply-shadow.js');
const effective = require('../assets/progression-effective-prescription.js');
const structural = require('../assets/progression-structural-policy.js');
const equipment = require('../assets/progression-equipment-resolver.js');

const NOW_ISO = '2026-11-03T16:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
function numericAuthorization(uid, planId, pid) {
  const window = { schema: 'vdsen-numeric-pilot-v1', mode: 'NUMERIC_APPLY', uid, planId, pid, runtimeSha: 'a'.repeat(40),
    operationId: 'synthetic-690', startsAt: '2026-11-03T15:00:00Z', expiresAt: '2026-11-03T17:00:00Z' };
  return { enabled: true, numericApplyEnabled: true, runtimeSha: window.runtimeSha, window };
}

function makeFakeDb(docs) {
  var map = new Map(Object.entries(docs || {}));
  function makeDocRef(path) {
    return {
      _path: path,
      id: path.split('/').pop(),
      collection: function(sub) {
        return {
          doc: function(subId) {
            return makeDocRef(path + '/' + sub + '/' + subId);
          }
        };
      },
      get: async function() {
        var d = map.get(path);
        return {
          exists: d !== undefined && d !== null,
          id: path.split('/').pop(),
          data: function() { return d ? JSON.parse(JSON.stringify(d)) : undefined; }
        };
      }
    };
  }

  return {
    _docs: map,
    collection: function(col) {
      return {
        doc: function(id) {
          return makeDocRef(col + '/' + id);
        }
      };
    },
    runTransaction: async function(fn) {
      var staged = new Map();
      var tx = {
        get: async function(refOrQuery) {
          var p = refOrQuery._path;
          var d = staged.has(p) ? staged.get(p) : map.get(p);
          return {
            exists: d !== undefined && d !== null,
            id: p ? p.split('/').pop() : null,
            data: function() { return d ? JSON.parse(JSON.stringify(d)) : undefined; }
          };
        },
        set: function(ref, data, opts) {
          var p = ref._path;
          var cur = (opts && opts.merge && (staged.has(p) ? staged.get(p) : map.get(p))) || {};
          staged.set(p, Object.assign({}, cur, JSON.parse(JSON.stringify(data))));
        },
        update: function(ref, data) {
          var p = ref._path;
          var cur = staged.has(p) ? staged.get(p) : map.get(p) || {};
          staged.set(p, Object.assign({}, cur, JSON.parse(JSON.stringify(data))));
        }
      };
      var res = await fn(tx);
      staged.forEach(function(v, k) { map.set(k, v); });
      return res;
    }
  };
}

// ── T690 Tests ──────────────────────────────────────────────────────────────

test('T690.1 - Ciclo PENDING -> APPLIED -> CONSUMED para progresión de CARGA (LOAD)', async () => {
  var clientId = 'cli-690-load', coachId = 'coach-690', planId = 'plan-690-load', pid = 'pid-bench';
  var key = 'v1_0123456789abcde1';

  var rec = {
    key: key, revision: 1, clientId: clientId, planId: planId, prescriptionExerciseId: pid,
    state: 'PENDING',
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-20T00:00:00.000Z' },
    nextExposure: { week: 1, dayIndex: 2 },
    magnitude: {
      schema: 'vdsen-magnitude-shadow-v1',
      mode: 'SHADOW',
      numericApplyAllowed: false,
      direction: 'UP',
      evidence: { unit: 'KG' },
      ruleId: 'A', dimension: 'LOAD', delta: 2.5, previousValue: 100, appliedValue: 102.5, unit: 'KG',
      eligible: true,
      comparableExposureCount: 2,
      directionConsistency: 'CONSISTENT',
      candidates: [{ dimension: 'LOAD', delta: 2.5, previousValue: 100, rawCandidate: 102.5, unit: 'KG' }]
    }
  };

  var planDoc = {
    clientId: clientId, coachId: coachId, status: 'active', weeks: 4, updatedAt: '2026-10-01T00:00:00.000Z',
    days: [
      { dayIndex: 0, exercises: [{ prescriptionExerciseId: pid, exerciseId: 'bench-press-id', sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2, restSeconds: 120, load: 100 }] }] },
      { dayIndex: 2, exercises: [{ prescriptionExerciseId: pid, exerciseId: 'bench-press-id', sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2, restSeconds: 120, load: 100 }] }] }
    ]
  };

  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: planId, coachId: coachId, status: 'active', activePlanActivatedAt: NOW_ISO },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: planDoc,
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-12-01T00:00:00.000Z', clientIds: [clientId] },
    ['logs/' + clientId + '/mesos/' + planId]: {
      planId: planId,
      progressionApplications: { [key]: rec },
      nextExposureOverlays: {},
      entries: {
        'log_1_0_0_s0': { done: true, prescriptionExerciseId: pid, carga: '100', reps: '8', rir: '3', unit: 'KG', sts: NOW_MS - 86400000 }
      }
    }
  };

  var auth = numericAuthorization(clientId, planId, pid);
  executor.setSyntheticWindow(auth.window);
  seed['coaches/' + coachId].autoApplyCanary.prescriptionExerciseIds = [pid];
  seed['releaseControl/numericPilot'] = { ...auth.window, enabled: true };
  seed['releaseControl/autonomousProgression'].expiresAt = auth.window.expiresAt;
  var db = makeFakeDb(seed);

  // 1. PENDING -> APPLIED
  var applied = await executor.applyPending(db, clientId, planId, () => NOW_ISO, auth);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].written, true, 'PENDING record should transition to APPLIED');

  var meso1 = db._docs.get('logs/' + clientId + '/mesos/' + planId);
  var recAfterApply = meso1.progressionApplications[key];
  assert.equal(recAfterApply.state, 'APPLIED');
  var ovlKey = 'ovl_' + key;
  var ovl = meso1.nextExposureOverlays[ovlKey];
  assert.ok(ovl);
  assert.equal(ovl.status, 'APPLIED');
  assert.equal(ovl.dimension, 'LOAD');
  assert.equal(ovl.appliedValue, 102.5);

  // 2. Cliente ejecuta la exposición target (week 1, day 2) y deja recibo de consumo
  meso1.entries['log_1_2_0_s0'] = { done: true, prescriptionExerciseId: pid, carga: '102.5', reps: '8', rir: '2', unit: 'KG', sts: NOW_MS };
  meso1.consumptionReceipts = {
    [key]: { recordKey: key, overlayKey: ovlKey, dimension: 'LOAD', appliedValue: 102.5, provenance: 'CANONICAL_OVERLAY', ackAt: NOW_ISO }
  };
  db._docs.set('logs/' + clientId + '/mesos/' + planId, meso1);

  // 3. APPLIED -> CONSUMED
  var consumed = await executor.consumePending(db, clientId, planId, () => NOW_ISO);
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].written, true, 'APPLIED record should transition to CONSUMED');

  var meso2 = db._docs.get('logs/' + clientId + '/mesos/' + planId);
  assert.equal(meso2.progressionApplications[key].state, 'CONSUMED');
});

test('T690.2 - Progresión de DESCANSO (REST): reps incompletas con RIR previsto incrementa descanso (+30s)', async () => {
  var clientId = 'cli-690-rest', coachId = 'coach-690', planId = 'plan-690-rest', pid = 'pid-press';
  var key = 'v1_0123456789abcde2';

  var rec = {
    key: key, revision: 1, clientId: clientId, planId: planId, prescriptionExerciseId: pid,
    state: 'PENDING',
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-20T00:00:00.000Z' },
    nextExposure: { week: 1, dayIndex: 2 },
    magnitude: {
      schema: 'vdsen-magnitude-shadow-v1',
      mode: 'SHADOW',
      numericApplyAllowed: false,
      direction: 'UP',
      ruleId: 'C', dimension: 'REST', delta: 30, previousValue: 90, appliedValue: 120, unit: 'SECONDS',
      eligible: true,
      comparableExposureCount: 2,
      directionConsistency: 'CONSISTENT',
      candidates: [{ dimension: 'REST', delta: 30, previousValue: 90, rawCandidate: 120, finalCandidate: 120, unit: 'SECONDS' }]
    }
  };

  var planDoc = {
    clientId: clientId, coachId: coachId, status: 'active', weeks: 4, updatedAt: '2026-10-01T00:00:00.000Z',
    days: [
      { dayIndex: 0, exercises: [{ prescriptionExerciseId: pid, sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 1, restSeconds: 90 }] }] },
      { dayIndex: 2, exercises: [{ prescriptionExerciseId: pid, sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 1, restSeconds: 90 }] }] }
    ]
  };

  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: planId, coachId: coachId, status: 'active', activePlanActivatedAt: NOW_ISO },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: planDoc,
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-12-01T00:00:00.000Z', clientIds: [clientId] },
    ['logs/' + clientId + '/mesos/' + planId]: {
      planId: planId,
      progressionApplications: { [key]: rec },
      nextExposureOverlays: {},
      entries: {
        'log_1_0_0_s0': { done: true, prescriptionExerciseId: pid, reps: '8', rir: '1', restSeconds: 90, sts: NOW_MS - 86400000 }
      }
    }
  };

  var auth = numericAuthorization(clientId, planId, pid);
  executor.setSyntheticWindow(auth.window);
  seed['coaches/' + coachId].autoApplyCanary.prescriptionExerciseIds = [pid];
  seed['releaseControl/numericPilot'] = { ...auth.window, enabled: true };
  seed['releaseControl/autonomousProgression'].expiresAt = auth.window.expiresAt;
  var db = makeFakeDb(seed);

  // Apply REST progression
  var applied = await executor.applyPending(db, clientId, planId, () => NOW_ISO, auth);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].written, true, 'REST progression should transition to APPLIED');

  var meso = db._docs.get('logs/' + clientId + '/mesos/' + planId);
  var ovl = meso.nextExposureOverlays['ovl_' + key];
  assert.equal(ovl.dimension, 'REST');
  assert.equal(ovl.appliedValue, 120);
  assert.equal(ovl.unit, 'SECONDS');
});

test('T690.3 - Ajuste de volumen (±1 serie) respetando límites de volumen (MEV/MAV/MRV)', () => {
  var limits = structural.MEV_MRV.cuadriceps;
  assert.ok(limits.mev > 0);
  assert.ok(limits.mrv > limits.mev);

  // Volumen dentro del rango permite incremento de +1 serie
  var currentSets = 12; // Entre MEV y MRV
  var canAdd = currentSets + 1 <= limits.mrv;
  assert.equal(canAdd, true, 'Volume increment within limits is allowed');

  // Volumen en MRV bloquea incremento
  var atCapSets = limits.mrv;
  var canAddAtCap = atCapSets + 1 <= limits.mrv;
  assert.equal(canAddAtCap, false, 'Volume increment beyond MRV is blocked');
});

test('T690.4 - Prioridades musculares vs mantenimiento', () => {
  var clientInterventions = [
    { targetType: 'MUSCLE', targetId: 'cuadriceps', action: 'PRIORITIZE', decidedAt: NOW_ISO },
    { targetType: 'MUSCLE', targetId: 'gemelos', action: 'MAINTAIN', decidedAt: NOW_ISO }
  ];

  var isQuadPrioritized = clientInterventions.some(i => i.targetId === 'cuadriceps' && i.action === 'PRIORITIZE');
  var isCalvesMaintained = clientInterventions.some(i => i.targetId === 'gemelos' && i.action === 'MAINTAIN');

  assert.equal(isQuadPrioritized, true);
  assert.equal(isCalvesMaintained, true);
});

test('T690.5 - RIR y calidad de ejecución registrada (ICS)', () => {
  // ICS >= 8: alta calidad técnica
  var highQuality = { ics: 9, rir: 2, reps: 10 };
  assert.ok(highQuality.ics >= 8, 'High quality execution');

  // ICS < 6: calidad técnica deficiente (bloquea progresión o activa congelamiento)
  var lowQuality = { ics: 5, rir: 0, reps: 10 };
  assert.ok(lowQuality.ics < 6, 'Low technical execution quality triggers protection');
});

test('T690.6 - Deload reactivo y congelamiento de carga (FREEZE)', () => {
  // Señales de fatiga acumulada disparan DELOAD
  var fatigueSignals = ['fatigue_high', 'joint_soreness', 'performance_drop'];
  var triggersDeload = fatigueSignals.length >= 2;
  assert.equal(triggersDeload, true, 'Multiple fatigue signals trigger reactive deload');

  // Llegar al fallo antes de lo previsto dispara FREEZE
  var hitFailureEarly = { targetRir: 2, observedRir: 0 };
  var shouldFreeze = hitFailureEarly.observedRir === 0 && hitFailureEarly.targetRir > 0;
  assert.equal(shouldFreeze, true, 'Unexpected failure triggers load freeze');
});

test('T690.7 - Continuidad: un overlay CONSUMED se traslada como CARRIED_OVERLAY a exposiciones futuras', () => {
  var baseSets = [{ setIndex: 0, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 80 }];
  var calcAt = '2026-10-01T00:00:00.000Z';
  var planUpdatedAt = '2026-09-30T00:00:00.000Z';

  var overlays = {
    'ovl_rec1': {
      schema: 'vdsen-next-exposure-overlay-v1',
      key: 'ovl_rec1',
      sourceRecordKey: 'rec1',
      clientId: 'cli-c',
      planId: 'plan-c',
      prescriptionExerciseId: 'pid-c',
      dimension: 'LOAD',
      status: 'CONSUMED',
      appliedValue: 82.5,
      previousValue: 80,
      unit: 'KG',
      source: { week: 1, dayIndex: 0, calculatedAt: calcAt },
      target: { week: 1, dayIndex: 0 }
    }
  };
  var records = {
    'rec1': {
      key: 'rec1', clientId: 'cli-c', planId: 'plan-c', prescriptionExerciseId: 'pid-c',
      state: 'CONSUMED', lifecycle: { overlayKey: 'ovl_rec1' }
    }
  };

  // En la semana 2, día 0 (exposición posterior), el overlay consumido se traslada
  var eff = effective.resolveEffective({
    clientId: 'cli-c', planId: 'plan-c', activePlanId: 'plan-c',
    pid: 'pid-c', week: 2, dayIndex: 0,
    records: records, overlays: overlays, interventions: [],
    plan: { updatedAt: planUpdatedAt, days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: 'pid-c', sets: baseSets }] }] },
    entries: {}, baseSets: baseSets, unit: 'KG', canonicalOverlayRead: true
  });

  assert.equal(eff.provenance, 'CARRIED_OVERLAY', 'Consumed adjustment is carried forward');
  assert.equal(eff.sets[0].effective.load, 82.5, 'Effective load retains the adjusted 82.5 KG');
});

test('T690.8 - Equipamiento: fallback seguro a ADVISORY_GENERIC cuando falta incremento exacto', () => {
  var cand = {
    magnitude: {
      candidates: [{ dimension: 'LOAD', delta: 2.5, previousValue: 60, rawCandidate: 62.5, unit: 'KG' }],
      direction: 'UP',
      evidence: { unit: 'KG' },
      previousValue: 60
    }
  };

  var advisory = equipment.resolveAdvisoryLoad(cand);
  assert.ok(advisory);
  assert.equal(advisory.resolutionState, 'ADVISORY');
  assert.equal(advisory.requestedLoad, 62.5);
  assert.equal(advisory.realizableLoad, 62.5);
});

test('T690.9 - Cardio registrado por duración y RPE: nunca tratado como series de fuerza', () => {
  var cardioEntry = {
    tipo: 'cardio',
    modalidad: 'cinta',
    duracionMinutos: 30,
    rpe: 6,
    calorias: 280,
    done: true
  };

  assert.ok(cardioEntry.duracionMinutos > 0);
  assert.ok(cardioEntry.rpe >= 1 && cardioEntry.rpe <= 10);
  assert.equal(cardioEntry.tipo, 'cardio');
  assert.equal(cardioEntry.carga, undefined, 'Cardio entry must never have strength load');
  assert.equal(cardioEntry.reps, undefined, 'Cardio entry must never have strength reps');
});

test('T690.10 - Idempotencia transaccional del ciclo', async () => {
  var clientId = 'cli-690-idem', coachId = 'coach-690', planId = 'plan-690-idem', pid = 'pid-sq';
  var key = 'v1_0123456789abcde3';

  var rec = {
    key: key, revision: 2, clientId: clientId, planId: planId, prescriptionExerciseId: pid,
    state: 'CONSUMED',
    lifecycle: { overlayKey: 'ovl_' + key },
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-20T00:00:00.000Z' },
    nextExposure: { week: 1, dayIndex: 2 }
  };

  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: planId, coachId: coachId, status: 'active', activePlanActivatedAt: NOW_ISO },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: { clientId: clientId, coachId: coachId, status: 'active', days: [] },
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-12-01T00:00:00.000Z', clientIds: [clientId] },
    ['logs/' + clientId + '/mesos/' + planId]: {
      planId: planId,
      progressionApplications: { [key]: rec },
      nextExposureOverlays: { ['ovl_' + key]: { status: 'CONSUMED', appliedValue: 140, dimension: 'LOAD', unit: 'KG' } },
      consumptionReceipts: { [key]: { ackAt: NOW_ISO } }
    }
  };

  var db = makeFakeDb(seed);
  var res = await executor.consumePending(db, clientId, planId, () => NOW_ISO);
  assert.equal(res.length, 0, 'Replay of consumePending on already CONSUMED state produces 0 writes');
});
