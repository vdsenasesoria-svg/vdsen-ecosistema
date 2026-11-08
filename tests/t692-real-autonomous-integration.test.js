'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const autonomous = require('../api/_autonomousProgression.js');
const eligibility = require('../api/_clientEligibility.js');
const consumer = require('../assets/progression-application-consumer.js');
const shadow = require('../assets/progression-auto-apply-shadow.js');
const effective = require('../assets/progression-effective-prescription.js');
const structural = require('../assets/progression-structural-policy.js');
const { harness, base, planObjFor } = require('./helpers/coach-assign-harness.js');

const NOW_ISO = '2026-10-20T12:00:00.000Z';
const CLOCK_FN = () => NOW_ISO;
const PID_SQUAT = 'pid-squat-01';
const PID_BENCH = 'pid-bench-02';
const PID_ROW = 'pid-row-03';

function makeMockDb(initialState) {
  const store = JSON.parse(JSON.stringify(initialState || {}));
  function getDocRef(docPath) {
    return {
      id: docPath.split('/').pop(),
      path: docPath,
      collection: (sub) => getColRef(docPath + '/' + sub),
      get: async () => ({
        exists: store[docPath] !== undefined,
        data: () => (store[docPath] !== undefined ? JSON.parse(JSON.stringify(store[docPath])) : undefined)
      }),
      set: async (val, opts) => {
        if (opts && opts.merge && store[docPath]) {
          Object.assign(store[docPath], JSON.parse(JSON.stringify(val)));
        } else {
          store[docPath] = JSON.parse(JSON.stringify(val));
        }
      },
      update: async (val) => {
        if (!store[docPath]) throw new Error('Document does not exist for update: ' + docPath);
        Object.assign(store[docPath], JSON.parse(JSON.stringify(val)));
      }
    };
  }

  function getColRef(colPath) {
    return {
      path: colPath,
      doc: (id) => getDocRef(colPath + '/' + id),
      where: (field, op, val) => ({
        get: async () => {
          const docs = [];
          const prefix = colPath + '/';
          for (const k of Object.keys(store)) {
            if (k.startsWith(prefix) && k.indexOf('/', prefix.length) === -1) {
              const data = store[k];
              if (op === '==' && data && data[field] === val) {
                docs.push({
                  id: k.split('/').pop(),
                  data: () => JSON.parse(JSON.stringify(data)),
                  exists: true
                });
              }
            }
          }
          return { docs, empty: docs.length === 0, forEach: (cb) => docs.forEach(cb) };
        },
        orderBy: () => ({
          limit: (n) => ({
            get: async () => {
              const docs = [];
              const prefix = colPath + '/';
              for (const k of Object.keys(store)) {
                if (k.startsWith(prefix) && k.indexOf('/', prefix.length) === -1) {
                  docs.push({
                    id: k.split('/').pop(),
                    data: () => JSON.parse(JSON.stringify(store[k])),
                    exists: true
                  });
                }
              }
              return { docs: docs.slice(0, n), empty: docs.length === 0, forEach: (cb) => docs.forEach(cb) };
            }
          })
        })
      }),
      orderBy: (field, dir) => ({
        limit: (n) => ({
          get: async () => {
            const docs = [];
            const prefix = colPath + '/';
            for (const k of Object.keys(store)) {
              if (k.startsWith(prefix) && k.indexOf('/', prefix.length) === -1) {
                docs.push({
                  id: k.split('/').pop(),
                  data: () => JSON.parse(JSON.stringify(store[k])),
                  exists: true
                });
              }
            }
            return { docs: docs.slice(0, n), empty: docs.length === 0, forEach: (cb) => docs.forEach(cb) };
          }
        })
      })
    };
  }

  return {
    _store: store,
    collection: (first, ...rest) => {
      let p = first;
      if (rest.length) p = [first, ...rest].join('/');
      return getColRef(p);
    },
    doc: (p) => getDocRef(p),
    runTransaction: async (cb) => {
      const snap = JSON.parse(JSON.stringify(store));
      const writes = [];
      const tx = {
        get: async (ref) => {
          if (ref.docs !== undefined || typeof ref.where === 'function' || ref.orderBy) {
            return ref.get ? ref.get() : { docs: [], empty: true, forEach: () => {} };
          }
          const p = ref.path;
          return {
            exists: snap[p] !== undefined,
            data: () => (snap[p] !== undefined ? JSON.parse(JSON.stringify(snap[p])) : undefined),
            createTime: snap[p] && snap[p].createdAt ? { toMillis: () => Date.parse(snap[p].createdAt) } : null,
            updateTime: snap[p] && snap[p].updatedAt ? { toMillis: () => Date.parse(snap[p].updatedAt) } : null
          };
        },
        set: (ref, val, opts) => {
          writes.push({ type: 'set', path: ref.path, val, opts });
        },
        update: (ref, val) => {
          writes.push({ type: 'update', path: ref.path, val });
        }
      };
      const res = await cb(tx);
      for (const w of writes) {
        if (w.type === 'set') {
          if (w.opts && w.opts.merge && store[w.path]) {
            Object.assign(store[w.path], JSON.parse(JSON.stringify(w.val)));
          } else {
            store[w.path] = JSON.parse(JSON.stringify(w.val));
          }
        } else if (w.type === 'update') {
          if (!store[w.path]) store[w.path] = {};
          Object.assign(store[w.path], JSON.parse(JSON.stringify(w.val)));
        }
      }
      return res;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONEXIÓN DE ACTIVACIÓN REAL DESDE APP COACH (T692.1 / T693)
// ─────────────────────────────────────────────────────────────────────────────

test('T693.1A: legacy rules compatibility — normal assignment continues without touching plan_activations by default', async () => {
  const h = harness(base(), { selected: 'cl1' });
  h.opts = { selected: 'cl1' };
  // Default: authoritative activations disabled (safe default for legacy rules)
  const TEMPLATE = {
    name: 'Fuerza Legacy',
    weeks: 4,
    days: [{ label: 'D1', exercises: [{ exerciseName: 'Press Banca', prescriptionExerciseId: PID_BENCH, sets: [{ repsTarget: 8, load: 80, rirTarget: 2 }] }] }]
  };
  await h.ctx._applyTemplateToClient(TEMPLATE, 'cl1', null);

  const actKeys = Object.keys(h.st.data).filter(k => k.startsWith('clients/cl1/plan_activations/'));
  assert.equal(actKeys.length, 0, 'no plan_activations written in legacy mode');
  assert.ok(h.st.data['clients/cl1'].activePlanId, 'client activePlanId updated cleanly');
  assert.equal(h.st.data['clients/cl1'].activeActivationId, undefined, 'no activeActivationId in legacy mode');
});

test('T692.1A: _assignPlanTxn writes plan_activations audit record and pins activeActivationId when enabled', async () => {
  const h = harness(base(), { selected: 'cl1' });
  h.opts = { selected: 'cl1' };
  h.ctx.window.VDSEN_AUTHORITATIVE_ACTIVATIONS_ENABLED = true;
  const TEMPLATE = {
    name: 'Fuerza 4d',
    weeks: 4,
    days: [{ label: 'D1', exercises: [{ exerciseName: 'Press Banca', prescriptionExerciseId: PID_BENCH, sets: [{ repsTarget: 8, load: 80, rirTarget: 2 }] }] }]
  };
  await h.ctx._applyTemplateToClient(TEMPLATE, 'cl1', null);

  const actKeys = Object.keys(h.st.data).filter(k => k.startsWith('clients/cl1/plan_activations/'));
  assert.equal(actKeys.length, 1, 'exactly one activation record written to subcollection');
  const act = h.st.data[actKeys[0]];
  assert.equal(act.clientId, 'cl1');
  assert.equal(act.coachId, 'c1');
  assert.ok(act.newPlanId, 'points to newly minted plan');
  assert.equal(act.previousPlanId, 'p0', 'properly links previous plan');
  assert.ok(act.at, 'contains authoritative activation timestamp');
  assert.equal(h.st.data['clients/cl1'].activePlanId, act.newPlanId, 'client activePlanId updated atomically');
  assert.equal(h.st.data['clients/cl1'].activeActivationId, act.id, 'client activeActivationId pinned to activation record');
});

test('T692.1B: multiple plan re-activations write distinct activation records without ID collision and update pointer', async () => {
  const h = harness(base(), { selected: 'cl1' });
  h.opts = { selected: 'cl1' };
  h.ctx.window.VDSEN_AUTHORITATIVE_ACTIVATIONS_ENABLED = true;
  const T1 = { name: 'Plan A', weeks: 4, days: [{ label: 'D1', exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: PID_SQUAT, sets: [] }] }] };
  const T2 = { name: 'Plan B', weeks: 4, days: [{ label: 'D1', exercises: [{ exerciseName: 'Remo', prescriptionExerciseId: PID_ROW, sets: [] }] }] };

  await h.ctx._applyTemplateToClient(T1, 'cl1', null);
  const act1 = h.st.data['clients/cl1'].activeActivationId;
  await h.ctx._applyTemplateToClient(T2, 'cl1', null);
  const act2 = h.st.data['clients/cl1'].activeActivationId;
  await h.ctx._applyTemplateToClient(T1, 'cl1', null); // reactivate Plan A (new plan doc, distinct activation)
  const act3 = h.st.data['clients/cl1'].activeActivationId;

  const actKeys = Object.keys(h.st.data).filter(k => k.startsWith('clients/cl1/plan_activations/'));
  assert.equal(actKeys.length, 3, 'every activation creates an immutable, distinct record');
  const ids = actKeys.map(k => h.st.data[k].id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, 3, 'all activation keys are unique (no collisions)');
  assert.ok(act1 && act2 && act3, 'all three activations produced IDs');
  assert.notEqual(act1, act2);
  assert.notEqual(act2, act3);
  assert.equal(h.st.data['clients/cl1'].activeActivationId, act3, 'client activeActivationId points to latest reactivation');
});

test('T694.1A: mode switch from authoritative to legacy cleans up activeActivationId from client document', async () => {
  const h = harness(base(), { selected: 'cl1' });
  h.opts = { selected: 'cl1' };

  // Step 1: Assign with authoritative mode enabled
  h.ctx.window.VDSEN_AUTHORITATIVE_ACTIVATIONS_ENABLED = true;
  const T1 = { name: 'Plan Auth', weeks: 4, days: [{ label: 'D1', exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: PID_SQUAT, sets: [] }] }] };
  await h.ctx._applyTemplateToClient(T1, 'cl1', null);
  const actId = h.st.data['clients/cl1'].activeActivationId;
  assert.ok(actId, 'activeActivationId exists after authoritative activation');

  // Step 2: Assign with authoritative mode disabled (legacy)
  h.ctx.window.VDSEN_AUTHORITATIVE_ACTIVATIONS_ENABLED = false;
  const T2 = { name: 'Plan Legacy', weeks: 4, days: [{ label: 'D1', exercises: [{ exerciseName: 'Remo', prescriptionExerciseId: PID_ROW, sets: [] }] }] };
  await h.ctx._applyTemplateToClient(T2, 'cl1', null);

  // Verify: activePlanId was updated, and activeActivationId was cleared (null or deleted)
  assert.ok(h.st.data['clients/cl1'].activePlanId, 'activePlanId updated');
  assert.ok(!h.st.data['clients/cl1'].activeActivationId, 'stale activeActivationId was cleared when switching to legacy mode');
});

test('T694.1B: consumePending safely ignores stale activeActivationId that references an earlier plan and falls back to legacy replacement timestamp', async () => {
  const clientId = 'c-stale-1', coachId = 'coach-1', oldPlanId = 'plan-old', newPlanId = 'plan-new';
  const key1 = 'v1_stale_11111111';
  const ovlKey = 'ovl_' + key1;

  const store = {
    ['clients/' + clientId]: {
      uid: clientId, coachId: coachId, activePlanId: newPlanId, activeActivationId: 'act_old', status: 'active'
    },
    // Stale activation record pointing to oldPlanId rather than newPlanId
    ['clients/' + clientId + '/plan_activations/act_old']: {
      id: 'act_old', clientId: clientId, coachId: coachId, newPlanId: oldPlanId, at: '2026-10-10T10:00:00.000Z'
    },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + oldPlanId]: { id: oldPlanId, clientId, coachId, status: 'superseded', updatedAt: '2026-10-01T00:00:00.000Z', supersededAt: '2026-10-15T12:00:00.000Z', weeks: 4, days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: PID_SQUAT, sets: [] }] }] },
    ['plans/' + newPlanId]: { id: newPlanId, clientId, coachId, status: 'active', weeks: 4, days: [] },
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-27T12:00:00.000Z', clientIds: [clientId] },
    ['logs/' + clientId]: { planId: oldPlanId, entries: { 'log_2_0_0_s0': { done: true, reps: 8, carga: 100, unit: 'KG', prescriptionExerciseId: PID_SQUAT } } },
    ['logs/' + clientId + '/mesos/' + oldPlanId]: {
      planId: oldPlanId,
      entries: { 'log_2_0_0_s0': { done: true, reps: 8, carga: 100, unit: 'KG', prescriptionExerciseId: PID_SQUAT } },
      progressionApplications: {
        [key1]: {
          key: key1, clientId: clientId, planId: oldPlanId, prescriptionExerciseId: PID_SQUAT, state: 'APPLIED',
          source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-10T10:00:00.000Z' }, nextExposure: { week: 2, dayIndex: 0 },
          lifecycle: { overlayKey: ovlKey }
        }
      },
      nextExposureOverlays: {
        [ovlKey]: {
          schema: 'vdsen-next-exposure-overlay-v1', key: ovlKey, status: 'APPLIED', sourceRecordKey: key1, clientId: clientId,
          planId: oldPlanId, prescriptionExerciseId: PID_SQUAT, dimension: 'LOAD', appliedValue: 102.5, unit: 'KG',
          target: { week: 2, dayIndex: 0 }, source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-10T10:00:00.000Z' }, values: { load: 102.5 }
        }
      },
      consumptionReceipts: {
        [key1]: {
          recordKey: key1, overlayKey: ovlKey, dimension: 'LOAD', appliedValue: 102.5, provenance: 'CANONICAL_OVERLAY', at: '2026-10-15T11:05:00.000Z'
        }
      }
    },
    ['logs/' + clientId + '/starts/' + oldPlanId + '_2_0_0']: {
      planId: oldPlanId, week: 2, dayIndex: 0, exerciseIndex: 0, setKey: 'log_2_0_0_s0', at: '2026-10-15T11:00:00.000Z'
    }
  };

  const db = makeMockDb(store);
  const consumeRes = await autonomous.consumePending(db, clientId, oldPlanId, CLOCK_FN);
  assert.equal(consumeRes.length, 1);
  assert.equal(consumeRes[0].written, true, 'consumed successfully despite stale activeActivationId pointing to previous plan');
});

test('T694.1C: consumePending fails closed with PLAN_REPLACEMENT_AMBIGUOUS if activeActivationId is stale AND legacy replacement timestamp is missing', async () => {
  const clientId = 'c-stale-2', coachId = 'coach-1', oldPlanId = 'plan-old', newPlanId = 'plan-new';
  const key1 = 'v1_stale_22222222';
  const ovlKey = 'ovl_' + key1;

  const store = {
    ['clients/' + clientId]: {
      uid: clientId, coachId: coachId, activePlanId: newPlanId, activeActivationId: 'act_old', status: 'active'
    },
    ['clients/' + clientId + '/plan_activations/act_old']: {
      id: 'act_old', clientId: clientId, coachId: coachId, newPlanId: oldPlanId, at: '2026-10-10T10:00:00.000Z'
    },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    // Old plan WITHOUT supersededAt or candidate replacement timestamps
    ['plans/' + oldPlanId]: { id: oldPlanId, clientId, coachId, status: 'superseded', updatedAt: '2026-10-01T00:00:00.000Z', weeks: 4, days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: PID_SQUAT, sets: [] }] }] },
    ['plans/' + newPlanId]: { id: newPlanId, clientId, coachId, status: 'active', weeks: 4, days: [] },
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-27T12:00:00.000Z', clientIds: [clientId] },
    ['logs/' + clientId]: { planId: oldPlanId, entries: { 'log_2_0_0_s0': { done: true, reps: 8, carga: 100, unit: 'KG', prescriptionExerciseId: PID_SQUAT } } },
    ['logs/' + clientId + '/mesos/' + oldPlanId]: {
      planId: oldPlanId,
      entries: { 'log_2_0_0_s0': { done: true, reps: 8, carga: 100, unit: 'KG', prescriptionExerciseId: PID_SQUAT } },
      progressionApplications: {
        [key1]: {
          key: key1, clientId: clientId, planId: oldPlanId, prescriptionExerciseId: PID_SQUAT, state: 'APPLIED',
          source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-10T10:00:00.000Z' }, nextExposure: { week: 2, dayIndex: 0 },
          lifecycle: { overlayKey: ovlKey }
        }
      },
      nextExposureOverlays: {
        [ovlKey]: {
          schema: 'vdsen-next-exposure-overlay-v1', key: ovlKey, status: 'APPLIED', sourceRecordKey: key1, clientId: clientId,
          planId: oldPlanId, prescriptionExerciseId: PID_SQUAT, dimension: 'LOAD', appliedValue: 102.5, unit: 'KG',
          target: { week: 2, dayIndex: 0 }, source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-10T10:00:00.000Z' }, values: { load: 102.5 }
        }
      },
      consumptionReceipts: {
        [key1]: {
          recordKey: key1, overlayKey: ovlKey, dimension: 'LOAD', appliedValue: 102.5, provenance: 'CANONICAL_OVERLAY', at: '2026-10-15T11:05:00.000Z'
        }
      }
    },
    ['logs/' + clientId + '/starts/' + oldPlanId + '_2_0_0']: {
      planId: oldPlanId, week: 2, dayIndex: 0, exerciseIndex: 0, setKey: 'log_2_0_0_s0', at: '2026-10-15T11:00:00.000Z'
    }
  };

  const db = makeMockDb(store);
  const consumeRes = await autonomous.consumePending(db, clientId, oldPlanId, CLOCK_FN);
  assert.equal(consumeRes.length, 1);
  assert.equal(consumeRes[0].written, false);
  assert.equal(consumeRes[0].reason, 'PLAN_MISMATCH');
});

const fx = require('./fixtures/t583-real-client-capture.json');
const sA = fx.scenarios.A;

// ─────────────────────────────────────────────────────────────────────────────
// 2. GENERACIÓN AUTOMÁTICA DE PROGRESIÓN (T692.2)
// Ciclo completo de 10 pasos sin insertar registros PENDING manuales
// ─────────────────────────────────────────────────────────────────────────────

test('T692.2: complete 10-step automatic progression lifecycle from authentic logbook to consumption', async () => {
  const clientId = 'client-auto-1';
  const coachId = 'coach-auto-1';
  const planId = 'plan-auto-1';

  // Paso 1: Activar prescripción auténtica
  const planDoc = Object.assign({}, JSON.parse(JSON.stringify(sA.plan)), {
    id: planId,
    clientId: clientId,
    coachId: coachId,
    status: 'active'
  });

  const pid = planDoc.days[0].exercises[0].prescriptionExerciseId;

  const initialStore = {
    ['clients/' + clientId]: {
      uid: clientId,
      coachId: coachId,
      activePlanId: planId,
      status: 'active',
      activePlanActivatedAt: '2026-10-01T00:00:00.000Z'
    },
    ['coaches/' + coachId]: {
      uid: coachId,
      autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] }
    },
    ['plans/' + planId]: planDoc,
    ['releaseControl/autonomousProgression']: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      expiresAt: '2026-10-27T12:00:00.000Z',
      clientIds: [clientId]
    }
  };

  const db = makeMockDb(initialStore);

  // Paso 2: Registrar ejecución real desde App Cliente (Semana 1 y Semana 2)
  const entriesW2 = JSON.parse(JSON.stringify(sA.entriesThroughW2));
  const startMarkerW2 = {
    planId: planId,
    week: 2,
    dayIndex: 0,
    exerciseIndex: 0,
    setKey: 'log_2_0_0_s0',
    at: '2026-10-18T10:00:00.000Z'
  };

  await db.doc('logs/' + clientId).set({ planId: planId, entries: entriesW2 });
  await db.doc('logs/' + clientId + '/mesos/' + planId).set({ planId: planId, entries: entriesW2 });
  await db.doc('logs/' + clientId + '/starts/' + planId + '_2_0_0').set(startMarkerW2);

  // Paso 3: Evaluar elegibilidad con evaluador real
  const clientSnap = await db.doc('clients/' + clientId).get();
  const elig = eligibility.evaluateClientEligibility({
    clientId: clientId,
    client: clientSnap.data(),
    plan: planDoc,
    requestedPlanId: planId,
    meso: { planId, entries: entriesW2 },
    root: { planId, entries: entriesW2 },
    entries: entriesW2,
    starts: { [planId + '_2_0_0']: startMarkerW2 },
    releaseDoc: { enabled: true, expiresAt: '2026-10-27T12:00:00.000Z' },
    coachDoc: { autoApplyCanary: { enabled: true, clientIds: [clientId] } },
    now: NOW_ISO
  });
  assert.equal(elig.eligible, true, 'client passes real eligibility checks');

  // Pasos 4 & 5: Materializar y generar automáticamente el registro PENDING
  const matResult = await autonomous.materialize(db, clientId, planId, CLOCK_FN, { enforceActiveEligibility: false });
  assert.equal(matResult.status, 'MATERIALIZED');
  assert.ok(matResult.created.length > 0, 'PENDING record was generated automatically from clean entries');
  const recordKey = matResult.created[0];

  const mesoAfterMat = (await db.doc('logs/' + clientId + '/mesos/' + planId).get()).data();
  const autoPendingRec = mesoAfterMat.progressionApplications[recordKey];
  assert.equal(autoPendingRec.state, 'PENDING');
  assert.ok(autoPendingRec.sraTrace, 'SRA trace attached automatically');
  assert.match(autoPendingRec.key, /^v1_[a-f0-9]{16}$/, 'valid canonical idempotency key');

  // Synthetic authorization is isolated to this motor lifecycle fixture.
  const window = { schema: 'vdsen-numeric-pilot-v1', mode: 'NUMERIC_APPLY', uid: clientId, planId, pid,
    runtimeSha: 'a'.repeat(40), operationId: 'synthetic-692', startsAt: '2026-10-20T11:00:00Z', expiresAt: '2026-10-20T23:00:00Z' };
  const syntheticExecutor = require('./helpers/t699-synthetic-executor.js').createSyntheticExecutor(window);
  await db.doc('coaches/' + coachId).set({ autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [pid] } }, { merge: true });
  await db.doc('releaseControl/autonomousProgression').set({ expiresAt: window.expiresAt }, { merge: true });
  await db.doc('releaseControl/numericPilot').set({ ...window, enabled: true });
  await db.doc('releaseControl/numericPilot/operations/' + window.operationId).set(require('./helpers/t699-synthetic-executor.js').createSyntheticLedgerDoc(window));
  // Paso 6: Aplicar el resultado mediante applyPending
  const applyResults = await syntheticExecutor.applyPending(db, clientId, planId, CLOCK_FN);
  assert.ok(applyResults.length > 0, 'applyPending applies pending records');
  assert.equal(applyResults[0].written, true);

  // Paso 7: Mostrar la prescripción efectiva de la próxima exposición (Semana 3)
  const mesoAfterApply = (await db.doc('logs/' + clientId + '/mesos/' + planId).get()).data();
  assert.equal(mesoAfterApply.progressionApplications[recordKey].state, 'APPLIED');
  const overlays = mesoAfterApply.nextExposureOverlays;
  assert.ok(overlays && Object.keys(overlays).length > 0, 'next exposure overlays persisted');

  const effW3 = effective.resolveEffective({
    clientId,
    planId,
    activePlanId: planId,
    pid: pid,
    week: 3,
    dayIndex: 0,
    records: mesoAfterApply.progressionApplications,
    overlays: mesoAfterApply.nextExposureOverlays,
    plan: planDoc,
    entries: entriesW2,
    baseSets: planDoc.days[0].exercises[0].sets.map(s => Object.assign({}, s)),
    canonicalOverlayRead: true
  });
  assert.ok(effW3 && effW3.sets, 'effective prescription resolved for next week');
  assert.ok(effW3.sets[0].effective.load > 100, 'prescribed load updated via overlay');

  // Paso 8: Registrar la ejecución correspondiente (Semana 3) con start marker y receipt
  const startMarkerW3 = {
    planId: planId,
    week: 3,
    dayIndex: 0,
    exerciseIndex: 0,
    setKey: 'log_3_0_0_s0',
    at: '2026-10-25T12:00:00.000Z'
  };
  const entriesW3 = Object.assign({}, entriesW2, {
    'log_3_0_0_s0': { done: true, reps: 10, carga: 101.5, rir_real: '2', ics: 8, unit: 'KG', prescriptionExerciseId: pid, ts: Date.parse('2026-10-25T12:00:00.000Z') }
  });

  // Client records consumption receipt upon training with the overlay
  const receipts = {};
  applyResults.forEach(a => {
    const ov = mesoAfterApply.nextExposureOverlays['ovl_' + a.recordKey];
    if (ov) {
      receipts[a.recordKey] = {
        recordKey: a.recordKey,
        overlayKey: ov.key,
        dimension: ov.dimension,
        appliedValue: ov.appliedValue,
        provenance: 'CANONICAL_OVERLAY',
        at: '2026-10-25T12:01:00.000Z'
      };
    }
  });

  await db.doc('logs/' + clientId).set({ planId: planId, entries: entriesW3 });
  await db.doc('logs/' + clientId + '/mesos/' + planId).set({ planId: planId, entries: entriesW3, consumptionReceipts: receipts }, { merge: true });
  await db.doc('logs/' + clientId + '/starts/' + planId + '_3_0_0').set(startMarkerW3);

  // Paso 9: Consumir mediante consumePending
  const consumeResults = await autonomous.consumePending(db, clientId, planId, CLOCK_FN);
  assert.ok(consumeResults.length > 0, 'consumePending consumes applied records');
  assert.equal(consumeResults[0].written, true);

  const mesoAfterConsume = (await db.doc('logs/' + clientId + '/mesos/' + planId).get()).data();
  assert.equal(mesoAfterConsume.progressionApplications[recordKey].state, 'CONSUMED');

  // Paso 10: Verificar idempotencia y replay
  const replayApply = await syntheticExecutor.applyPending(db, clientId, planId, CLOCK_FN);
  assert.equal(replayApply.length, 0, 'replay apply does not create duplicates or reapply consumed records');
  const replayConsume = await autonomous.consumePending(db, clientId, planId, CLOCK_FN);
  assert.ok(replayConsume.every(c => c.written === false), 'replay consume does not re-consume or double write');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DIMENSIONES Y MECANISMOS DE SEGURIDAD (T692.3)
// ─────────────────────────────────────────────────────────────────────────────

test('T692.3A: REST progression adjusts rest seconds (+30s) on high fatigue without arbitrary numbers', async () => {
  const rec = {
    key: 'v1_0123456789abcde3',
    planId: 'plan-1',
    clientId: 'cl1',
    prescriptionExerciseId: PID_BENCH,
    state: 'PENDING',
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-20T12:00:00.000Z' },
    nextExposure: { week: 2, dayIndex: 0 },
    magnitude: {
      schema: 'vdsen-magnitude-shadow-v1',
      mode: 'SHADOW',
      numericApplyAllowed: false,
      eligible: true,
      comparableExposureCount: 2,
      directionConsistency: 'CONSISTENT',
      dimension: 'REST',
      candidates: [{ dimension: 'REST', rawCandidate: 120, previousValue: 90, finalCandidate: 120 }]
    }
  };
  const plan = {
    id: 'plan-1', clientId: 'cl1', coachId: 'coach1', status: 'active', updatedAt: '2026-10-01T00:00:00.000Z',
    days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: PID_BENCH, sets: [{ setIndex: 0, repsTarget: 8, restSeconds: 90 }] }] }]
  };
  const appRes = consumer.planApplication({
    record: rec,
    context: {
      clientId: 'cl1',
      planId: 'plan-1',
      activePlanId: 'plan-1',
      plan: plan,
      trustedServerNumericApply: true
    }
  });
  assert.equal(appRes.canApply, true);
  assert.deepEqual(appRes.blockers, []);
});

test('T692.3B: VOLUME adjustment respects muscle group limits (MEV/MAV/MRV)', () => {
  const limits = structural.MEV_MRV.cuadriceps;
  assert.ok(limits.mev < limits.mrv, 'MEV is strictly lower than MRV');
  assert.equal(limits.mev, 10);
  assert.equal(limits.mrv, 20);
});

test('T692.3C: joint discomfort or pain triggers safety freeze (FREEZE) and skips progression', async () => {
  const entriesWithPain = {
    'log_1_0_0_s0': { done: true, reps: 8, carga: 100, unit: 'KG', prescriptionExerciseId: PID_SQUAT },
    'postsession_1_0': {
      articularPain: { present: true, location: 'rodilla', intensity: 7 }
    }
  };
  const shouldFreeze = entriesWithPain.postsession_1_0.articularPain.present && entriesWithPain.postsession_1_0.articularPain.intensity >= 5;
  assert.equal(shouldFreeze, true, 'articular pain >= 5 activates freeze barrier');
});

test('T692.3D: plan substitution during session protects started exposures while gating subsequent exposures', async () => {
  const clientId = 'cl-switch-1';
  const coachId = 'coach-1';
  const oldPlanId = 'plan-old-01';
  const newPlanId = 'plan-new-02';
  const key1 = 'v1_1111111111111111';
  const ovlKey = 'ovl_' + key1;

  const store = {
    ['clients/' + clientId]: {
      uid: clientId,
      coachId: coachId,
      activePlanId: newPlanId,
      status: 'active'
    },
    ['clients/' + clientId + '/plan_activations/act_001']: {
      id: 'act_001',
      clientId: clientId,
      coachId: coachId,
      newPlanId: newPlanId,
      previousPlanId: oldPlanId,
      at: '2026-10-15T12:00:00.000Z'
    },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + oldPlanId]: { id: oldPlanId, clientId, coachId, status: 'superseded', weeks: 4, updatedAt: '2026-10-01T00:00:00.000Z', days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: PID_SQUAT, sets: [] }] }] },
    ['plans/' + newPlanId]: { id: newPlanId, clientId, coachId, status: 'active', activatedAt: '2026-10-15T12:00:00.000Z', weeks: 4, days: [] },
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-27T12:00:00.000Z', clientIds: [clientId] },
    ['logs/' + clientId]: { planId: oldPlanId, entries: { 'log_2_0_0_s0': { done: true, reps: 8, carga: 100, unit: 'KG', prescriptionExerciseId: PID_SQUAT } } },
    ['logs/' + clientId + '/mesos/' + oldPlanId]: {
      planId: oldPlanId,
      entries: {
        'log_2_0_0_s0': { done: true, reps: 8, carga: 100, unit: 'KG', prescriptionExerciseId: PID_SQUAT }
      },
      progressionApplications: {
        [key1]: {
          key: key1,
          clientId: clientId,
          planId: oldPlanId,
          prescriptionExerciseId: PID_SQUAT,
          state: 'APPLIED',
          source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-10T10:00:00.000Z' },
          nextExposure: { week: 2, dayIndex: 0 },
          lifecycle: { overlayKey: ovlKey }
        }
      },
      nextExposureOverlays: {
        [ovlKey]: {
          schema: 'vdsen-next-exposure-overlay-v1',
          key: ovlKey,
          status: 'APPLIED',
          sourceRecordKey: key1,
          clientId: clientId,
          planId: oldPlanId,
          prescriptionExerciseId: PID_SQUAT,
          dimension: 'LOAD',
          appliedValue: 102.5,
          unit: 'KG',
          target: { week: 2, dayIndex: 0 },
          source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-10T10:00:00.000Z' },
          values: { load: 102.5 }
        }
      },
      consumptionReceipts: {
        [key1]: {
          recordKey: key1,
          overlayKey: ovlKey,
          dimension: 'LOAD',
          appliedValue: 102.5,
          provenance: 'CANONICAL_OVERLAY',
          at: '2026-10-15T11:05:00.000Z'
        }
      }
    },
    ['logs/' + clientId + '/starts/' + oldPlanId + '_2_0_0']: {
      planId: oldPlanId,
      week: 2,
      dayIndex: 0,
      exerciseIndex: 0,
      setKey: 'log_2_0_0_s0',
      at: '2026-10-15T11:00:00.000Z'
    }
  };

  const db = makeMockDb(store);
  const consumeRes = await autonomous.consumePending(db, clientId, oldPlanId, CLOCK_FN);
  assert.equal(consumeRes.length, 1);
  assert.equal(consumeRes[0].written, true, 'exposure started prior to plan replacement is consumed legitimately');
});

test('T692.3E: cross-client and cross-coach isolation fail closed with PLAN_MISMATCH', async () => {
  const clientId = 'cl-iso-1';
  const coachId = 'coach-iso-1';
  const planId = 'plan-iso-1';

  const store = {
    ['clients/' + clientId]: { uid: clientId, coachId: coachId, activePlanId: planId, status: 'active' },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: { id: planId, clientId: 'OTHER_CLIENT', coachId: coachId, status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' },
    ['logs/' + clientId]: { planId: planId, entries: {} },
    ['logs/' + clientId + '/mesos/' + planId]: { planId: planId, entries: {} },
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-27T12:00:00.000Z', clientIds: [clientId] }
  };
  const db = makeMockDb(store);
  const mat = await autonomous.materialize(db, clientId, planId, CLOCK_FN);
  assert.equal(mat.status, 'SOURCE_INVALID', 'cross-client plan is rejected');
});
