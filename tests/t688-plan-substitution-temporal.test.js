'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const executor = require('../api/_autonomousProgression.js');
const eligibility = require('../api/_clientEligibility.js');

const NOW_ISO = '2026-11-03T14:00:00.000Z';
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

function makeSubstitutionFixture(opts) {
  opts = opts || {};
  var clientId = opts.clientId || 'client-t688';
  var oldPlanId = opts.oldPlanId || 'plan-old-688';
  var newPlanId = opts.newPlanId || 'plan-new-688';
  var coachId = opts.coachId || 'coach-688';
  var pid = opts.pid || 'pid-bench';
  var key = opts.key || 'v1_0123456789abcdef';

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
      activePlanId: newPlanId,
      coachId: coachId,
      status: 'active'
    },
    ['coaches/' + coachId]: {
      uid: coachId,
      autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] }
    },
    ['plans/' + oldPlanId]: oldPlanDoc,
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
        'log_1_2_0_s0': { done: true, prescriptionExerciseId: pid, carga: '102.5', reps: '8', unit: 'KG', sts: opts.startAtMs || NOW_MS }
      }
    }
  };

  if (opts.clientActivatedAt !== undefined) {
    seed['clients/' + clientId].activePlanActivatedAt = opts.clientActivatedAt;
  }
  if (opts.clientPlanChangedAt !== undefined) {
    seed['clients/' + clientId].planChangedAt = opts.clientPlanChangedAt;
  }
  if (opts.oldPlanSupersededAt !== undefined) {
    seed['plans/' + oldPlanId].supersededAt = opts.oldPlanSupersededAt;
    seed['plans/' + oldPlanId].supersededBy = newPlanId;
  }

  if (opts.includeNewPlan !== false) {
    seed['plans/' + newPlanId] = {
      clientId: clientId,
      coachId: coachId,
      status: 'active',
      weeks: 4,
      days: [],
      createdAt: opts.newPlanCreatedAt !== undefined ? opts.newPlanCreatedAt : '2026-10-25T00:00:00.000Z'
    };
    if (opts.newPlanActivatedAt !== undefined) {
      seed['plans/' + newPlanId].activatedAt = opts.newPlanActivatedAt;
    }
  }

  if (opts.startMarker !== null) {
    seed['logs/' + clientId + '/starts/' + oldPlanId + '_1_2_0'] = opts.startMarker || {
      planId: oldPlanId,
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: opts.startAtIso || NOW_ISO
    };
  }

  return { seed: seed, clientId: clientId, oldPlanId: oldPlanId, newPlanId: newPlanId, key: key };
}

// 1. Creación anterior a activación
test('T688 — 1. Creación anterior a activación: plan creation time is strictly distinct and earlier than activation time', () => {
  var createIso = '2026-10-25T10:00:00.000Z';
  var activateIso = '2026-11-03T12:00:00.000Z';
  var createMs = eligibility.parseWallClockMs(createIso);
  var activateMs = eligibility.parseWallClockMs(activateIso);
  assert.ok(createMs < activateMs, 'Creation time must be earlier than activation time');
});

// 2. Exposición legítima entre ambos eventos (T688 Core Defect Fix)
test('T688 — 2. Exposición legítima entre creación y activación: exposure started AFTER plan creation but BEFORE activation consumes successfully', async () => {
  var planCreatedIso = '2026-10-25T10:00:00.000Z';  // Plan drafted 9 days earlier
  var exposureStartIso = '2026-11-03T10:00:00.000Z'; // Athlete started training at 10:00
  var planActivatedIso = '2026-11-03T12:00:00.000Z'; // Coach activated new plan at 12:00

  var fix = makeSubstitutionFixture({
    newPlanCreatedAt: planCreatedIso,
    newPlanActivatedAt: planActivatedIso,
    startAtIso: exposureStartIso,
    startAtMs: Date.parse(exposureStartIso)
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, true, 'Legitimate exposure prior to activation must consume');
  assert.equal(res[0].reason, null);

  var meso = db._docs.get('logs/' + fix.clientId + '/mesos/' + fix.oldPlanId);
  assert.equal(meso.progressionApplications[fix.key].state, 'CONSUMED');
});

// 3. Exposición posterior a activación
test('T688 — 3. Exposición posterior a activación: exposure started AFTER plan activation is blocked', async () => {
  var planActivatedIso = '2026-11-03T12:00:00.000Z'; // Coach activated new plan at 12:00
  var exposureStartIso = '2026-11-03T13:30:00.000Z'; // Athlete started exposure 1.5h AFTER activation

  var fix = makeSubstitutionFixture({
    newPlanActivatedAt: planActivatedIso,
    startAtIso: exposureStartIso,
    startAtMs: Date.parse(exposureStartIso)
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false, 'Exposure started after activation must be blocked');
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

// 4. Fecha ausente
test('T688 — 4. Fecha ausente: client switched plans but no activation timestamp exists fails closed without guessing dates', async () => {
  var fix = makeSubstitutionFixture({
    newPlanCreatedAt: '2026-10-25T10:00:00.000Z',
    // No activatedAt on new plan
    // No activePlanActivatedAt on client
    // No supersededAt on old plan
    startAtIso: '2026-11-03T10:00:00.000Z',
    startAtMs: Date.parse('2026-11-03T10:00:00.000Z')
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

// 5. Nuevo plan inexistente
test('T688 — 5. Nuevo plan inexistente: activePlanId references missing plan doc and has no activation date fails closed', async () => {
  var fix = makeSubstitutionFixture({
    includeNewPlan: false, // plans/plan-new-688 does not exist
    startAtIso: '2026-11-03T10:00:00.000Z',
    startAtMs: Date.parse('2026-11-03T10:00:00.000Z')
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

// 6. Idempotencia
test('T688 — 6. Idempotencia: replay of consumePending produces 0 additional writes', async () => {
  var planActivatedIso = '2026-11-03T12:00:00.000Z';
  var exposureStartIso = '2026-11-03T10:00:00.000Z';

  var fix = makeSubstitutionFixture({
    newPlanActivatedAt: planActivatedIso,
    startAtIso: exposureStartIso,
    startAtMs: Date.parse(exposureStartIso)
  });

  var db = makeFakeDb(fix.seed);
  var res1 = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res1[0].written, true);

  var res2 = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res2.length, 0, 'Second run must have 0 pending items to consume');

  var meso = db._docs.get('logs/' + fix.clientId + '/mesos/' + fix.oldPlanId);
  assert.equal(meso.progressionApplications[fix.key].state, 'CONSUMED');
});

// 7. Aislamiento de clientes
test('T688 — 7. Aislamiento de clientes: operations for another client are completely isolated', async () => {
  var fix = makeSubstitutionFixture({
    clientId: 'client-isolated-1'
  });
  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, 'client-isolated-2', fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 0);
});

// 8. Compatibilidad T532
test('T688 — 8. Compatibilidad T532: started old exposure with valid client-stamped activation consumes coherently', async () => {
  var fix = makeSubstitutionFixture({
    clientActivatedAt: NOW_ISO,
    startAtIso: new Date(NOW_MS - 5000).toISOString(),
    startAtMs: NOW_MS - 5000
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, true);
  assert.equal(res[0].reason, null);

  var meso = db._docs.get('logs/' + fix.clientId + '/mesos/' + fix.oldPlanId);
  assert.equal(meso.progressionApplications[fix.key].state, 'CONSUMED');
});

test('T688 — 8. Compatibilidad T532: old plan supersededAt also satisfies substitution chronology', async () => {
  var fix = makeSubstitutionFixture({
    oldPlanSupersededAt: NOW_ISO,
    startAtIso: new Date(NOW_MS - 5000).toISOString(),
    startAtMs: NOW_MS - 5000
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, true);
  assert.equal(res[0].reason, null);

  var meso = db._docs.get('logs/' + fix.clientId + '/mesos/' + fix.oldPlanId);
  assert.equal(meso.progressionApplications[fix.key].state, 'CONSUMED');
});
