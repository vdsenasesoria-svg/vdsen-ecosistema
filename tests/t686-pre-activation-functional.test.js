'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Isolated synthetic authorization allows these plan-validation tests to reach
// the general engine. Production authority is covered separately by T699.
const executor = require('./helpers/t699-synthetic-executor.js');
const eligibility = require('../api/_clientEligibility.js');
const fleetReport = require('../scripts/fleet/eligibility-report.cjs');
const consumer = require('../assets/progression-application-consumer.js');
const shadow = require('../assets/progression-auto-apply-shadow.js');
const effective = require('../assets/progression-effective-prescription.js');

const NOW_ISO = '2026-10-15T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const DAY_MS = 86400000;

function makeFakeDb(seedDocs) {
  var docs = new Map(Object.entries(seedDocs || {}));

  function makeRef(docPath) {
    return {
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
          docs.set(docPath, structuredClone(data));
        }
      }
    };
  }

  function makeSnap(docPath) {
    var val = docs.get(docPath);
    var updMs = val && val.updatedAt ? Date.parse(val.updatedAt) : NOW_MS;
    return {
      exists: val !== undefined,
      data: function() { return val !== undefined ? structuredClone(val) : undefined; },
      updateTime: { toMillis: function() { return Number.isFinite(updMs) ? updMs : NOW_MS; } }
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
            docs.set(p, structuredClone(data));
          }
        }
      };
      return fn(tx);
    },
    _docs: docs
  };
}

function makeCanonicalProgressionRecord(opts) {
  opts = opts || {};
  var key = opts.key || 'v1_0123456789abcdef';
  var dim = opts.dimension || 'REPS';
  var cand = dim === 'REPS'
    ? { dimension: 'REPS', previousValue: 10, rawCandidate: 11, finalCandidate: 11 }
    : dim === 'REST'
    ? { dimension: 'REST', previousValue: 90, rawCandidate: 75, finalCandidate: 75 }
    : { dimension: 'LOAD', previousValue: 100, rawCandidate: 102.5, finalCandidate: 102.5 };

  return {
    key: key,
    revision: 1,
    clientId: opts.clientId || 'c1',
    planId: opts.planId || 'plan-1',
    prescriptionExerciseId: opts.pid || 'pid-press',
    state: opts.state || 'PENDING',
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
      candidates: [cand]
    },
    events: []
  };
}

test('T686 — CAMBIO 1: Progression REPS blocked when plan is suspended before applyPending', async () => {
  var clientId = 'client-reps-1', planId = 'plan-reps-1', coachId = 'coach-1', pid = 'pid-press';
  var record = makeCanonicalProgressionRecord({ clientId: clientId, planId: planId, pid: pid, dimension: 'REPS' });
  var planDoc = {
    clientId: clientId,
    coachId: coachId,
    status: 'suspended', // Suspended plan!
    days: [{ dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }]
  };
  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: planId, coachId: coachId, status: 'active' },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: planDoc,
    ['releaseControl/autonomousProgression']: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      expiresAt: '2026-11-01T00:00:00.000Z',
      clientIds: [clientId]
    },
    ['logs/' + clientId + '/mesos/' + planId]: {
      planId: planId,
      progressionApplications: { [record.key]: record }
    }
  };
  var db = makeFakeDb(seed);
  executor.setSyntheticWindow({ uid: clientId, planId });
  var res = await executor.applyPending(db, clientId, planId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T686 — CAMBIO 1: Progression REST blocked when plan is revoked before applyPending', async () => {
  var clientId = 'client-rest-1', planId = 'plan-rest-1', coachId = 'coach-1', pid = 'pid-press';
  var record = makeCanonicalProgressionRecord({ clientId: clientId, planId: planId, pid: pid, dimension: 'REST' });
  var planDoc = {
    clientId: clientId,
    coachId: coachId,
    status: 'revoked', // Revoked plan!
    days: [{ dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }]
  };
  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: planId, coachId: coachId, status: 'active' },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: planDoc,
    ['releaseControl/autonomousProgression']: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      expiresAt: '2026-11-01T00:00:00.000Z',
      clientIds: [clientId]
    },
    ['logs/' + clientId + '/mesos/' + planId]: {
      planId: planId,
      progressionApplications: { [record.key]: record }
    }
  };
  var db = makeFakeDb(seed);
  executor.setSyntheticWindow({ uid: clientId, planId });
  var res = await executor.applyPending(db, clientId, planId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T686 — CAMBIO 1: Progression blocked when plan coachId or clientId does not match client doc', async () => {
  var clientId = 'client-mismatch-1', planId = 'plan-mismatch-1', coachId = 'coach-1', pid = 'pid-press';
  var record = makeCanonicalProgressionRecord({ clientId: clientId, planId: planId, pid: pid, dimension: 'REPS' });
  var planDocAlienCoach = {
    clientId: clientId,
    coachId: 'coach-alien', // Alien coach!
    status: 'active',
    days: [{ dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }]
  };
  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: planId, coachId: coachId, status: 'active' },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: planDocAlienCoach,
    ['releaseControl/autonomousProgression']: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      expiresAt: '2026-11-01T00:00:00.000Z',
      clientIds: [clientId]
    },
    ['logs/' + clientId + '/mesos/' + planId]: {
      planId: planId,
      progressionApplications: { [record.key]: record }
    }
  };
  var db = makeFakeDb(seed);
  executor.setSyntheticWindow({ uid: clientId, planId });
  var res = await executor.applyPending(db, clientId, planId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T686 — CAMBIO 1: consumePending blocked when plan is revoked or suspended', async () => {
  var clientId = 'client-c-1', planId = 'plan-c-1', coachId = 'coach-1', pid = 'pid-press';
  var key = 'v1_0123456789abcdef';
  var rec = {
    key: key,
    revision: 2,
    clientId: clientId,
    planId: planId,
    prescriptionExerciseId: pid,
    state: 'APPLIED',
    source: { week: 1, dayIndex: 0, calculatedAt: NOW_ISO },
    nextExposure: { week: 1, dayIndex: 2 }
  };
  var ovl = {
    key: 'ovl_' + key,
    sourceRecordKey: key,
    clientId: clientId,
    planId: planId,
    prescriptionExerciseId: pid,
    dimension: 'REPS',
    status: 'APPLIED',
    appliedValue: 11,
    previousValue: 10,
    target: { week: 1, dayIndex: 2 }
  };
  var receipt = {
    recordKey: key,
    overlayKey: 'ovl_' + key,
    dimension: 'REPS',
    appliedValue: 11,
    provenance: 'CANONICAL_OVERLAY',
    ackAt: NOW_ISO
  };
  var planDoc = {
    clientId: clientId,
    coachId: coachId,
    status: 'revoked', // Revoked!
    days: [{ dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }]
  };
  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: planId, coachId: coachId, status: 'active' },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: planDoc,
    ['releaseControl/autonomousProgression']: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      expiresAt: '2026-11-01T00:00:00.000Z',
      clientIds: [clientId]
    },
    ['logs/' + clientId + '/mesos/' + planId]: {
      planId: planId,
      progressionApplications: { [key]: rec },
      nextExposureOverlays: { ['ovl_' + key]: ovl },
      consumptionReceipts: { [key]: receipt },
      entries: {
        'log_1_2_0_s0': { done: true, prescriptionExerciseId: pid, carga: '100', reps: '11', unit: 'KG', sts: NOW_MS }
      }
    }
  };
  var db = makeFakeDb(seed);
  var res = await executor.consumePending(db, clientId, planId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T686 — CAMBIO 1: consumePending succeeds for replaced plan when exposure legitimately started before replacement (T532 test 7 contract)', async () => {
  var clientId = 'client-c-2', oldPlanId = 'plan-old', newPlanId = 'plan-new', coachId = 'coach-1', pid = 'pid-press';
  var key = 'v1_0123456789abcdef';
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
    dimension: 'REPS',
    status: 'APPLIED',
    appliedValue: 11,
    previousValue: 10,
    target: { week: 1, dayIndex: 2 }
  };
  var receipt = {
    recordKey: key,
    overlayKey: 'ovl_' + key,
    dimension: 'REPS',
    appliedValue: 11,
    provenance: 'CANONICAL_OVERLAY',
    ackAt: NOW_ISO
  };
  var oldPlanDoc = {
    clientId: clientId,
    coachId: coachId,
    status: 'active',
    weeks: 4,
    updatedAt: '2026-10-01T00:00:00.000Z',
    days: [
      { dayIndex: 0, exercises: [{ prescriptionExerciseId: pid }] },
      { dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }
    ]
  };
  var seed = {
    // Client now has activePlanId = newPlanId!
    ['clients/' + clientId]: { uid: clientId, activePlanId: newPlanId, coachId: coachId, status: 'active', activePlanActivatedAt: NOW_ISO },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + oldPlanId]: oldPlanDoc,
    ['plans/' + newPlanId]: { clientId: clientId, coachId: coachId, status: 'active', activatedAt: NOW_ISO },
    ['releaseControl/autonomousProgression']: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      expiresAt: '2026-11-01T00:00:00.000Z',
      clientIds: [clientId]
    },
    ['logs/' + clientId + '/starts/' + oldPlanId + '_1_2_0']: {
      planId: oldPlanId,
      week: 1,
      dayIndex: 2,
      exerciseIndex: 0,
      setKey: 'log_1_2_0_s0',
      at: new Date(NOW_MS - 1000).toISOString()
    },
    ['logs/' + clientId + '/mesos/' + oldPlanId]: {
      planId: oldPlanId,
      progressionApplications: { [key]: rec },
      nextExposureOverlays: { ['ovl_' + key]: ovl },
      consumptionReceipts: { [key]: receipt },
      entries: {
        // Legitimate execution of the target exposure
        'log_1_2_0_s0': { done: true, prescriptionExerciseId: pid, carga: '100', reps: '11', unit: 'KG', sts: NOW_MS - 1000 }
      }
    }
  };
  var db = makeFakeDb(seed);
  var res = await executor.consumePending(db, clientId, oldPlanId, () => NOW_ISO);
  assert.equal(res[0].reason, null, 'Expected no reason error, got ' + res[0].reason);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, true);
  var updatedMeso = db._docs.get('logs/' + clientId + '/mesos/' + oldPlanId);
  assert.equal(updatedMeso.progressionApplications[key].state, 'CONSUMED');
});
test('T686 — CAMBIO 1: consumePending refuses replaced plan when target exposure was NOT started', async () => {
  var clientId = 'client-c-3', oldPlanId = 'plan-old', newPlanId = 'plan-new', coachId = 'coach-1', pid = 'pid-press';
  var key = 'v1_0123456789abcdef';
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
    dimension: 'REPS',
    status: 'APPLIED',
    appliedValue: 11,
    previousValue: 10,
    target: { week: 1, dayIndex: 2 }
  };
  var receipt = {
    recordKey: key,
    overlayKey: 'ovl_' + key,
    dimension: 'REPS',
    appliedValue: 11,
    provenance: 'CANONICAL_OVERLAY',
    ackAt: NOW_ISO
  };
  var oldPlanDoc = {
    clientId: clientId,
    coachId: coachId,
    status: 'active',
    weeks: 4,
    updatedAt: '2026-10-01T00:00:00.000Z',
    days: [{ dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }]
  };
  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: newPlanId, coachId: coachId, status: 'active' },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + oldPlanId]: oldPlanDoc,
    ['plans/' + newPlanId]: { clientId: clientId, coachId: coachId, status: 'active', activatedAt: NOW_ISO },
    ['releaseControl/autonomousProgression']: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      expiresAt: '2026-11-01T00:00:00.000Z',
      clientIds: [clientId]
    },
    ['logs/' + clientId + '/mesos/' + oldPlanId]: {
      planId: oldPlanId,
      progressionApplications: { [key]: rec },
      nextExposureOverlays: { ['ovl_' + key]: ovl },
      consumptionReceipts: { [key]: receipt },
      entries: {} // Target exposure was NOT started!
    }
  };
  var db = makeFakeDb(seed);
  var res = await executor.consumePending(db, clientId, oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T686 — CAMBIO 2: Fleet eligibility evaluates with authentic real identifiers and authentic starts, outputting redacted identifiers only', async () => {
  var realUid1 = 'client_authentic_uid_1';
  var realUid2 = 'client_authentic_uid_2';
  var realPlanId1 = 'plan_canonical_1';
  var coachId = 'coach_alpha';

  var S = (s) => ({ stringValue: s });
  var enc = (v) => v === null ? { nullValue: null } : typeof v === 'string' ? S(v) : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };

  var plan1 = {
    updatedAt: '2026-09-20T00:00:00.000Z',
    status: 'active',
    clientId: realUid1,
    coachId: coachId,
    days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: 'pid1', repsRange: { min: 8, max: 12 } }] }]
  };

  var entries1 = {
    log_1_0_0_s0: { done: true, prescriptionExerciseId: 'pid1', ts: NOW_MS - 4 * DAY_MS, sts: NOW_MS - 4 * DAY_MS },
    log_2_0_0_s0: { done: true, prescriptionExerciseId: 'pid1', ts: NOW_MS - 2 * DAY_MS, sts: NOW_MS - 2 * DAY_MS }
  };

  var starts1 = {
    [realPlanId1 + '_1_0_0']: { planId: realPlanId1, week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(NOW_MS - 4 * DAY_MS).toISOString() },
    [realPlanId1 + '_2_0_0']: { planId: realPlanId1, week: 2, dayIndex: 0, exerciseIndex: 0, setKey: 'log_2_0_0_s0', at: new Date(NOW_MS - 2 * DAY_MS).toISOString() }
  };

  var docs = {
    ['plans/' + realPlanId1]: { fields: Object.fromEntries(Object.entries(plan1).map(([k, v]) => [k, enc(v)])) },
    ['logs/' + realUid1]: { fields: { entries: enc(entries1) } },
    ['logs/' + realUid2]: { fields: { entries: enc({}) } },
    ['releaseControl/autonomousProgression']: {
      fields: {
        schema: S('vdsen-autonomous-release-v1'),
        enabled: { booleanValue: true },
        expiresAt: S('2026-11-01T00:00:00.000Z'),
        clientIds: { arrayValue: { values: [S(realUid1)] } }
      }
    },
    ['coaches/' + coachId]: {
      fields: {
        autoApplyCanary: {
          mapValue: {
            fields: {
              enabled: { booleanValue: true },
              clientIds: { arrayValue: { values: [S(realUid1)] } },
              prescriptionExerciseIds: { arrayValue: { values: [] } }
            }
          }
        }
      }
    }
  };

  var http = async (p) => {
    return docs[p] ? { status: 200, body: docs[p] } : { status: 404, body: null };
  };

  var list = async () => ({
    documents: [
      { name: 'projects/p/databases/(default)/documents/clients/' + realUid1, fields: { activePlanId: S(realPlanId1), coachId: S(coachId), status: S('active') } },
      { name: 'projects/p/databases/(default)/documents/clients/' + realUid2, fields: { status: S('active') } }
    ]
  });

  var logLines = [];
  var result = await fleetReport.main(['--detail', '--cohorts'], {
    http: http,
    list: list,
    token: () => 'fake-token',
    log: (l) => logLines.push(l),
    now: NOW_ISO,
    starts: { [realUid1]: starts1 }
  });

  // 1. Technical counts reflect 1 NO_ACTIVE_PLAN and 1 ELIGIBLE
  assert.equal(result.counts.ELIGIBLE, 1);
  assert.equal(result.counts.NO_ACTIVE_PLAN, 1);

  // 2. Evaluated internally with real UID: authentic authorized status is true for realUid1
  var row1 = result.rows.find((r) => r.technicalState === 'ELIGIBLE');
  assert.ok(row1);
  assert.equal(row1.eligible, true);
  assert.equal(row1.priority, 'PRIORITY_A');
  assert.equal(row1.authorized, true); // Authorized because it matched realUid1 in allowlist and canary!

  // 3. Output does NOT leak real UID
  var fullLog = logLines.join('\n');
  assert.ok(!fullLog.includes(realUid1), 'Full client UID 1 must not appear in output');
  assert.ok(!fullLog.includes(realUid2), 'Full client UID 2 must not appear in output');
  assert.ok(fullLog.includes(realUid1.slice(0, 6) + '…'), 'Short prefix is shown in --detail');

  // 4. Safe cohorts stages are redacted
  assert.ok(result.cohorts.stages.stage1_firstEligibleClient[0].includes('…'));
  assert.equal(result.cohorts.capacityAnalysis.priorityACount, 1);
});

test('T686 — CAMBIO 3: Client app (vdsen-cliente.html) allowed list includes terminal eligibility statuses', () => {
  var fs = require('node:fs');
  var path = require('node:path');
  var clientHtml = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

  // Verify terminal eligibility statuses are present in the allowed array
  var requiredStatuses = [
    'DISARMED', 'OUT_OF_ALLOWLIST', 'OUT_OF_CANARY', 'PLAN_MISMATCH', 'SOURCE_INVALID',
    'NO_CHANGE', 'MATERIALIZED', 'INACTIVE_CLIENT', 'NO_VERIFIABLE_APP_USAGE',
    'AWAITING_FIRST_ACTIVITY', 'NEW_CLIENT_AWAITING_FIRST_ACTIVITY',
    'NEEDS_VERIFIED_ACTIVITY', 'NO_TEMPORAL_EVIDENCE', 'SAFETY_HOLD', 'NOT_ELIGIBLE',
    'READ_FAILED', 'STARTS_READ_FAILED'
  ];

  requiredStatuses.forEach(function(st) {
    assert.ok(clientHtml.includes("'" + st + "'"), 'vdsen-cliente.html must contain status ' + st);
  });
});

test('T686 — CAMBIO 2: Inactive client (> 28 days) or lacking start markers is excluded from PRIORITY_A', () => {
  var p = {
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'active',
    clientId: 'c_inactive',
    coachId: 'coach_alpha',
    weeks: 4,
    days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: 'pid1', repsRange: { min: 8, max: 12 } }] }]
  };

  // Case 1: Lacking starts markers
  var entriesNoStarts = {
    log_1_0_0_s0: { done: true, prescriptionExerciseId: 'pid1', ts: NOW_MS - 2 * DAY_MS }
  };
  var evNoStarts = eligibility.evaluateClientEligibility({
    clientId: 'c_inactive',
    client: { uid: 'c_inactive', activePlanId: 'p1', coachId: 'coach_alpha', status: 'active' },
    plan: p,
    entries: entriesNoStarts,
    starts: {}, // Empty starts
    now: NOW_ISO
  });
  assert.equal(evNoStarts.eligible, false);
  assert.equal(evNoStarts.reason, 'NEEDS_VERIFIED_ACTIVITY');
  assert.notEqual(evNoStarts.priority, 'PRIORITY_A');

  // Case 2: Inactive > 28 days
  var oldTs = NOW_MS - 35 * DAY_MS;
  var entriesOld = {
    log_1_0_0_s0: { done: true, prescriptionExerciseId: 'pid1', ts: oldTs, sts: oldTs }
  };
  var startsOld = {
    ['p1_1_0_0']: { planId: 'p1', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(oldTs).toISOString() }
  };
  var evOld = eligibility.evaluateClientEligibility({
    clientId: 'c_inactive',
    client: { uid: 'c_inactive', activePlanId: 'p1', coachId: 'coach_alpha', status: 'active' },
    plan: p,
    entries: entriesOld,
    starts: startsOld,
    now: NOW_ISO
  });
  assert.equal(evOld.eligible, false);
  assert.equal(evOld.reason, 'INACTIVE_CLIENT');
  assert.notEqual(evOld.priority, 'PRIORITY_A');
});

test('T686 — CAMBIO 1: Progression SETS blocked when plan is suspended before applyPending', async () => {
  var clientId = 'client-sets-1', planId = 'plan-sets-1', coachId = 'coach-1', pid = 'pid-press';
  var key = 'v1_0123456789abcdef';
  var record = {
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
      candidates: [{ dimension: 'SETS', previousValue: 3, rawCandidate: 4, finalCandidate: 4 }]
    },
    events: []
  };
  var planDoc = {
    clientId: clientId,
    coachId: coachId,
    status: 'suspended',
    weeks: 4,
    days: [{ dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }]
  };
  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: planId, coachId: coachId, status: 'active' },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: planDoc,
    ['releaseControl/autonomousProgression']: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      expiresAt: '2026-11-01T00:00:00.000Z',
      clientIds: [clientId]
    },
    ['logs/' + clientId + '/mesos/' + planId]: {
      planId: planId,
      progressionApplications: { [record.key]: record }
    }
  };
  var db = makeFakeDb(seed);
  executor.setSyntheticWindow({ uid: clientId, planId });
  var res = await executor.applyPending(db, clientId, planId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T686 — ISOLATION & IDEMPOTENCY: Replay of consumePending is idempotent and cannot touch another client', async () => {
  var clientId1 = 'client-iso-1', clientId2 = 'client-iso-2', planId = 'plan-iso-1', coachId = 'coach-1', pid = 'pid-press';
  var key = 'v1_0123456789abcdef';
  var rec = {
    key: key, revision: 2, clientId: clientId1, planId: planId, prescriptionExerciseId: pid,
    state: 'APPLIED', lifecycle: { overlayKey: 'ovl_' + key },
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-01T00:00:00.000Z' },
    nextExposure: { week: 1, dayIndex: 2 }
  };
  var ovl = {
    schema: 'vdsen-next-exposure-overlay-v1',
    key: 'ovl_' + key, sourceRecordKey: key, clientId: clientId1, planId: planId, prescriptionExerciseId: pid,
    dimension: 'REPS', status: 'APPLIED', appliedValue: 11, previousValue: 10, target: { week: 1, dayIndex: 2 }
  };
  var receipt = {
    recordKey: key, overlayKey: 'ovl_' + key, dimension: 'REPS', appliedValue: 11, provenance: 'CANONICAL_OVERLAY', ackAt: NOW_ISO
  };
  var planDoc = {
    clientId: clientId1, coachId: coachId, status: 'active', weeks: 4, updatedAt: '2026-10-01T00:00:00.000Z',
    days: [
      { dayIndex: 0, exercises: [{ prescriptionExerciseId: pid }] },
      { dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }
    ]
  };
  var seed = {
    ['clients/' + clientId1]: { uid: clientId1, activePlanId: planId, coachId: coachId, status: 'active' },
    ['clients/' + clientId2]: { uid: clientId2, activePlanId: 'plan-other', coachId: coachId, status: 'active' },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId1], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: planDoc,
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-11-01T00:00:00.000Z', clientIds: [clientId1] },
    ['logs/' + clientId1 + '/starts/' + planId + '_1_2_0']: { planId: planId, week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(NOW_MS - 1000).toISOString() },
    ['logs/' + clientId1 + '/mesos/' + planId]: {
      planId: planId, progressionApplications: { [key]: rec }, nextExposureOverlays: { ['ovl_' + key]: ovl }, consumptionReceipts: { [key]: receipt },
      entries: { 'log_1_2_0_s0': { done: true, prescriptionExerciseId: pid, carga: '100', reps: '11', unit: 'KG', sts: NOW_MS - 1000 } }
    },
    ['logs/' + clientId2 + '/mesos/plan-other']: {
      planId: 'plan-other', progressionApplications: {}, nextExposureOverlays: {}, consumptionReceipts: {}, entries: {}
    }
  };
  var db = makeFakeDb(seed);

  // Consume for client 1
  var res1 = await executor.consumePending(db, clientId1, planId, () => NOW_ISO);
  assert.equal(res1[0].written, true);

  // Idempotent retry for client 1
  var res2 = await executor.consumePending(db, clientId1, planId, () => NOW_ISO);
  assert.equal(res2.length, 0); // No APPLIED records left

  // Client 2's meso document must remain completely untouched
  var c2Meso = db._docs.get('logs/' + clientId2 + '/mesos/plan-other');
  assert.deepEqual(c2Meso.progressionApplications, {});
});

test('T686.1 — ITEM 1: plan.active === false treated as explicit deactivation, blocking applyPending and consumePending', async () => {
  var clientId = 'client-deact-1', planId = 'plan-deact-1', coachId = 'coach-1', pid = 'pid-press';
  var key = 'v1_0123456789abcdef';
  var planDoc = {
    clientId: clientId,
    coachId: coachId,
    active: false, // Explicitly false!
    status: 'active', // Even if status string is active, active === false takes precedence
    weeks: 4,
    days: [{ dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }]
  };

  assert.equal(eligibility.isPlanSuspendedOrRevoked(planDoc), true);

  var rec = {
    key: key, revision: 2, clientId: clientId, planId: planId, prescriptionExerciseId: pid,
    state: 'APPLIED', lifecycle: { overlayKey: 'ovl_' + key },
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-01T00:00:00.000Z' },
    nextExposure: { week: 1, dayIndex: 2 }
  };
  var ovl = {
    schema: 'vdsen-next-exposure-overlay-v1', key: 'ovl_' + key, sourceRecordKey: key,
    clientId: clientId, planId: planId, prescriptionExerciseId: pid, dimension: 'REPS',
    status: 'APPLIED', appliedValue: 11, previousValue: 10, target: { week: 1, dayIndex: 2 }
  };
  var receipt = {
    recordKey: key, overlayKey: 'ovl_' + key, dimension: 'REPS', appliedValue: 11,
    provenance: 'CANONICAL_OVERLAY', ackAt: NOW_ISO
  };
  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: planId, coachId: coachId, status: 'active' },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + planId]: planDoc,
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-11-01T00:00:00.000Z', clientIds: [clientId] },
    ['logs/' + clientId + '/starts/' + planId + '_1_2_0']: { planId: planId, week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(NOW_MS - 1000).toISOString() },
    ['logs/' + clientId + '/mesos/' + planId]: {
      planId: planId, progressionApplications: { [key]: rec }, nextExposureOverlays: { ['ovl_' + key]: ovl },
      consumptionReceipts: { [key]: receipt },
      entries: { 'log_1_2_0_s0': { done: true, prescriptionExerciseId: pid, carga: '100', reps: '11', unit: 'KG', sts: NOW_MS - 1000 } }
    }
  };
  var db = makeFakeDb(seed);
  var res = await executor.consumePending(db, clientId, planId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T686.1 — ITEM 2: Replaced plan consumption blocked when exposure only has done: true but lacks canonical startMarker', async () => {
  var clientId = 'client-nostart-1', oldPlanId = 'plan-old-ns', newPlanId = 'plan-new-ns', coachId = 'coach-1', pid = 'pid-press';
  var key = 'v1_0123456789abcdef';
  var rec = {
    key: key, revision: 2, clientId: clientId, planId: oldPlanId, prescriptionExerciseId: pid,
    state: 'APPLIED', lifecycle: { overlayKey: 'ovl_' + key },
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-01T00:00:00.000Z' },
    nextExposure: { week: 1, dayIndex: 2 }
  };
  var ovl = {
    schema: 'vdsen-next-exposure-overlay-v1', key: 'ovl_' + key, sourceRecordKey: key,
    clientId: clientId, planId: oldPlanId, prescriptionExerciseId: pid, dimension: 'REPS',
    status: 'APPLIED', appliedValue: 11, previousValue: 10, target: { week: 1, dayIndex: 2 }
  };
  var receipt = {
    recordKey: key, overlayKey: 'ovl_' + key, dimension: 'REPS', appliedValue: 11,
    provenance: 'CANONICAL_OVERLAY', ackAt: NOW_ISO
  };
  var oldPlanDoc = {
    clientId: clientId, coachId: coachId, status: 'active', weeks: 4, updatedAt: '2026-10-01T00:00:00.000Z',
    days: [
      { dayIndex: 0, exercises: [{ prescriptionExerciseId: pid }] },
      { dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }
    ]
  };
  var seed = {
    ['clients/' + clientId]: { uid: clientId, activePlanId: newPlanId, coachId: coachId, status: 'active' },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + oldPlanId]: oldPlanDoc,
    ['plans/' + newPlanId]: { clientId: clientId, coachId: coachId, status: 'active', weeks: 4, createdAt: '2026-10-10T00:00:00.000Z' },
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-11-01T00:00:00.000Z', clientIds: [clientId] },
    // Notice: NO startMarker in logs/{clientId}/starts/ !
    ['logs/' + clientId + '/mesos/' + oldPlanId]: {
      planId: oldPlanId, progressionApplications: { [key]: rec }, nextExposureOverlays: { ['ovl_' + key]: ovl },
      consumptionReceipts: { [key]: receipt },
      entries: {
        // done: true exists in device entries, but without canonical startMarker, it lacks chronological authority
        'log_1_2_0_s0': { done: true, prescriptionExerciseId: pid, carga: '100', reps: '11', unit: 'KG', sts: NOW_MS - 1000 }
      }
    }
  };
  var db = makeFakeDb(seed);
  var res = await executor.consumePending(db, clientId, oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T686.1 — ITEM 2: Replaced plan consumption blocked when canonical startMarker is POSTERIOR to plan replacement', async () => {
  var clientId = 'client-post-1', oldPlanId = 'plan-old-post', newPlanId = 'plan-new-post', coachId = 'coach-1', pid = 'pid-press';
  var key = 'v1_0123456789abcdef';
  var replacementTime = '2026-10-10T12:00:00.000Z';
  var exposureStartTime = '2026-10-12T12:00:00.000Z'; // Exposure started 2 days AFTER plan replacement!

  var rec = {
    key: key, revision: 2, clientId: clientId, planId: oldPlanId, prescriptionExerciseId: pid,
    state: 'APPLIED', lifecycle: { overlayKey: 'ovl_' + key },
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-01T00:00:00.000Z' },
    nextExposure: { week: 1, dayIndex: 2 }
  };
  var ovl = {
    schema: 'vdsen-next-exposure-overlay-v1', key: 'ovl_' + key, sourceRecordKey: key,
    clientId: clientId, planId: oldPlanId, prescriptionExerciseId: pid, dimension: 'REPS',
    status: 'APPLIED', appliedValue: 11, previousValue: 10, target: { week: 1, dayIndex: 2 }
  };
  var receipt = {
    recordKey: key, overlayKey: 'ovl_' + key, dimension: 'REPS', appliedValue: 11,
    provenance: 'CANONICAL_OVERLAY', ackAt: NOW_ISO
  };
  var oldPlanDoc = {
    clientId: clientId, coachId: coachId, status: 'active', weeks: 4, updatedAt: '2026-10-01T00:00:00.000Z',
    days: [
      { dayIndex: 0, exercises: [{ prescriptionExerciseId: pid }] },
      { dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }
    ]
  };
  var seed = {
    ['clients/' + clientId]: {
      uid: clientId, activePlanId: newPlanId, coachId: coachId, status: 'active',
      planChangedAt: replacementTime // Authoritative replacement timestamp
    },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + oldPlanId]: oldPlanDoc,
    ['plans/' + newPlanId]: { clientId: clientId, coachId: coachId, status: 'active', weeks: 4, createdAt: replacementTime },
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-11-01T00:00:00.000Z', clientIds: [clientId] },
    ['logs/' + clientId + '/starts/' + oldPlanId + '_1_2_0']: {
      planId: oldPlanId, week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0',
      at: exposureStartTime // Stamped AFTER replacement!
    },
    ['logs/' + clientId + '/mesos/' + oldPlanId]: {
      planId: oldPlanId, progressionApplications: { [key]: rec }, nextExposureOverlays: { ['ovl_' + key]: ovl },
      consumptionReceipts: { [key]: receipt },
      entries: { 'log_1_2_0_s0': { done: true, prescriptionExerciseId: pid, carga: '100', reps: '11', unit: 'KG', sts: Date.parse(exposureStartTime) } }
    }
  };
  var db = makeFakeDb(seed);
  var res = await executor.consumePending(db, clientId, oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, false);
  assert.equal(res[0].reason, 'PLAN_MISMATCH');
});

test('T686.1 — ITEM 2: Replaced plan consumption SUCCEEDS when canonical startMarker is PRIOR to plan replacement', async () => {
  var clientId = 'client-prior-1', oldPlanId = 'plan-old-prior', newPlanId = 'plan-new-prior', coachId = 'coach-1', pid = 'pid-press';
  var key = 'v1_0123456789abcdef';
  var exposureStartTime = '2026-10-08T12:00:00.000Z'; // Exposure started on October 8
  var replacementTime = '2026-10-10T12:00:00.000Z';   // Plan was replaced on October 10

  var rec = {
    key: key, revision: 2, clientId: clientId, planId: oldPlanId, prescriptionExerciseId: pid,
    state: 'APPLIED', lifecycle: { overlayKey: 'ovl_' + key },
    source: { week: 1, dayIndex: 0, calculatedAt: '2026-10-01T00:00:00.000Z' },
    nextExposure: { week: 1, dayIndex: 2 }
  };
  var ovl = {
    schema: 'vdsen-next-exposure-overlay-v1', key: 'ovl_' + key, sourceRecordKey: key,
    clientId: clientId, planId: oldPlanId, prescriptionExerciseId: pid, dimension: 'REPS',
    status: 'APPLIED', appliedValue: 11, previousValue: 10, target: { week: 1, dayIndex: 2 }
  };
  var receipt = {
    recordKey: key, overlayKey: 'ovl_' + key, dimension: 'REPS', appliedValue: 11,
    provenance: 'CANONICAL_OVERLAY', ackAt: NOW_ISO
  };
  var oldPlanDoc = {
    clientId: clientId, coachId: coachId, status: 'active', weeks: 4, updatedAt: '2026-10-01T00:00:00.000Z',
    days: [
      { dayIndex: 0, exercises: [{ prescriptionExerciseId: pid }] },
      { dayIndex: 2, exercises: [{ prescriptionExerciseId: pid }] }
    ]
  };
  var seed = {
    ['clients/' + clientId]: {
      uid: clientId, activePlanId: newPlanId, coachId: coachId, status: 'active',
      activePlanActivatedAt: replacementTime // Authoritative replacement timestamp
    },
    ['coaches/' + coachId]: { uid: coachId, autoApplyCanary: { enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    ['plans/' + oldPlanId]: oldPlanDoc,
    ['plans/' + newPlanId]: { clientId: clientId, coachId: coachId, status: 'active', weeks: 4, createdAt: replacementTime },
    ['releaseControl/autonomousProgression']: { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-11-01T00:00:00.000Z', clientIds: [clientId] },
    ['logs/' + clientId + '/starts/' + oldPlanId + '_1_2_0']: {
      planId: oldPlanId, week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0',
      at: exposureStartTime // Stamped BEFORE replacement!
    },
    ['logs/' + clientId + '/mesos/' + oldPlanId]: {
      planId: oldPlanId, progressionApplications: { [key]: rec }, nextExposureOverlays: { ['ovl_' + key]: ovl },
      consumptionReceipts: { [key]: receipt },
      entries: { 'log_1_2_0_s0': { done: true, prescriptionExerciseId: pid, carga: '100', reps: '11', unit: 'KG', sts: Date.parse(exposureStartTime) } }
    }
  };
  var db = makeFakeDb(seed);
  var res = await executor.consumePending(db, clientId, oldPlanId, () => NOW_ISO);
  assert.equal(res.length, 1);
  assert.equal(res[0].written, true);
  var updatedMeso = db._docs.get('logs/' + clientId + '/mesos/' + oldPlanId);
  assert.equal(updatedMeso.progressionApplications[key].state, 'CONSUMED');
});

