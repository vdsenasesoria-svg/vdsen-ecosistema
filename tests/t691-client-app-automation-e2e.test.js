'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const executor = require('../api/_autonomousProgression.js');
const eligibility = require('../api/_clientEligibility.js');
const effective = require('../assets/progression-effective-prescription.js');
const consumer = require('../assets/progression-application-consumer.js');
const shadow = require('../assets/progression-auto-apply-shadow.js');

const T0_ISO = '2026-11-03T10:00:00.000Z';
const T0_MS = Date.parse(T0_ISO);
const T1_ISO = '2026-11-03T14:00:00.000Z';
const T1_MS = Date.parse(T1_ISO);
const T2_ISO = '2026-11-03T18:00:00.000Z';
const T2_MS = Date.parse(T2_ISO);

function makeFakeDb(initialDocs) {
  var map = new Map(Object.entries(initialDocs || {}));
  function makeDocRef(path) {
    return {
      _path: path,
      id: path.split('/').pop(),
      collection: function(sub) {
        return {
          doc: function(subId) {
            return makeDocRef(path + '/' + sub + '/' + subId);
          },
          orderBy: function() {
            return {
              limit: function() {
                return {
                  _path: path + '/' + sub,
                  _isQuery: true,
                  get: async function() {
                    var docs = [];
                    map.forEach(function(val, key) {
                      if (key.startsWith(path + '/' + sub + '/')) {
                        docs.push({
                          id: key.split('/').pop(),
                          data: function() { return JSON.parse(JSON.stringify(val)); }
                        });
                      }
                    });
                    return { docs: docs };
                  }
                };
              }
            };
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
          if (refOrQuery._isQuery && typeof refOrQuery.get === 'function') {
            return refOrQuery.get();
          }
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

// ── T691 End-to-End Suite ───────────────────────────────────────────────────

test('T691 — Circuito integral E2E: Coach prescribe -> Cliente ejecuta -> Motor progresa -> App actualiza -> Consumo único -> Continuidad', async () => {
  var clientId = 'client_ana_691';
  var coachId = 'coach_marcos_691';
  var planId = 'plan_fuerza_691';
  var pid = 'pid_squat_691';
  var exerciseId = 'squat_olympic_bar_691';

  // ── 1. Coach prescribe y activa ───────────────────────────────────────────
  var baseSets = [
    { setIndex: 0, repsTarget: 8, rirTarget: 2, restSeconds: 120, load: 100 }
  ];

  var planDoc = {
    clientId: clientId,
    coachId: coachId,
    status: 'active',
    weeks: 4,
    updatedAt: T0_ISO,
    days: [
      { dayIndex: 0, exercises: [{ prescriptionExerciseId: pid, exerciseId: exerciseId, sets: baseSets }] },
      { dayIndex: 2, exercises: [{ prescriptionExerciseId: pid, exerciseId: exerciseId, sets: baseSets }] }
    ]
  };

  var clientDoc = {
    uid: clientId,
    displayName: 'Ana Atleta',
    role: 'client',
    coachId: coachId,
    activePlanId: planId,
    activePlanActivatedAt: T0_ISO,
    status: 'active',
    coachInterventions: []
  };

  var coachDoc = {
    uid: coachId,
    displayName: 'Marcos Coach',
    autoApplyCanary: {
      enabled: true,
      clientIds: [clientId],
      prescriptionExerciseIds: []
    }
  };

  var releaseDoc = {
    schema: 'vdsen-autonomous-release-v1',
    enabled: true,
    expiresAt: '2026-12-01T00:00:00.000Z',
    clientIds: [clientId]
  };

  var db = makeFakeDb({
    ['clients/' + clientId]: clientDoc,
    ['coaches/' + coachId]: coachDoc,
    ['plans/' + planId]: planDoc,
    ['releaseControl/autonomousProgression']: releaseDoc,
    ['logs/' + clientId]: { planId: planId },
    ['logs/' + clientId + '/mesos/' + planId]: { planId: planId, entries: {}, progressionApplications: {}, nextExposureOverlays: {}, consumptionReceipts: {} }
  });

  // ── 2. Cliente recibe prescripción efectiva inicial ────────────────────────
  var eff0 = effective.resolveEffective({
    clientId: clientId, planId: planId, activePlanId: planId,
    pid: pid, week: 1, dayIndex: 0,
    records: {}, overlays: {}, interventions: [],
    plan: planDoc, entries: {}, baseSets: baseSets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(eff0.provenance, 'BASE_PLAN');
  assert.equal(eff0.sets[0].effective.load, 100);
  assert.equal(eff0.sets[0].effective.repsTarget, 8);

  // ── 3. Cliente ejecuta y registra datos reales (Semana 1, Día 0) ───────────
  var mesoRef = db.collection('logs').doc(clientId).collection('mesos').doc(planId);
  var mesoSnap = await mesoRef.get();
  var mesoData = mesoSnap.data();

  // Cliente registra serie completada: 100 kg x 8 reps @ RIR 3 (mejor de lo previsto RIR 2)
  mesoData.entries['log_1_0_0_s0'] = {
    done: true,
    prescriptionExerciseId: pid,
    carga: '100',
    reps: '8',
    rir: '3',
    unit: 'KG',
    sts: T1_MS
  };
  // Cliente escribe el marcador autoritativo de sesión
  db._docs.set('logs/' + clientId + '/starts/' + planId + '_1_0_0', {
    planId: planId,
    week: 1,
    dayIndex: 0,
    exerciseIndex: 0,
    setKey: 'log_1_0_0_s0',
    at: T1_ISO
  });
  db._docs.set('logs/' + clientId + '/mesos/' + planId, mesoData);

  // ── 4. Validación de elegibilidad e integridad ─────────────────────────────
  var clientEval = eligibility.evaluateClientEligibility({
    clientId: clientId,
    client: clientDoc,
    plan: planDoc,
    requestedPlanId: planId,
    meso: mesoData,
    root: { planId: planId },
    entries: mesoData.entries,
    starts: {
      [planId + '_1_0_0']: { planId: planId, week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: T1_ISO }
    },
    releaseDoc: releaseDoc,
    coachDoc: coachDoc,
    now: T1_ISO
  });
  assert.equal(clientEval.eligible, true, 'Active client must be verified as eligible');

  // ── 5. El motor calcula y aplica la progresión permitida ───────────────────
  // Simulamos un candidato de progresión canónico (Regla A: +2.5 kg por reserva de RIR)
  var recordKey = 'v1_0123456789abcfe1';
  var progressionRecord = {
    key: recordKey,
    revision: 1,
    clientId: clientId,
    planId: planId,
    prescriptionExerciseId: pid,
    state: 'PENDING',
    source: { week: 1, dayIndex: 0, calculatedAt: T1_ISO },
    nextExposure: { week: 1, dayIndex: 2 },
    magnitude: {
      schema: 'vdsen-magnitude-shadow-v1',
      mode: 'SHADOW',
      numericApplyAllowed: false,
      direction: 'UP',
      evidence: { unit: 'KG' },
      ruleId: 'A',
      dimension: 'LOAD',
      delta: 2.5,
      previousValue: 100,
      appliedValue: 102.5,
      unit: 'KG',
      eligible: true,
      comparableExposureCount: 2,
      directionConsistency: 'CONSISTENT',
      candidates: [{ dimension: 'LOAD', delta: 2.5, previousValue: 100, rawCandidate: 102.5, unit: 'KG' }]
    }
  };

  mesoData.progressionApplications[recordKey] = progressionRecord;
  db._docs.set('logs/' + clientId + '/mesos/' + planId, mesoData);

  // Isolated synthetic authority keeps this general-engine fixture independent of the pilot identity.
  var window = { schema: 'vdsen-numeric-pilot-v1', mode: 'NUMERIC_APPLY', uid: clientId, planId, pid,
    runtimeSha: 'a'.repeat(40), operationId: 'synthetic-691', startsAt: '2026-11-03T13:00:00Z', expiresAt: '2026-11-03T19:00:00Z' };
  var syntheticExecutor = require('./helpers/t699-synthetic-executor.js').createSyntheticExecutor(window);
  db._docs.get('coaches/' + coachId).autoApplyCanary.prescriptionExerciseIds = [pid];
  db._docs.get('releaseControl/autonomousProgression').expiresAt = window.expiresAt;
  db._docs.set('releaseControl/numericPilot', { ...window, enabled: true });
  // Aplicación autorizada (PENDING -> APPLIED)
  var appliedRes = await syntheticExecutor.applyPending(db, clientId, planId, () => T1_ISO);
  assert.equal(appliedRes.length, 1);
  assert.equal(appliedRes[0].written, true, 'Pending progression must transition to APPLIED');

  // ── 6. App Cliente muestra valores actualizados sin sobrescribir historial ──
  var mesoUpdatedSnap = await mesoRef.get();
  var mesoUpdated = mesoUpdatedSnap.data();

  // Historial de Semana 1, Día 0 permanece intacto (100 kg x 8 reps)
  assert.equal(mesoUpdated.entries['log_1_0_0_s0'].carga, '100');
  assert.equal(mesoUpdated.entries['log_1_0_0_s0'].reps, '8');

  // Exposición siguiente (Semana 1, Día 2) recibe el overlay canónico (102.5 kg)
  var effTarget = effective.resolveEffective({
    clientId: clientId, planId: planId, activePlanId: planId,
    pid: pid, week: 1, dayIndex: 2,
    records: mesoUpdated.progressionApplications,
    overlays: mesoUpdated.nextExposureOverlays,
    interventions: [], plan: planDoc, entries: mesoUpdated.entries,
    baseSets: baseSets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(effTarget.provenance, 'CANONICAL_OVERLAY');
  assert.equal(effTarget.state, 'APPLIED');
  assert.equal(effTarget.sets[0].effective.load, 102.5, 'Next exposure displays progressed load');

  // ── 7. Consumo registrado exactamente una vez ──────────────────────────────
  // Cliente entrena Semana 1, Día 2 con 102.5 kg y genera recibo de consumo
  mesoUpdated.entries['log_1_2_0_s0'] = {
    done: true,
    prescriptionExerciseId: pid,
    carga: '102.5',
    reps: '8',
    rir: '2',
    unit: 'KG',
    sts: T2_MS
  };
  mesoUpdated.consumptionReceipts = {
    [recordKey]: {
      recordKey: recordKey,
      overlayKey: 'ovl_' + recordKey,
      dimension: 'LOAD',
      appliedValue: 102.5,
      provenance: 'CANONICAL_OVERLAY',
      ackAt: T2_ISO
    }
  };
  db._docs.set('logs/' + clientId + '/mesos/' + planId, mesoUpdated);

  var consumeRes = await executor.consumePending(db, clientId, planId, () => T2_ISO);
  assert.equal(consumeRes.length, 1);
  assert.equal(consumeRes[0].written, true, 'Applied progression must transition to CONSUMED');

  var mesoConsumedSnap = await mesoRef.get();
  var mesoConsumed = mesoConsumedSnap.data();
  assert.equal(mesoConsumed.progressionApplications[recordKey].state, 'CONSUMED');

  // Idempotencia: segundo intento de consumo produce 0 escrituras
  var replayRes = await executor.consumePending(db, clientId, planId, () => T2_ISO);
  assert.equal(replayRes.length, 0, 'Replay of consumption must produce zero writes');

  // ── 8. Continuidad tras nueva sesión (Semana 2, Día 0) ────────────────────
  var effFuture = effective.resolveEffective({
    clientId: clientId, planId: planId, activePlanId: planId,
    pid: pid, week: 2, dayIndex: 0,
    records: mesoConsumed.progressionApplications,
    overlays: mesoConsumed.nextExposureOverlays,
    interventions: [], plan: planDoc, entries: mesoConsumed.entries,
    baseSets: baseSets, unit: 'KG', canonicalOverlayRead: true
  });
  assert.equal(effFuture.provenance, 'CARRIED_OVERLAY', 'Consumed progression is preserved across sessions');
  assert.equal(effFuture.sets[0].effective.load, 102.5, 'Carried progression maintains 102.5 KG');

  // ── Aislamiento multi-inquilino ───────────────────────────────────────────
  var foreignClientRes = await executor.consumePending(db, 'foreign_client_999', planId, () => T2_ISO);
  assert.equal(foreignClientRes.length, 0, 'Cross-tenant execution cannot affect another client');
});
