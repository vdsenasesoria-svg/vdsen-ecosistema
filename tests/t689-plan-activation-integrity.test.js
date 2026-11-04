'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const executor = require('../api/_autonomousProgression.js');
const eligibility = require('../api/_clientEligibility.js');

const NOW_ISO = '2026-11-03T16:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

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

function makeFixture(opts) {
  opts = opts || {};
  var clientId = opts.clientId || 'client-t689-1';
  var coachId = opts.coachId || 'coach-t689-1';
  var oldPlanId = opts.oldPlanId || 'plan-old-689';
  var newPlanId = opts.newPlanId || 'plan-new-689';
  var pid = opts.pid || 'pid-sq-689';
  var key = 'v1_t689_record_001';

  var rec = {
    key: key,
    revision: 2,
    clientId: clientId,
    planId: oldPlanId,
    prescriptionExerciseId: pid,
    state: 'APPLIED',
    lifecycle: { overlayKey: 'ovl_' + key },
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-20T00:00:00.000Z' },
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
    appliedValue: 125,
    previousValue: 120,
    unit: 'KG',
    target: { week: 1, dayIndex: 2 }
  };

  var receipt = {
    recordKey: key,
    overlayKey: 'ovl_' + key,
    dimension: 'LOAD',
    appliedValue: 125,
    provenance: 'CANONICAL_OVERLAY',
    ackAt: NOW_ISO
  };

  var oldPlanDoc = {
    clientId: clientId,
    coachId: coachId,
    status: 'active',
    weeks: 4,
    updatedAt: '2026-10-20T00:00:00.000Z',
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
        'log_1_2_0_s0': { done: true, prescriptionExerciseId: pid, carga: '125', reps: '8', unit: 'KG', sts: opts.startAtMs || NOW_MS }
      }
    },
    ['logs/' + clientId + '/starts/' + oldPlanId + '_1_2_0']: {
      planId: oldPlanId,
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: opts.startAtIso || new Date(opts.startAtMs || NOW_MS).toISOString()
    }
  };

  if (opts.clientActivatedAt !== undefined) {
    seed['clients/' + clientId].activePlanActivatedAt = opts.clientActivatedAt;
  }
  if (opts.includeNewPlan !== false) {
    seed['plans/' + newPlanId] = {
      clientId: opts.newPlanClientId || clientId,
      coachId: opts.newPlanCoachId || coachId,
      status: opts.newPlanStatus || 'active',
      active: opts.newPlanActive !== undefined ? opts.newPlanActive : true,
      weeks: 4,
      days: [],
      createdAt: opts.newPlanCreatedAt || '2026-10-25T00:00:00.000Z',
      activatedAt: opts.newPlanActivatedAt || null
    };
  }
  if (opts.activationRecord !== undefined) {
    seed['clients/' + clientId + '/plan_activations/' + newPlanId] = opts.activationRecord;
  }

  return {
    clientId: clientId,
    coachId: coachId,
    oldPlanId: oldPlanId,
    newPlanId: newPlanId,
    key: key,
    seed: seed
  };
}

// ── T689 Tests ──────────────────────────────────────────────────────────────

test('T689.1 - Nuevo plan inexistente en Firestore con fecha de activación en cliente falla cerrado con PLAN_MISMATCH', async () => {
  var fix = makeFixture({
    includeNewPlan: false, // El documento plans/plan-new-689 NO existe
    clientActivatedAt: '2026-11-03T12:00:00.000Z', // Cliente conserva fecha de activación
    startAtIso: '2026-11-03T10:00:00.000Z',
    startAtMs: Date.parse('2026-11-03T10:00:00.000Z')
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH', 'Inexistent new plan must fail closed');
});

test('T689.2 - Sustitución no autorizada: nuevo plan pertenece a otro cliente produce PLAN_MISMATCH', async () => {
  var fix = makeFixture({
    newPlanClientId: 'foreign-client-999', // Plan ajeno
    clientActivatedAt: '2026-11-03T12:00:00.000Z',
    startAtIso: '2026-11-03T10:00:00.000Z',
    startAtMs: Date.parse('2026-11-03T10:00:00.000Z')
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH', 'Cross-client new plan must fail closed');
});

test('T689.3 - Sustitución no autorizada: nuevo plan pertenece a otro coach produce PLAN_MISMATCH', async () => {
  var fix = makeFixture({
    newPlanCoachId: 'foreign-coach-888', // Coach ajeno
    clientActivatedAt: '2026-11-03T12:00:00.000Z',
    startAtIso: '2026-11-03T10:00:00.000Z',
    startAtMs: Date.parse('2026-11-03T10:00:00.000Z')
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH', 'Cross-coach new plan must fail closed');
});

test('T689.4 - Sustitución con plan revocado o active===false produce PLAN_MISMATCH', async () => {
  var fixRevoked = makeFixture({
    newPlanStatus: 'revoked',
    clientActivatedAt: '2026-11-03T12:00:00.000Z',
    startAtIso: '2026-11-03T10:00:00.000Z',
    startAtMs: Date.parse('2026-11-03T10:00:00.000Z')
  });
  var db1 = makeFakeDb(fixRevoked.seed);
  var res1 = await executor.consumePending(db1, fixRevoked.clientId, fixRevoked.oldPlanId, () => NOW_ISO);
  assert.equal(res1[0].written, false);
  assert.equal(res1[0].reason, 'PLAN_MISMATCH');

  var fixInactive = makeFixture({
    newPlanActive: false,
    clientActivatedAt: '2026-11-03T12:00:00.000Z',
    startAtIso: '2026-11-03T10:00:00.000Z',
    startAtMs: Date.parse('2026-11-03T10:00:00.000Z')
  });
  var db2 = makeFakeDb(fixInactive.seed);
  var res2 = await executor.consumePending(db2, fixInactive.clientId, fixInactive.oldPlanId, () => NOW_ISO);
  assert.equal(res2[0].written, false);
  assert.equal(res2[0].reason, 'PLAN_MISMATCH');
});

test('T689.5 - Registro inmutable plan_activations: fecha de servidor autoritativa valida consumo legítimo anterior', async () => {
  var fix = makeFixture({
    startAtIso: '2026-11-03T09:00:00.000Z',
    startAtMs: Date.parse('2026-11-03T09:00:00.000Z'),
    activationRecord: {
      id: 'plan-new-689',
      clientId: 'client-t689-1',
      coachId: 'coach-t689-1',
      newPlanId: 'plan-new-689',
      previousPlanId: 'plan-old-689',
      at: '2026-11-03T11:00:00.000Z' // Activado a las 11:00
    }
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, true, 'Legitimate exposure before immutable activation timestamp must consume');
  assert.equal(res[0].reason, null);

  var meso = db._docs.get('logs/' + fix.clientId + '/mesos/' + fix.oldPlanId);
  assert.equal(meso.progressionApplications[fix.key].state, 'CONSUMED');
});

test('T689.6 - Registro inmutable plan_activations: exposición posterior a fecha autoritativa produce PLAN_MISMATCH', async () => {
  var fix = makeFixture({
    startAtIso: '2026-11-03T13:00:00.000Z', // Exposición empezó a las 13:00 (posterior a la activación)
    startAtMs: Date.parse('2026-11-03T13:00:00.000Z'),
    activationRecord: {
      id: 'plan-new-689',
      clientId: 'client-t689-1',
      coachId: 'coach-t689-1',
      newPlanId: 'plan-new-689',
      previousPlanId: 'plan-old-689',
      at: '2026-11-03T11:00:00.000Z' // Activado a las 11:00
    }
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH', 'Exposure posterior to activation record must be blocked');
});

test('T689.7 - Registro inmutable contradictorio: previousPlanId no coincide con plan en consumo produce PLAN_MISMATCH', async () => {
  var fix = makeFixture({
    startAtIso: '2026-11-03T09:00:00.000Z',
    startAtMs: Date.parse('2026-11-03T09:00:00.000Z'),
    activationRecord: {
      id: 'plan-new-689',
      clientId: 'client-t689-1',
      coachId: 'coach-t689-1',
      newPlanId: 'plan-new-689',
      previousPlanId: 'different-plan-xyz', // Contradicción con oldPlanId
      at: '2026-11-03T11:00:00.000Z'
    }
  });

  var db = makeFakeDb(fix.seed);
  var res = await executor.consumePending(db, fix.clientId, fix.oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH', 'Contradictory activation record must fail closed');
});
