'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const executor = require('../api/_autonomousProgression.js');
const eligibility = require('../api/_clientEligibility.js');
const shadow = require('../assets/progression-auto-apply-shadow.js');

const NOW_ISO = '2026-11-03T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

function safeClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (typeof obj.toMillis === 'function' || typeof obj.toDate === 'function') return obj;
  if (Array.isArray(obj)) return obj.map(safeClone);
  var out = {};
  for (var k of Object.keys(obj)) {
    out[k] = safeClone(obj[k]);
  }
  return out;
}

function makeFakeDb(seedDocs) {
  var docs = new Map();
  if (seedDocs) {
    Object.keys(seedDocs).forEach(function(k) {
      docs.set(k, safeClone(seedDocs[k]));
    });
  }

  function makeSnap(docPath) {
    var val = docs.get(docPath);
    var updMs = val && val.updatedAt ? Date.parse(val.updatedAt) : NOW_MS;
    var createMs = val && val.createdAt ? Date.parse(val.createdAt) : null;
    return {
      id: docPath.split('/').pop(),
      exists: val !== undefined,
      data: function() { return val !== undefined ? safeClone(val) : undefined; },
      updateTime: { toMillis: function() { return Number.isFinite(updMs) ? updMs : NOW_MS; } },
      createTime: createMs ? { toMillis: function() { return Number.isFinite(createMs) ? createMs : NOW_MS; } } : null
    };
  }

  function makeRef(docPath) {
    return {
      id: docPath.split('/').pop(),
      path: docPath,
      collection: function(name) { return makeCollection(docPath + '/' + name); },
      doc: function(id) { return makeRef(docPath + '/' + id); },
      get: async function() {
        return makeSnap(docPath);
      },
      set: async function(data, opts) {
        if (opts && opts.merge) {
          var curr = docs.get(docPath) || {};
          var merged = Object.assign({}, curr);
          Object.keys(data).forEach(function(k) {
            if (typeof data[k] === 'object' && data[k] !== null && !Array.isArray(data[k]) && typeof curr[k] === 'object' && curr[k] !== null) {
              merged[k] = Object.assign({}, curr[k], data[k]);
            } else {
              merged[k] = data[k];
            }
          });
          docs.set(docPath, merged);
        } else {
          docs.set(docPath, safeClone(data));
        }
      }
    };
  }

  function makeCollection(colPath) {
    function makeQuery(filterFn) {
      return {
        where: function(field, op, expected) {
          var newFilter = function(v) {
            if (filterFn && !filterFn(v)) return false;
            var actual = field.split('.').reduce(function(o, p) { return o ? o[p] : undefined; }, v);
            if (op === '==') return actual === expected;
            return true;
          };
          return makeQuery(newFilter);
        },
        orderBy: function() { return makeQuery(filterFn); },
        limit: function() { return makeQuery(filterFn); },
        get: async function() {
          var snaps = [];
          for (var [p, v] of docs.entries()) {
            if (p.startsWith(colPath + '/') && p.split('/').length === colPath.split('/').length + 1) {
              if (!filterFn || filterFn(v)) snaps.push(makeSnap(p));
            }
          }
          return {
            docs: snaps,
            forEach: function(fn) { snaps.forEach(fn); },
            empty: snaps.length === 0,
            size: snaps.length
          };
        }
      };
    }
    return {
      doc: function(id) { return makeRef(colPath + '/' + id); },
      where: function(f, o, v) { return makeQuery().where(f, o, v); },
      orderBy: function() { return makeQuery(); },
      limit: function() { return makeQuery(); },
      get: async function() { return makeQuery().get(); }
    };
  }

  return {
    collection: function(name) { return makeCollection(name); },
    doc: function(path) { return makeRef(path); },
    runTransaction: async function(fn) {
      var tx = {
        get: async function(refOrQuery) {
          return refOrQuery.get();
        },
        set: function(ref, data, opts) {
          var p = ref.path;
          if (opts && opts.merge) {
            var curr = docs.get(p) || {};
            var merged = Object.assign({}, curr);
            Object.keys(data).forEach(function(k) {
              if (typeof data[k] === 'object' && data[k] !== null && !Array.isArray(data[k]) && typeof curr[k] === 'object' && curr[k] !== null) {
                merged[k] = Object.assign({}, curr[k], data[k]);
              } else {
                merged[k] = data[k];
              }
            });
            docs.set(p, merged);
          } else {
            docs.set(p, safeClone(data));
          }
        }
      };
      return fn(tx);
    },
    _docs: docs
  };
}

function makeReplacedPlanFixture(opts) {
  opts = opts || {};
  var clientId = opts.clientId || 'client-t687';
  var oldPlanId = opts.oldPlanId || 'plan-old';
  var newPlanId = opts.newPlanId || 'plan-new';
  var coachId = opts.coachId || 'coach-1';
  var pid = opts.pid || 'pid-squat';
  var key = opts.key || 'v1_postmerge_test';
  var rec = {
    key: key,
    revision: 2,
    clientId: clientId,
    planId: oldPlanId,
    prescriptionExerciseId: pid,
    state: 'APPLIED',
    lifecycle: { overlayKey: 'ovl_' + key },
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-01T00:00:00.000Z' },
    nextExposure: { week: 1, dayIndex: 2 }
  };
  var ovl = {
    schema: 'vdsen-next-exposure-overlay-v1',
    key: 'ovl_' + key,
    sourceRecordKey: key,
    clientId: clientId,
    planId: oldPlanId,
    prescriptionExerciseId: pid,
    dimension: 'LOAD',
    status: 'APPLIED',
    appliedValue: 102.5,
    previousValue: 100,
    unit: 'KG',
    target: { week: 1, dayIndex: 2 }
  };
  var receipt = {
    recordKey: key,
    overlayKey: 'ovl_' + key,
    dimension: 'LOAD',
    appliedValue: 102.5,
    provenance: 'CANONICAL_OVERLAY',
    ackAt: NOW_ISO
  };
  var oldPlanDoc = {
    clientId: clientId,
    coachId: coachId,
    status: opts.oldPlanStatus || 'active',
    active: opts.oldPlanActive !== undefined ? opts.oldPlanActive : true,
    weeks: 4,
    updatedAt: '2026-10-01T00:00:00.000Z',
    days: [
      { dayIndex: 0, exercises: [{ prescriptionExerciseId: pid }] },
      { dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }
    ]
  };
  var seed = {
    ['clients/' + clientId]: {
      uid: clientId,
      activePlanId: newPlanId,
      coachId: coachId,
      status: 'active',
      activePlanActivatedAt: opts.clientActivatedAt !== undefined ? opts.clientActivatedAt : NOW_ISO
    },
    ['coaches/' + coachId]: {
      uid: coachId,
      autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] }
    },
    ['plans/' + oldPlanId]: oldPlanDoc,
    ['plans/' + newPlanId]: {
      clientId: clientId,
      coachId: coachId,
      status: 'active',
      weeks: 4,
      days: [],
      createdAt: opts.newPlanCreatedAt !== undefined ? opts.newPlanCreatedAt : NOW_ISO
    },
    ['releaseControl/autonomousProgression']: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      expiresAt: '2026-12-01T00:00:00.000Z',
      clientIds: [clientId]
    },
    ['logs/' + clientId + '/mesos/' + oldPlanId]: {
      planId: oldPlanId,
      progressionApplications: { [key]: rec },
      nextExposureOverlays: { ['ovl_' + key]: ovl },
      consumptionReceipts: { [key]: receipt },
      entries: {
        'log_1_2_0_s0': { done: true, prescriptionExerciseId: pid, carga: '102.5', reps: '8', unit: 'KG', sts: NOW_MS - 2000 }
      }
    }
  };

  if (opts.startMarker !== null) {
    seed['logs/' + clientId + '/starts/' + oldPlanId + '_1_2_0'] = opts.startMarker || {
      planId: oldPlanId,
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: new Date(NOW_MS - 2000).toISOString()
    };
  }

  return { seed: seed, clientId: clientId, oldPlanId: oldPlanId, key: key };
}

// 1. Marcador "Timestamp" válido
test('T687 — 1. Marcador Timestamp válido: Firestore Timestamp object with toMillis() and toDate() succeeds', async () => {
  var tsObj = {
    toDate: function() { return new Date(NOW_MS - 3000); },
    toMillis: function() { return NOW_MS - 3000; },
    seconds: Math.floor((NOW_MS - 3000) / 1000),
    nanoseconds: 0
  };
  var fix = makeReplacedPlanFixture({
    startMarker: {
      planId: 'plan-old',
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: tsObj
    }
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, true, 'Expected successful consumption with Firestore Timestamp');
  var updated = db._docs.get('logs/' + fix.clientId + '/mesos/' + fix.oldPlanId);
  assert.equal(updated.progressionApplications[fix.key].state, 'CONSUMED');
});

test('T687 — 1. Marcador Timestamp válido: Firestore Timestamp with _seconds and _nanoseconds (Admin SDK) succeeds', async () => {
  var adminTs = {
    _seconds: Math.floor((NOW_MS - 4000) / 1000),
    _nanoseconds: 500000000
  };
  var fix = makeReplacedPlanFixture({
    startMarker: {
      planId: 'plan-old',
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: adminTs
    }
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, true);
  var updated = db._docs.get('logs/' + fix.clientId + '/mesos/' + fix.oldPlanId);
  assert.equal(updated.progressionApplications[fix.key].state, 'CONSUMED');
});

// 2. Marcador sin fecha válida
test('T687 — 2. Marcador sin fecha válida: at === null fails closed with PLAN_MISMATCH', async () => {
  var fix = makeReplacedPlanFixture({
    startMarker: {
      planId: 'plan-old',
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: null
    }
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T687 — 2. Marcador sin fecha válida: non-date string fails closed with PLAN_MISMATCH', async () => {
  var fix = makeReplacedPlanFixture({
    startMarker: {
      planId: 'plan-old',
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: 'not-a-valid-timestamp'
    }
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T687 — 2. Marcador sin fecha válida: counter below floor (< 2000-01-01) fails closed', async () => {
  var fix = makeReplacedPlanFixture({
    startMarker: {
      planId: 'plan-old',
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: 12345
    }
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T687 — 2. Marcador sin fecha válida: completely missing startMarker document fails closed', async () => {
  var fix = makeReplacedPlanFixture({
    startMarker: null
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

// 3. Exposición anterior a la sustitución acreditada
test('T687 — 3. Exposición anterior a la sustitución acreditada: startAtMs <= replacementMs consumes', async () => {
  var fix = makeReplacedPlanFixture({
    clientActivatedAt: NOW_ISO,
    startMarker: {
      planId: 'plan-old',
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: new Date(NOW_MS - 5000).toISOString()
    }
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, true);
  assert.equal(res[0].reason, null);
  var meso = db._docs.get('logs/' + fix.clientId + '/mesos/' + fix.oldPlanId);
  assert.equal(meso.progressionApplications[fix.key].state, 'CONSUMED');
});

// 4. Exposición posterior a la sustitución
test('T687 — 4. Exposición posterior a la sustitución: startAtMs > replacementMs fails with PLAN_MISMATCH', async () => {
  var fix = makeReplacedPlanFixture({
    clientActivatedAt: new Date(NOW_MS - 10000).toISOString(),
    newPlanCreatedAt: new Date(NOW_MS - 10000).toISOString(),
    startMarker: {
      planId: 'plan-old',
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: new Date(NOW_MS - 1000).toISOString() // Exposure started 9 seconds AFTER plan substitution
    }
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

// 5. Sustitución sin fecha confiable
test('T687 — 5. Sustitución sin fecha confiable: missing substitution date fails closed without guessing dates', async () => {
  var fix = makeReplacedPlanFixture({
    clientActivatedAt: null,
    newPlanCreatedAt: null,
    startMarker: {
      planId: 'plan-old',
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: new Date(NOW_MS - 1000).toISOString()
    }
  });
  // Clear any replacement date candidate
  delete fix.seed['clients/' + fix.clientId].activePlanActivatedAt;
  delete fix.seed['plans/plan-new'].createdAt;
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

// 6. Plan revocado, suspendido o desactivado
test('T687 — 6. Plan revocado, suspendido o desactivado: active === false blocks consume', async () => {
  var fix = makeReplacedPlanFixture({
    oldPlanActive: false
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T687 — 6. Plan revocado, suspendido o desactivado: status === suspended blocks consume', async () => {
  var fix = makeReplacedPlanFixture({
    oldPlanStatus: 'suspended'
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T687 — 6. Plan revocado, suspendido o desactivado: status === draft blocks consume', async () => {
  var fix = makeReplacedPlanFixture({
    oldPlanStatus: 'draft'
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

// 7. Idempotencia
test('T687 — 7. Idempotencia: replay of consumePending does not re-consume or corrupt state', async () => {
  var fix = makeReplacedPlanFixture();
  var db = makeFakeDb(fix.seed);
  var first = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(first[0].written, true);
  var second = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  // Second run has 0 pending APPLIED records to consume because it is already CONSUMED
  assert.equal(second.length, 0);
  var meso = db._docs.get('logs/' + fix.clientId + '/mesos/' + fix.oldPlanId);
  assert.equal(meso.progressionApplications[fix.key].state, 'CONSUMED');
});

// 8. Aislamiento multicliente
test('T687 — 8. Aislamiento multicliente: tenant client mismatch is blocked', async () => {
  var fix = makeReplacedPlanFixture({ clientId: 'client-A' });
  // Try to consume plan for client-B while plan belongs to client-A
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, 'client-B', fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 0); // No records found in client-B's mesos
});

// 9. Contratos PENDING → APPLIED → CONSUMED
test('T687 — 9. Contratos PENDING -> APPLIED -> CONSUMED: full lifecycle adheres to transition invariants', async () => {
  var clientId = 'client-lifecycle';
  var planId = 'plan-life';
  var coachId = 'coach-life';
  var pid = 'pid-press';
  var key = 'v1_0123456789abcdef';

  var pendingRec = {
    key: key,
    revision: 1,
    clientId: clientId,
    planId: planId,
    prescriptionExerciseId: pid,
    state: 'PENDING',
    source: { week: 1, dayIndex: 0, calculatedAt: NOW_ISO },
    nextExposure: { week: 1, dayIndex: 2 },
    magnitude: {
      schema: 'vdsen-magnitude-shadow-v1',
      mode: 'SHADOW',
      numericApplyAllowed: false,
      eligible: true,
      comparableExposureCount: 2,
      minExposures: 2,
      directionConsistency: 'CONSISTENT',
      direction: 'UP',
      coachReviewRequired: false,
      candidates: [{ dimension: 'REPS', previousValue: 10, rawCandidate: 11, finalCandidate: 11 }]
    },
    events: []
  };
  var planDoc = {
    clientId: clientId,
    coachId: coachId,
    status: 'active',
    active: true,
    weeks: 4,
    updatedAt: '2026-10-01T00:00:00.000Z',
    days: [
      { dayIndex: 0, exercises: [{ prescriptionExerciseId: pid }] },
      { dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }
    ]
  };
  var seed = {
    ['clients/' + clientId]: {
      uid: clientId,
      activePlanId: planId,
      coachId: coachId,
      status: 'active'
    },
    ['coaches/' + coachId]: {
      uid: coachId,
      autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] }
    },
    ['plans/' + planId]: planDoc,
    ['releaseControl/autonomousProgression']: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      expiresAt: '2026-12-01T00:00:00.000Z',
      clientIds: [clientId]
    },
    ['logs/' + clientId + '/mesos/' + planId]: {
      planId: planId,
      progressionApplications: { [key]: pendingRec },
      nextExposureOverlays: {},
      entries: {} // Target exposure has not started yet
    }
  };

  var db = makeFakeDb(seed);
  // Step 1: applyPending transitions PENDING -> APPLIED
  var appliedRes = await executor.applyPending(db, clientId, planId, () => NOW_ISO);
  assert.equal(appliedRes.length, 1);
  assert.equal(appliedRes[0].written, true, 'Reason was: ' + (appliedRes[0] && appliedRes[0].reason));

  var mesoAfterApply = db._docs.get('logs/' + clientId + '/mesos/' + planId);
  assert.equal(mesoAfterApply.progressionApplications[key].state, 'APPLIED');
  assert.ok(mesoAfterApply.nextExposureOverlays['ovl_' + key], 'Overlay was written');

  // Step 2: Athlete executes the target exposure and appends consumption receipt
  mesoAfterApply.entries = {
    'log_1_2_0_s0': { done: true, prescriptionExerciseId: pid, reps: '11', sts: NOW_MS }
  };
  db._docs.set('logs/' + clientId + '/starts/' + planId + '_1_2_0', {
    planId: planId,
    week: 1,
    dayIndex: 2,
    exerciseIndex: 0,
    setKey: 'log_1_2_0_s0',
    at: NOW_ISO
  });
  mesoAfterApply.consumptionReceipts = {
    [key]: {
      recordKey: key,
      overlayKey: 'ovl_' + key,
      dimension: 'REPS',
      appliedValue: 11,
      provenance: 'CANONICAL_OVERLAY',
      ackAt: NOW_ISO
    }
  };

  // Step 3: consumePending transitions APPLIED -> CONSUMED
  var consumeRes = await executor.consumePending(db, clientId, planId, () => NOW_ISO);
  assert.equal(consumeRes.length, 1);
  assert.equal(consumeRes[0].written, true);

  var mesoAfterConsume = db._docs.get('logs/' + clientId + '/mesos/' + planId);
  assert.equal(mesoAfterConsume.progressionApplications[key].state, 'CONSUMED');
});

// 10. Compatibilidad con T532, T599, T685 y T686
test('T687 — 10. Compatibilidad: processProgression disarmed when enabled=false', async () => {
  var res = await executor.processProgression({ enabled: false });
  assert.deepEqual(res, { status: 'DISARMED', writes: 0 });
});

test('T687 — 10. Compatibilidad: processProgression performs NO writes when numericApplyEnabled=false', async () => {
  var clientId = 'client-disarmed';
  var planId = 'plan-disarmed';
  var coachId = 'coach-disarmed';
  var pid = 'pid-arm';
  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: planId, coachId: coachId, status: 'active' },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: { clientId: clientId, coachId: coachId, status: 'active', active: true, weeks: 4, days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: pid }] }] },
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-12-01T00:00:00.000Z', clientIds: [clientId] },
    ['logs/' + clientId + '/mesos/' + planId]: { planId: planId, entries: {} }
  };
  var db = makeFakeDb(seed);
  var res = await executor.processProgression({
    db: db,
    clientId: clientId,
    planId: planId,
    enabled: true,
    numericApplyEnabled: false, // NUMERIC DISARMED
    clock: () => NOW_ISO
  });
  assert.equal(res.applied.length, 0);
  assert.equal(res.consumed.length, 0);
});
