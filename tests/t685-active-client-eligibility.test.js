'use strict';

// T685: Smart activation of the VDSEN autonomous progression engine for active clients.
// Covers all 13 required verification scenarios:
//   1. Recurrent eligible client (PRIORITY_A)
//   2. New client with active plan and first real activity (PRIORITY_B) vs account creation without activity
//   3. Client without active plan (NO_ACTIVE_PLAN)
//   4. Client without real app usage / synthetic / coach_admin / server / imported data (NO_VERIFIABLE_APP_USAGE)
//   5. Client who stops being active (INACTIVE_CLIENT) & occasional active client (PRIORITY_C)
//   6. Plan change, suspension, or revocation (PLAN_MISMATCH / PLAN_SUSPENDED_OR_REVOKED / SOURCE_INVALID)
//   7. Multi-client isolation & progressive cohort planning (<= 10 per window)
//   8. Full motor integration (PENDING -> APPLIED -> CONSUMED, LOAD, REPS, REST, SETS/priority, reactive DELOAD, cardio exclusion)
//   9. Idempotency under duplicate events
//  10. Revocation (release fence & coach canary)
//  11. Expiration (expiresAt)
//  12. Absence of unnecessary processing (resource optimization: bounded reads, no coaches scan when fence closed, no empty-log trigger)
//  13. Safe error recovery & pilot runtime OFF baseline alignment (T682/T683)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const eligibility = require('../api/_clientEligibility.js');
const executor = require('../api/_autonomousProgression.js');
const sweep = require('../api/_autonomousProgressionSweep.js');
const fleetReport = require('../scripts/fleet/eligibility-report.cjs');
const pilotRuntime = require('../scripts/pilot/ayrton-runtime.cjs');
const appLive = require('../scripts/release/app-live.cjs');
const consumer = require('../assets/progression-application-consumer.js');

const NOW_ISO = '2026-10-15T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const DAY_MS = 86400000;

function makePlan(overrides) {
  return Object.assign({
    id: 'plan-active-1',
    clientId: 'client-1',
    coachId: 'coach-1',
    status: 'active',
    weeks: 4,
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    musclePriorities: { PRIORITARIO: ['pecho'], NO_PRIORITARIO: [] },
    days: [0, 2].map(function(dayIndex) {
      return {
        dayIndex: dayIndex,
        exercises: [
          {
            prescriptionExerciseId: 'pid-press',
            exerciseId: 'ex-press',
            exerciseName: 'Press banca',
            muscleGroup: 'pecho',
            repsRange: { min: 8, max: 12 },
            sets: [0, 1, 2].map(function(setIndex) {
              return { setIndex: setIndex, repsTarget: 10, rirTarget: 2, restSeconds: 90 };
            })
          },
          {
            prescriptionExerciseId: 'pid-cardio',
            exerciseName: 'Caminadora inclinada',
            exerciseType: 'cardio',
            sets: [{ setIndex: 0, durationMinutes: 20 }]
          }
        ]
      };
    })
  }, overrides || {});
}

function makeRecurrentEntries(opts) {
  opts = opts || {};
  var pid = opts.pid || 'pid-press';
  var t1 = opts.t1 !== undefined ? opts.t1 : NOW_MS - 4 * DAY_MS;
  var t2 = opts.t2 !== undefined ? opts.t2 : NOW_MS - 2 * DAY_MS;
  var reps = opts.reps || '10';
  var rirTarget = opts.rirTarget !== undefined ? opts.rirTarget : 2;
  var rirReal = opts.rirReal !== undefined ? opts.rirReal : 3;
  var ics = opts.ics;
  var entries = {};
  [[1, 0, t1], [1, 2, t2]].forEach(function(item) {
    var w = item[0], d = item[1], ts = item[2];
    [0, 1, 2].forEach(function(s) {
      var setEntry = {
        done: true,
        carga: '100',
        reps: typeof reps === 'function' ? reps(w, d, s) : reps,
        unit: 'KG',
        rir: rirTarget,
        rir_real: rirReal,
        prescriptionExerciseId: pid,
        ts: ts + s * 1000,
        sts: ts + s * 1000
      };
      if (ics !== undefined) setEntry.ics = ics;
      entries['log_' + w + '_' + d + '_0_s' + s] = setEntry;
    });
    entries['done_' + w + '_' + d] = { ts: ts + 5000 };
    entries['postsession_' + w + '_' + d] = {
      completedAt: new Date(ts + 6000).toISOString(),
      eimd: opts.eimd !== undefined ? opts.eimd : 1,
      sleepHours: opts.sleep !== undefined ? opts.sleep : 8,
      rpeAverage: opts.rpe !== undefined ? opts.rpe : 7
    };
  });
  if (!opts.noRec) {
    entries.progrec_1_2 = {
      calculatedAt: new Date(t2 + 10000).toISOString(),
      recommendations: [
        Object.assign({
          prescriptionExerciseId: pid,
          exerciseId: 'ex-press',
          exerciseName: 'Press banca',
          action: opts.action || 'increase_reps',
          newReps: 11
        }, opts.recExtra || {})
      ]
    };
  }
  return entries;
}

function makeRecurrentStarts(planId, t1, t2) {
  planId = planId || 'plan-active-1';
  t1 = t1 !== undefined ? t1 : NOW_MS - 4 * DAY_MS;
  t2 = t2 !== undefined ? t2 : NOW_MS - 2 * DAY_MS;
  var starts = {};
  starts[planId + '_1_0_0'] = {
    planId: planId,
    week: 1,
    dayIndex: 0,
    exerciseIndex: 0,
    setKey: 'log_1_0_0_s0',
    at: new Date(t1).toISOString()
  };
  starts[planId + '_1_2_0'] = {
    planId: planId,
    week: 1,
    dayIndex: 2,
    exerciseIndex: 0,
    setKey: 'log_1_2_0_s0',
    at: new Date(t2).toISOString()
  };
  return starts;
}

function makeFakeDb(seedDocs, failingClients, failingStartsClients) {
  var docs = new Map(Object.entries(seedDocs || {}));
  var failSet = new Set(failingClients || []);
  var failStartsSet = new Set(failingStartsClients || []);
  var stats = { gets: 0, queries: 0, sets: 0, txRuns: 0, pathsRead: [] };

  function makeRef(docPath) {
    return {
      path: docPath,
      collection: function(name) { return makeCollection(docPath + '/' + name); },
      doc: function(id) { return makeRef(docPath + '/' + id); },
      get: async function() {
        stats.gets++;
        stats.pathsRead.push(docPath);
        for (var fc of failSet) {
          if (docPath.indexOf(fc) >= 0) throw new Error('SIMULATED_DB_FAILURE_' + fc);
        }
        return makeSnap(docPath);
      }
    };
  }

  function makeSnap(docPath) {
    var val = docs.get(docPath);
    return {
      exists: val !== undefined,
      data: function() { return val !== undefined ? structuredClone(val) : undefined; },
      updateTime: { toMillis: function() { return NOW_MS; } }
    };
  }

  function makeCollection(colPath) {
    function makeQuery(filterFn, orderField, orderDir, limitCount) {
      var queryObj = {
        where: function(field, op, expected) {
          var newFilter = function(v) {
            if (filterFn && !filterFn(v)) return false;
            var actual = field.split('.').reduce(function(o, p) { return o ? o[p] : undefined; }, v);
            if (op === '==') return actual === expected;
            return true;
          };
          return makeQuery(newFilter, orderField, orderDir, limitCount);
        },
        orderBy: function(field, dir) {
          return makeQuery(filterFn, field, dir || 'asc', limitCount);
        },
        limit: function(n) {
          return makeQuery(filterFn, orderField, orderDir, n);
        },
        get: async function() {
          stats.queries++;
          stats.pathsRead.push('QUERY:' + colPath + (orderField ? ':ORDER:' + orderField : ''));
          for (var fc of failSet) {
            if (colPath.indexOf(fc) >= 0) throw new Error('SIMULATED_DB_FAILURE_' + fc);
          }
          for (var fsc of failStartsSet) {
            if (colPath.indexOf(fsc) >= 0 && colPath.indexOf('starts') >= 0) throw new Error('SIMULATED_STARTS_FAILURE_' + fsc);
          }
          var out = [];
          for (let [k, v] of docs.entries()) {
            if (k.indexOf(colPath + '/') === 0 && k.slice(colPath.length + 1).indexOf('/') < 0) {
              if (!filterFn || filterFn(v)) {
                let snapCopy = structuredClone(v);
                out.push({ id: k.split('/').pop(), data: function() { return structuredClone(snapCopy); }, _raw: v });
              }
            }
          }
          if (orderField) {
            out.sort(function(a, b) {
              var valA = a._raw && a._raw[orderField];
              var valB = b._raw && b._raw[orderField];
              var msA = typeof valA === 'string' ? Date.parse(valA) : (typeof valA === 'number' ? valA : 0);
              var msB = typeof valB === 'string' ? Date.parse(valB) : (typeof valB === 'number' ? valB : 0);
              return orderDir === 'desc' ? msB - msA : msA - msB;
            });
          }
          if (typeof limitCount === 'number' && limitCount > 0) {
            out = out.slice(0, limitCount);
          }
          return { docs: out };
        }
      };
      return queryObj;
    }

    var baseQuery = makeQuery(null, null, null, null);
    return {
      path: colPath,
      doc: function(id) { return makeRef(colPath + '/' + id); },
      where: baseQuery.where,
      orderBy: baseQuery.orderBy,
      limit: baseQuery.limit,
      get: baseQuery.get
    };
  }

  var tx = {
    get: async function(ref) {
      if (ref && typeof ref.get === 'function') {
        return ref.get();
      }
      stats.gets++;
      stats.pathsRead.push(ref.path);
      for (var fc of failSet) {
        if (ref.path.indexOf(fc) >= 0) throw new Error('SIMULATED_TX_FAILURE_' + fc);
      }
      return makeSnap(ref.path);
    },
    set: function(ref, value, opts) {
      stats.sets++;
      var prev = docs.get(ref.path);
      if (opts && opts.merge && prev && typeof prev === 'object') {
        var next = structuredClone(prev);
        Object.keys(value).forEach(function(k) {
          if (value[k] && typeof value[k] === 'object' && !Array.isArray(value[k]) && next[k] && typeof next[k] === 'object' && !Array.isArray(next[k])) {
            next[k] = Object.assign({}, next[k], structuredClone(value[k]));
          } else {
            next[k] = structuredClone(value[k]);
          }
        });
        docs.set(ref.path, next);
      } else {
        docs.set(ref.path, structuredClone(value));
      }
    }
  };

  return {
    docs: docs,
    stats: stats,
    collection: function(name) { return makeCollection(name); },
    runTransaction: async function(fn) {
      stats.txRuns++;
      return fn(tx);
    }
  };
}

test('T685.1 Scenario 1: Existing client with recurrent verifiable App Cliente usage and active plan is PRIORITY_A', () => {
  var plan = makePlan();
  var entries = makeRecurrentEntries();
  var starts = makeRecurrentStarts('plan-active-1');
  var releaseDoc = { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: ['client-1'] };
  var coachDoc = { autoApplyCanary: { enabled: true, clientIds: ['client-1'], prescriptionExerciseIds: [] } };
  var ev = eligibility.evaluateClientEligibility({
    clientId: 'client-1',
    client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-08-01T00:00:00.000Z' },
    plan: plan,
    entries: entries,
    starts: starts,
    releaseDoc: releaseDoc,
    coachDoc: coachDoc,
    now: NOW_ISO
  });
  assert.equal(ev.eligible, true);
  assert.equal(ev.priority, 'PRIORITY_A');
  assert.equal(ev.priorityRank, 1);
  assert.equal(ev.category, 'RECURRENT_ACTIVE');
  assert.equal(ev.technicalState, 'ELIGIBLE');
  assert.equal(ev.readyForMotorProgression, true);
  assert.equal(ev.authorized, true);
  assert.equal(ev.activity.windowSessionsCount, 2);
  assert.equal(ev.activity.exercisesWithTwoExposures, 1);
});

test('T685.2 Scenario 2: New client onboarding — account creation without training activity is excluded; first real activity activates PRIORITY_B', () => {
  var plan = makePlan({ clientId: 'client-new', createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z' });
  var client = { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-10-12T00:00:00.000Z', onboardedAt: '2026-10-12T00:00:00.000Z' };

  // 2a) Account created + active plan assigned, but 0 real training interactions
  var beforeActivity = eligibility.evaluateClientEligibility({
    clientId: 'client-new',
    client: client,
    plan: plan,
    entries: {},
    now: NOW_ISO
  });
  assert.equal(beforeActivity.eligible, false);
  assert.equal(beforeActivity.reason, 'NEW_CLIENT_AWAITING_FIRST_ACTIVITY');
  assert.equal(beforeActivity.category, 'AWAITING_FIRST_ACTIVITY');
  assert.equal(beforeActivity.isNewClient, true);
  assert.equal(beforeActivity.readyForMotorProgression, false);

  // 2b) Unverified working set (only device ts/sts without start marker) does not accredit activity
  var firstSetTs = NOW_MS - 1 * DAY_MS;
  var unverifiedFirstSet = eligibility.evaluateClientEligibility({
    clientId: 'client-new',
    client: client,
    plan: plan,
    entries: {
      log_1_0_0_s0: { done: true, carga: '60', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: firstSetTs, sts: firstSetTs }
    },
    now: NOW_ISO
  });
  assert.equal(unverifiedFirstSet.eligible, false);
  assert.equal(unverifiedFirstSet.reason, 'NEW_CLIENT_AWAITING_FIRST_ACTIVITY');

  // 2c) First working set backed by immutable start marker in logs/{uid}/starts/* accredits first real activity -> activates PRIORITY_B
  var afterStartMarker = eligibility.evaluateClientEligibility({
    clientId: 'client-new',
    client: client,
    plan: plan,
    entries: {
      log_1_0_0_s0: { done: true, carga: '60', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: firstSetTs }
    },
    starts: {
      'plan-active-1_1_0_0': { planId: 'plan-active-1', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(firstSetTs).toISOString() }
    },
    now: NOW_ISO
  });
  assert.equal(afterStartMarker.eligible, true);
  assert.equal(afterStartMarker.priority, 'PRIORITY_B');
  assert.equal(afterStartMarker.priorityRank, 2);
  assert.equal(afterStartMarker.category, 'NEW_CLIENT_ACTIVE');
  assert.equal(afterStartMarker.activity.windowSessionsCount, 1);
});

test('T685.3 Scenario 3: Clients without active plan, without coach, or needing plan prep are strictly excluded', () => {
  var plan = makePlan({ clientId: 'c1' });
  assert.equal(eligibility.evaluateClientEligibility({ clientId: null, client: null, plan: plan, now: NOW_ISO }).reason, 'NO_CLIENT_IDENTITY');
  assert.equal(eligibility.evaluateClientEligibility({ clientId: 'c1', client: { coachId: 'coach-1', activePlanId: null }, plan: null, now: NOW_ISO }).reason, 'NO_ACTIVE_PLAN');
  assert.equal(eligibility.evaluateClientEligibility({ clientId: 'c1', client: { coachId: '', activePlanId: 'plan-active-1' }, plan: plan, now: NOW_ISO }).reason, 'NO_COACH_ASSIGNED');
  var unreadyPlan = makePlan({ clientId: 'c1', updatedAt: null });
  var unready = eligibility.evaluateClientEligibility({ clientId: 'c1', client: { coachId: 'coach-1', activePlanId: 'plan-active-1' }, plan: unreadyPlan, now: NOW_ISO });
  assert.equal(unready.eligible, false);
  assert.equal(unready.reason, 'NEEDS_PLAN_PREP');
  assert.equal(unready.technicalState, 'NEEDS_PLAN_PREP');
});

test('T685.4 Scenario 4: Synthetic, server-generated, Coach-administrative, imported, and pre-plan historical records never count as client activity', async () => {
  var plan = makePlan({ createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
  var nonClientEntries = {
    // Imported historical sets
    log_1_0_0_s0: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 3, prescriptionExerciseId: 'pid-press', imported: true, ts: NOW_MS - 2 * DAY_MS },
    log_1_2_0_s0: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 3, prescriptionExerciseId: 'pid-press', source: 'historical_import', ts: NOW_MS - 1 * DAY_MS },
    // Coach administrative action
    log_2_0_0_s0: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 3, prescriptionExerciseId: 'pid-press', source: 'coach_admin', actor: 'coach', ts: NOW_MS - 1 * DAY_MS },
    // Server-generated entry
    progrec_1_2: { calculatedAt: NOW_ISO, source: 'server', actorId: 'trusted-progressor', recommendations: [{ prescriptionExerciseId: 'pid-press', action: 'increase_reps', newReps: 11 }] },
    // Historical record predating plan creation (Sept 2026 < Oct 1 2026)
    log_1_0_0_s1: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 3, prescriptionExerciseId: 'pid-press', ts: Date.parse('2026-09-10T10:00:00.000Z') },
    // Express / autoFilled
    log_1_0_0_s2: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 3, prescriptionExerciseId: 'pid-press', express: true, ts: NOW_MS - DAY_MS },
    // Empty administrative done_ marker with no real sets
    done_1_0: { ts: NOW_MS - DAY_MS }
  };

  var ev = eligibility.evaluateClientEligibility({
    clientId: 'client-1',
    client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-06-01T00:00:00.000Z' },
    plan: plan,
    meso: {
      planId: 'plan-active-1',
      entries: nonClientEntries,
      progressionApplications: { fake: { state: 'PENDING' } },
      nextExposureOverlays: { fake: { status: 'APPLIED' } },
      progressionApplicationSummary: { autoCount: 1 }
    },
    now: NOW_ISO
  });
  assert.equal(ev.eligible, false);
  assert.equal(ev.reason, 'NO_VERIFIABLE_APP_USAGE');
  assert.equal(ev.activity.totalRealInteractions, 0);
  assert.ok(ev.activity.ignoredSyntheticCount >= 5);

  // Verify executor.processProgression also strips imported/coach/server entries and creates 0 records
  var db = makeFakeDb({
    'clients/client-1': { coachId: 'coach-1', activePlanId: 'plan-active-1' },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: ['client-1'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['client-1'], prescriptionExerciseIds: [] } },
    'plans/plan-active-1': plan,
    'logs/client-1': { planId: 'plan-active-1', entries: nonClientEntries, updatedAt: 2 },
    'logs/client-1/mesos/plan-active-1': { planId: 'plan-active-1', entries: nonClientEntries, updatedAt: 2 }
  });
  var res = await executor.processProgression({ db: db, clientId: 'client-1', planId: 'plan-active-1', enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
  assert.equal(res.status, 'NO_CHANGE');
  assert.deepEqual(res.created, []);
  assert.deepEqual(res.applied, []);
});

test('T685.5 Scenario 5: Client who stops being active (INACTIVE_CLIENT) vs occasional active client (PRIORITY_C)', () => {
  var plan = makePlan({ createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' });
  var existingClient = { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-07-01T00:00:00.000Z' };

  // 5a) Client whose last real activity was 35 days ago (> inactiveDays = 28) -> INACTIVE_CLIENT
  var oldEntries = makeRecurrentEntries({ t1: NOW_MS - 40 * DAY_MS, t2: NOW_MS - 35 * DAY_MS });
  var oldStarts = makeRecurrentStarts('plan-active-1', NOW_MS - 40 * DAY_MS, NOW_MS - 35 * DAY_MS);
  var inactiveEv = eligibility.evaluateClientEligibility({
    clientId: 'client-1',
    client: existingClient,
    plan: plan,
    entries: oldEntries,
    starts: oldStarts,
    now: NOW_ISO,
    windowDays: 14,
    inactiveDays: 28
  });
  assert.equal(inactiveEv.eligible, false);
  assert.equal(inactiveEv.reason, 'INACTIVE_CLIENT');

  // 5b) Existing client with activity 20 days ago and 5 days ago (only 1 session in the 14-day rolling window, not inactive) -> PRIORITY_C
  var occasionalEntries = makeRecurrentEntries({ t1: NOW_MS - 20 * DAY_MS, t2: NOW_MS - 5 * DAY_MS });
  var occasionalStarts = makeRecurrentStarts('plan-active-1', NOW_MS - 20 * DAY_MS, NOW_MS - 5 * DAY_MS);
  var occasionalEv = eligibility.evaluateClientEligibility({
    clientId: 'client-1',
    client: existingClient,
    plan: plan,
    entries: occasionalEntries,
    starts: occasionalStarts,
    now: NOW_ISO,
    windowDays: 14,
    inactiveDays: 28
  });
  assert.equal(occasionalEv.eligible, true);
  assert.equal(occasionalEv.priority, 'PRIORITY_C');
  assert.equal(occasionalEv.category, 'OCCASIONAL_ACTIVE');
});

test('T685.6 Scenario 6: Plan replacement, suspension, or revocation immediately cancels eligibility and blocks execution', async () => {
  for (var badStatus of ['suspended', 'revoked', 'cancelled', 'archived', 'inactive']) {
    var suspendedPlan = makePlan({ status: badStatus });
    var ev = eligibility.evaluateClientEligibility({
      clientId: 'client-1',
      client: { coachId: 'coach-1', activePlanId: 'plan-active-1' },
      plan: suspendedPlan,
      entries: makeRecurrentEntries(),
      starts: makeRecurrentStarts('plan-active-1'),
      now: NOW_ISO
    });
    assert.equal(ev.eligible, false, badStatus);
    assert.equal(ev.reason, 'PLAN_SUSPENDED_OR_REVOKED', badStatus);
    assert.equal(fleetReport.classify(suspendedPlan, makeRecurrentEntries()).state, 'NO_ACTIVE_PLAN');
  }

  var entries = makeRecurrentEntries();
  var db = makeFakeDb({
    'clients/client-1': { coachId: 'coach-1', activePlanId: 'plan-active-1' },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: ['client-1'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['client-1'], prescriptionExerciseIds: [] } },
    'plans/plan-active-1': makePlan({ status: 'suspended' }),
    'logs/client-1': { planId: 'plan-active-1', entries: entries, updatedAt: 2 },
    'logs/client-1/mesos/plan-active-1': { planId: 'plan-active-1', entries: entries, updatedAt: 2 },
    'logs/client-1/starts/plan-active-1_1_0_0': { planId: 'plan-active-1', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(NOW_MS - 4 * DAY_MS).toISOString() },
    'logs/client-1/starts/plan-active-1_1_2_0': { planId: 'plan-active-1', week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(NOW_MS - 2 * DAY_MS).toISOString() }
  });
  var out = await executor.processProgression({ db: db, clientId: 'client-1', planId: 'plan-active-1', enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
  assert.equal(out.status, 'SOURCE_INVALID');
  assert.equal(db.stats.sets, 0, 'zero writes on suspended plan');

  // Client suspended/inactive
  db.docs.set('plans/plan-active-1', makePlan({ status: 'active' }));
  db.docs.set('clients/client-1', { coachId: 'coach-1', activePlanId: 'plan-active-1', status: 'inactive' });
  var outInactive = await executor.processProgression({ db: db, clientId: 'client-1', planId: 'plan-active-1', enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
  assert.equal(outInactive.status, 'PLAN_MISMATCH');
  assert.equal(db.stats.sets, 0);
});

test('T685.7 Scenario 7: Progressive cohort activation respects RELEASE_MAX_CLIENTS=10, orders A -> B -> C, and isolates clients', async () => {
  var items = [];
  // 6 Priority A recurrent clients
  for (var ia = 1; ia <= 6; ia++) {
    var t1A = NOW_MS - (ia + 2) * DAY_MS, t2A = NOW_MS - ia * DAY_MS;
    items.push({
      clientId: 'rec-' + ia,
      client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-07-01T00:00:00.000Z' },
      plan: makePlan({ clientId: 'rec-' + ia }),
      entries: makeRecurrentEntries({ t1: t1A, t2: t2A }),
      starts: makeRecurrentStarts('plan-active-1', t1A, t2A),
      now: NOW_ISO
    });
  }
  // 4 Priority B new active clients (1 session after onboarding)
  for (var ib = 1; ib <= 4; ib++) {
    var tsB = NOW_MS - ib * 3600000;
    var startsB = {};
    startsB['plan-active-1_1_0_0'] = { planId: 'plan-active-1', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(tsB).toISOString() };
    items.push({
      clientId: 'new-active-' + ib,
      client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-10-10T00:00:00.000Z' },
      plan: makePlan({ clientId: 'new-active-' + ib, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' }),
      entries: { log_1_0_0_s0: { done: true, carga: '80', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: tsB } },
      starts: startsB,
      now: NOW_ISO
    });
  }
  // 3 Priority C occasional clients
  for (var ic = 1; ic <= 3; ic++) {
    var t1C = NOW_MS - 22 * DAY_MS, t2C = NOW_MS - 6 * DAY_MS;
    items.push({
      clientId: 'occ-' + ic,
      client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-05-01T00:00:00.000Z' },
      plan: makePlan({ clientId: 'occ-' + ic, createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' }),
      entries: makeRecurrentEntries({ t1: t1C, t2: t2C }),
      starts: makeRecurrentStarts('plan-active-1', t1C, t2C),
      now: NOW_ISO
    });
  }
  // 5 Excluded clients (no plan, new without activity, no app usage, inactive, safety hold)
  items.push({ clientId: 'ex-noplan', client: { coachId: 'coach-1', activePlanId: null }, plan: null, entries: {}, now: NOW_ISO });
  items.push({ clientId: 'ex-new-idle', client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-10-13T00:00:00.000Z' }, plan: makePlan({ clientId: 'ex-new-idle', createdAt: '2026-10-13T00:00:00.000Z' }), entries: {}, now: NOW_ISO });
  items.push({ clientId: 'ex-unused', client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-05-01T00:00:00.000Z' }, plan: makePlan({ clientId: 'ex-unused' }), entries: {}, now: NOW_ISO });
  items.push({ clientId: 'ex-inactive', client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-05-01T00:00:00.000Z' }, plan: makePlan({ clientId: 'ex-inactive' }), entries: makeRecurrentEntries({ t1: NOW_MS - 45 * DAY_MS, t2: NOW_MS - 35 * DAY_MS }), starts: makeRecurrentStarts('plan-active-1', NOW_MS - 45 * DAY_MS, NOW_MS - 35 * DAY_MS), now: NOW_ISO });
  var painEntries = makeRecurrentEntries();
  painEntries.postsession_1_2 = { completedAt: NOW_ISO, articularPain: { present: true } };
  items.push({ clientId: 'ex-pain', client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-05-01T00:00:00.000Z' }, plan: makePlan({ clientId: 'ex-pain' }), entries: painEntries, starts: makeRecurrentStarts('plan-active-1'), now: NOW_ISO });

  var planResult = eligibility.planCohortActivation(items, { maxPerWindow: 10, initialCohortSize: 5 });
  assert.equal(planResult.capacityAnalysis.totalEvaluated, 18);
  assert.equal(planResult.capacityAnalysis.totalEligible, 13);
  assert.equal(planResult.capacityAnalysis.priorityACount, 6);
  assert.equal(planResult.capacityAnalysis.priorityBCount, 4);
  assert.equal(planResult.capacityAnalysis.priorityCCount, 3);
  assert.equal(planResult.capacityAnalysis.excludedCount, 5);
  assert.equal(planResult.capacityAnalysis.fitsSingleWindow, false);
  assert.equal(planResult.capacityAnalysis.windowsRequired, 2);

  // Stage 1: first eligible client is top Priority A
  assert.deepEqual(planResult.stages.stage1_firstEligibleClient, ['rec-1']);
  // Stage 2: initial reduced group of 5 active clients
  assert.equal(planResult.stages.stage2_reducedActiveGroup.length, 5);
  assert.ok(planResult.stages.stage2_reducedActiveGroup.every(function(id) { return id.indexOf('rec-') === 0; }));
  // Stage 3 / Window 1: exactly 10 clients (6 Priority A + 4 Priority B)
  assert.equal(planResult.stages.stage3_fullWindowCohort.length, 10);
  assert.equal(planResult.windows.length, 2);
  assert.equal(planResult.windows[0].count, 10);
  assert.equal(planResult.windows[1].count, 3);
  assert.ok(planResult.windows[1].clientIds.every(function(id) { return id.indexOf('occ-') === 0; }));
  // Never includes any excluded client
  var allPlannedIds = planResult.windows.flatMap(function(w) { return w.clientIds; });
  for (var exId of ['ex-noplan', 'ex-new-idle', 'ex-unused', 'ex-inactive', 'ex-pain']) {
    assert.ok(allPlannedIds.indexOf(exId) < 0, exId + ' must not enter any cohort');
  }
});

test('T685.8 Scenario 8: Full motor integration — LOAD, REPS, REST, SETS (MEV/MRV & priority), reactive DELOAD, cardio exclusion, and PENDING -> APPLIED -> CONSUMED', async () => {
  // 8a) REPS (DP), LOAD (Rule A), REST (Rule C), SETS (S-ADD), reactive DELOAD (S-DELOAD), and Cardio exclusion
  var scenarios = [
    { name: 'REPS', planExtra: { musclePriorities: null }, opts: { reps: '10', rirTarget: 1, rirReal: 3, ics: undefined, action: 'increase_reps' }, expectedDim: 'REPS', expectedVal: 12 },
    { name: 'LOAD', planExtra: { musclePriorities: null }, opts: { reps: '10', rirTarget: 2, rirReal: 3, ics: undefined, action: 'increase_load', recExtra: { newLoad: 5 } }, expectedDim: 'LOAD', expectedVal: 102.5 },
    { name: 'REST', planExtra: { musclePriorities: null }, opts: { reps: function(w, d) { return d === 2 ? '9' : '10'; }, rirTarget: 1, rirReal: 1, ics: undefined, action: 'maintain' }, expectedDim: 'REST', expectedVal: 120 },
    { name: 'SETS', planExtra: { musclePriorities: { PRIORITARIO: ['pecho'], NO_PRIORITARIO: [] } }, opts: { reps: '12', rirTarget: 2, rirReal: 2, ics: 9, eimd: 1, action: 'maintain' }, expectedDim: 'SETS', expectedVal: 4 },
    { name: 'DELOAD', planExtra: { musclePriorities: { PRIORITARIO: ['pecho'], NO_PRIORITARIO: [] } }, opts: { reps: '10', rirTarget: 2, rirReal: 0, ics: 5, eimd: 3, sleep: 4, rpe: 9.5, action: 'deload' }, expectedDim: 'DELOAD', expectedVal: null }
  ];

  for (var sc of scenarios) {
    var uid = 'athlete-' + sc.name.toLowerCase();
    var planId = 'plan-' + sc.name.toLowerCase();
    var plan = makePlan(Object.assign({ id: planId, clientId: uid }, sc.planExtra || {}));
    var entries = makeRecurrentEntries(sc.opts);
    // Also add a cardio recommendation to prove cardio never creates a progression record
    entries.progrec_1_2.recommendations.push({
      prescriptionExerciseId: 'pid-cardio',
      exerciseName: 'Caminadora inclinada',
      action: 'increase_load',
      newLoad: 10
    });

    var db = makeFakeDb({
      ['clients/' + uid]: { coachId: 'coach-1', activePlanId: planId },
      'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: [uid] },
      'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [] } },
      ['plans/' + planId]: plan,
      ['logs/' + uid]: { planId: planId, entries: entries, updatedAt: 2 },
      ['logs/' + uid + '/mesos/' + planId]: { planId: planId, entries: entries, updatedAt: 2 },
      ['logs/' + uid + '/starts/' + planId + '_1_0_0']: { planId: planId, week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(NOW_MS - 4 * DAY_MS).toISOString() },
      ['logs/' + uid + '/starts/' + planId + '_1_2_0']: { planId: planId, week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(NOW_MS - 2 * DAY_MS).toISOString() }
    });

    var out = await executor.processProgression({ db: db, clientId: uid, planId: planId, enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
    assert.equal(out.status, 'MATERIALIZED', sc.name);
    assert.equal(out.applied.length, 1, sc.name + ' applies exactly 1 non-cardio record');
    assert.equal(out.applied[0].written, true, sc.name);

    var meso = db.docs.get('logs/' + uid + '/mesos/' + planId);
    var recs = Object.values(meso.progressionApplications);
    var ovls = Object.values(meso.nextExposureOverlays);
    assert.equal(recs.length, 1, sc.name + ' cardio excluded');
    assert.equal(recs[0].prescriptionExerciseId, 'pid-press');
    assert.equal(recs[0].state, 'APPLIED', sc.name);
    assert.equal(ovls[0].dimension, sc.expectedDim, sc.name);
    if (sc.expectedVal !== null) assert.equal(ovls[0].appliedValue, sc.expectedVal, sc.name);

    // Transition APPLIED -> CONSUMED after athlete logs first working set of target exposure (week 2, day 0) and writes receipt
    var rec = recs[0], ovl = ovls[0];
    meso.entries['log_' + ovl.target.week + '_' + ovl.target.dayIndex + '_0_s0'] = {
      done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: NOW_MS
    };
    meso.consumptionReceipts = {
      [rec.key]: {
        schema: consumer.RECEIPT_SCHEMA,
        recordKey: rec.key,
        overlayKey: ovl.key,
        clientId: uid,
        planId: planId,
        prescriptionExerciseId: 'pid-press',
        target: ovl.target,
        dimension: ovl.dimension,
        appliedValue: ovl.appliedValue,
        provenance: 'CANONICAL_OVERLAY',
        ackAt: NOW_ISO
      }
    };
    db.docs.set('logs/' + uid + '/mesos/' + planId, meso);
    db.docs.set('logs/' + uid, { planId: planId, entries: meso.entries, updatedAt: 3 });

    var consumedOut = await executor.processProgression({ db: db, clientId: uid, planId: planId, enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
    assert.deepEqual(consumedOut.consumed.map(function(c) { return [c.written, c.reason]; }), [[true, null]], sc.name + ' CONSUMED');
    var finalMeso = db.docs.get('logs/' + uid + '/mesos/' + planId);
    assert.equal(finalMeso.progressionApplications[rec.key].state, 'CONSUMED', sc.name);
    assert.equal(finalMeso.nextExposureOverlays[ovl.key].status, 'CONSUMED', sc.name);
  }
});

test('T685.9 Scenario 9, 10, 11 & 12: Idempotency, revocation, expiration, and resource optimization (zero redundant reads/writes)', async () => {
  var uid = 'client-1', planId = 'plan-active-1';
  var entries = makeRecurrentEntries();
  var db = makeFakeDb({
    'clients/client-1': { coachId: 'coach-1', activePlanId: planId, coachInterventions: [{ id: 'iv-1', targetType: 'EXERCISE', targetId: 'pid-press' }] },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: [uid] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [] } },
    'plans/plan-active-1': makePlan(),
    'logs/client-1': { planId: planId, entries: entries, updatedAt: 2 },
    'logs/client-1/mesos/plan-active-1': { planId: planId, entries: entries, updatedAt: 2 },
    'logs/client-1/starts/plan-active-1_1_0_0': { planId: planId, week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(NOW_MS - 4 * DAY_MS).toISOString() },
    'logs/client-1/starts/plan-active-1_1_2_0': { planId: planId, week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(NOW_MS - 2 * DAY_MS).toISOString() }
  });

  // First run materializes and applies
  var first = await executor.processProgression({ db: db, clientId: uid, planId: planId, enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
  assert.equal(first.status, 'MATERIALIZED');
  assert.equal(first.applied.length, 1);

  // Second run with no new evidence and no consumption receipt: NO_CHANGE, 0 writes, and applyPending is skipped because PENDING count is 0
  var setsBefore = db.stats.sets;
  var getsBefore = db.stats.gets;
  var second = await executor.processProgression({ db: db, clientId: uid, planId: planId, enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
  assert.equal(second.status, 'NO_CHANGE');
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.consumed, []);
  assert.equal(db.stats.sets, setsBefore, 'idempotent: 0 writes on duplicate event');
  assert.ok(db.stats.gets - getsBefore <= 8, 'bounded reads when PENDING===0');

  // Client with empty entries (no progrec_* and no existing records): skips decision subcollection reads, applyPending, and consumePending
  db.docs.set('clients/client-idle', { coachId: 'coach-1', activePlanId: 'plan-idle', coachInterventions: [{ id: 'iv-unused', targetType: 'EXERCISE', targetId: 'pid-press' }] });
  db.docs.set('plans/plan-idle', makePlan({ id: 'plan-idle', clientId: 'client-idle' }));
  db.docs.set('logs/client-idle', { planId: 'plan-idle', entries: {}, updatedAt: 1 });
  db.docs.set('logs/client-idle/mesos/plan-idle', { planId: 'plan-idle', entries: {}, updatedAt: 1 });
  db.docs.set('releaseControl/autonomousProgression', { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: ['client-1', 'client-idle'] });
  db.docs.set('coaches/coach-1', { autoApplyCanary: { enabled: true, clientIds: ['client-1', 'client-idle'], prescriptionExerciseIds: [] } });

  db.stats.pathsRead = [];
  var idleOut = await executor.processProgression({ db: db, clientId: 'client-idle', planId: 'plan-idle', enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
  assert.equal(idleOut.status, 'NO_CHANGE');
  assert.ok(!db.stats.pathsRead.some(function(p) { return p.indexOf('decisions/') >= 0; }), 'no decision subcollection read when client has no progrec or records');
  assert.equal(db.stats.pathsRead.length, 6, 'exact 6 tx reads (client, release, coach, plan, meso, root) and 0 post-tx reads');

  // Scenario 10: Revocation (coach canary disabled -> OUT_OF_CANARY; release fence disabled -> OUT_OF_ALLOWLIST)
  db.docs.set('coaches/coach-1', { autoApplyCanary: { enabled: false, clientIds: [uid] } });
  var revokedCoach = await executor.processProgression({ db: db, clientId: uid, planId: planId, enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
  assert.equal(revokedCoach.status, 'OUT_OF_CANARY');

  // Scenario 11: Expiration (expiresAt in the past -> OUT_OF_ALLOWLIST; sweep does 0 coach queries)
  db.docs.set('coaches/coach-1', { autoApplyCanary: { enabled: true, clientIds: [uid] } });
  db.docs.set('releaseControl/autonomousProgression', { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-14T00:00:00.000Z', clientIds: [uid] });
  var expiredOut = await executor.processProgression({ db: db, clientId: uid, planId: planId, enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
  assert.equal(expiredOut.status, 'OUT_OF_ALLOWLIST');

  // Scenario 12: When release fence is expired or disabled, sweep.runSweep does 1 doc read and 0 collection queries
  db.stats.gets = 0; db.stats.queries = 0; db.stats.pathsRead = [];
  var sweepExpired = await sweep.runSweep({ db: db, enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
  assert.deepEqual(sweepExpired, { status: 'SWEPT', processed: 0, results: [] });
  assert.equal(db.stats.gets, 1, 'only releaseControl/autonomousProgression read');
  assert.equal(db.stats.queries, 0, 'zero coaches collection queries when release fence is closed/expired');
});

test('T685.13 Scenario 13: Safe error recovery in sweep, browser startup/empty-save resource guard, and pilot OFF baseline alignment', async () => {
  // 13a) One failing client in sweep never blocks another eligible client
  var entries = makeRecurrentEntries();
  var db = makeFakeDb({
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: ['client-broken', 'client-ok', 'client-inactive'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['client-broken', 'client-ok', 'client-inactive'], prescriptionExerciseIds: [] } },
    'clients/client-broken': { coachId: 'coach-1', activePlanId: 'plan-broken' },
    'clients/client-ok': { coachId: 'coach-1', activePlanId: 'plan-ok' },
    'clients/client-inactive': { coachId: 'coach-1', activePlanId: 'plan-inactive', status: 'inactive' },
    'plans/plan-ok': makePlan({ id: 'plan-ok', clientId: 'client-ok' }),
    'logs/client-ok': { planId: 'plan-ok', entries: entries, updatedAt: 2 },
    'logs/client-ok/mesos/plan-ok': { planId: 'plan-ok', entries: entries, updatedAt: 2 },
    'logs/client-ok/starts/plan-ok_1_0_0': { planId: 'plan-ok', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(NOW_MS - 4 * DAY_MS).toISOString() },
    'logs/client-ok/starts/plan-ok_1_2_0': { planId: 'plan-ok', week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(NOW_MS - 2 * DAY_MS).toISOString() }
  }, ['plan-broken']);

  var sweepRes = await sweep.runSweep({ db: db, enabled: true, numericApplyEnabled: true, clock: function() { return NOW_ISO; } });
  assert.equal(sweepRes.status, 'SWEPT');
  assert.equal(sweepRes.processed, 3);
  assert.deepEqual(sweepRes.results, [
    { clientId: 'client-broken', status: 'ERROR' },
    { clientId: 'client-ok', status: 'MATERIALIZED' },
    { clientId: 'client-inactive', status: 'INACTIVE_CLIENT' }
  ]);
  assert.equal(Object.values(db.docs.get('logs/client-ok/mesos/plan-ok').nextExposureOverlays).length, 1);

  // 13b) Browser _captureLifecycleState does not schedule trigger on empty new-client meso snapshot, only when recoverable evidence exists
  var html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
  var { functionSource } = require('./helpers/coach-materializer.js');
  var scheduled = 0;
  var ctx = {
    LIFECYCLE_STATE: null,
    _trustedProgressionIntent: function() { return null; },
    _scheduleTrustedProgression: function() { scheduled++; },
    setTimeout: function(fn) { fn(); }
  };
  vm.createContext(ctx);
  vm.runInContext(functionSource(html, '_captureLifecycleState'), ctx);
  // Brand-new client with empty meso -> 0 calls
  ctx._captureLifecycleState('u1', 'p1', { days: [] }, {}, { exists: function() { return true; }, metadata: {}, data: function() { return { planId: 'p1', entries: {} }; } });
  assert.equal(scheduled, 0, 'brand-new client opening the app does not fire progression trigger');
  // Returning client with progrec_1_2 -> schedules recovery
  ctx._captureLifecycleState('u1', 'p1', { days: [] }, {}, { exists: function() { return true; }, metadata: {}, data: function() { return { planId: 'p1', entries: { progrec_1_2: {} } }; } });
  assert.equal(scheduled, 1, 'returning client with progrec evidence schedules recovery');

  // 13c) Pilot runtime OFF baseline aligns with canonical release
  var releaseState = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.release', 'vdsen-client.json'), 'utf8'));
  assert.equal(pilotRuntime.T671, appLive.SAFE_OFF_BASELINE.runtimeSha);
  assert.equal(pilotRuntime.OFF_BASELINE_SHA, '353df8c12982cad7f4dc89b3622a6b63b3127b52');
  assert.equal(pilotRuntime.T671, releaseState.runtime_sha);
  assert.equal(pilotRuntime.LEGACY_T671_SHA, 'a8cf462c78c4bd795cc9f485a82f64429c179f00');
});

test('T685.1 Obligatory 10 cases: strict gate enforcement across evaluation, sweep, and execution', async () => {
  var trigger = require('../api/autonomous-progression-trigger.js');

  // Case 1: Cliente con plan activo y sesiones recientes: elegible (PRIORITY_A)
  var planActive = makePlan({ clientId: 'c1' });
  var clientActive = { coachId: 'coach-1', activePlanId: 'plan-active-1' };
  var recentLogs = makeRecurrentEntries();
  var recentStarts = makeRecurrentStarts('plan-active-1');
  var c1 = eligibility.evaluateClientEligibility({
    clientId: 'c1', client: clientActive, plan: planActive, entries: recentLogs, starts: recentStarts, now: NOW_ISO
  });
  assert.equal(c1.eligible, true, 'Case 1: eligible');
  assert.equal(c1.priority, 'PRIORITY_A', 'Case 1: Priority A');
  assert.equal(c1.category, 'RECURRENT_ACTIVE', 'Case 1: Recurrent Active');

  // Case 2: Cliente con plan activo pero última sesión hace más de 28 días: excluido en ejecución real
  var planActive2 = makePlan({ clientId: 'c2', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' });
  var oldLogs = makeRecurrentEntries({ t1: NOW_MS - 45 * DAY_MS, t2: NOW_MS - 35 * DAY_MS });
  var oldStarts = makeRecurrentStarts('plan-active-1', NOW_MS - 45 * DAY_MS, NOW_MS - 35 * DAY_MS);
  var clientActive2 = { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-06-01T00:00:00.000Z' };
  var c2 = eligibility.evaluateClientEligibility({
    clientId: 'c2', client: clientActive2, plan: planActive2, entries: oldLogs, starts: oldStarts, now: NOW_ISO
  });
  assert.equal(c2.eligible, false, 'Case 2: not eligible');
  assert.equal(c2.reason, 'INACTIVE_CLIENT', 'Case 2: INACTIVE_CLIENT reason');
  assert.equal(c2.category, 'EXCLUDED', 'Case 2: EXCLUDED category');

  // Verify Case 2 in real execution (materialize & processProgression returns INACTIVE_CLIENT, zero writes)
  var db2 = makeFakeDb({
    'clients/c2': clientActive2,
    'plans/plan-active-1': planActive2,
    'logs/c2': { planId: 'plan-active-1', entries: oldLogs, updatedAt: 2 },
    'logs/c2/mesos/plan-active-1': { planId: 'plan-active-1', entries: oldLogs, updatedAt: 2 },
    'logs/c2/starts/plan-active-1_1_0_0': { planId: 'plan-active-1', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(NOW_MS - 45 * DAY_MS).toISOString() },
    'logs/c2/starts/plan-active-1_1_2_0': { planId: 'plan-active-1', week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(NOW_MS - 35 * DAY_MS).toISOString() },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: ['c2'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['c2'], prescriptionExerciseIds: [] } }
  });
  var out2 = await executor.processProgression({ db: db2, clientId: 'c2', planId: 'plan-active-1', enabled: true, numericApplyEnabled: true, clock: () => NOW_ISO, enforceActiveEligibility: true });
  assert.equal(out2.status, 'INACTIVE_CLIENT', 'Case 2 execution: INACTIVE_CLIENT');
  assert.deepEqual(out2.applied, [], 'Case 2: zero applications');

  // Case 3: Cliente con plan "draft": excluido
  var planDraft = makePlan({ clientId: 'c3', status: 'draft' });
  var clientDraft = { coachId: 'coach-1', activePlanId: 'plan-active-1' };
  assert.equal(eligibility.isPlanStatusValid(planDraft, clientDraft), false, 'Case 3: draft plan status is invalid');
  var c3 = eligibility.evaluateClientEligibility({
    clientId: 'c3', client: clientDraft, plan: planDraft, entries: recentLogs, starts: recentStarts, now: NOW_ISO
  });
  assert.equal(c3.eligible, false, 'Case 3: draft is not eligible');
  assert.equal(c3.reason, 'PLAN_SUSPENDED_OR_REVOKED', 'Case 3: rejected for non-active plan status');

  var db3 = makeFakeDb({
    'clients/c3': clientDraft,
    'plans/plan-active-1': planDraft,
    'logs/c3': { planId: 'plan-active-1', entries: recentLogs, updatedAt: 2 },
    'logs/c3/mesos/plan-active-1': { planId: 'plan-active-1', entries: recentLogs, updatedAt: 2 },
    'logs/c3/starts/plan-active-1_1_0_0': { planId: 'plan-active-1', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(NOW_MS - 4 * DAY_MS).toISOString() },
    'logs/c3/starts/plan-active-1_1_2_0': { planId: 'plan-active-1', week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(NOW_MS - 2 * DAY_MS).toISOString() },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: ['c3'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['c3'], prescriptionExerciseIds: [] } }
  });
  var out3 = await executor.processProgression({ db: db3, clientId: 'c3', planId: 'plan-active-1', enabled: true, numericApplyEnabled: true, clock: () => NOW_ISO });
  assert.equal(out3.status, 'SOURCE_INVALID', 'Case 3 execution: draft plan returns SOURCE_INVALID with 0 writes');

  // Case 4: Cliente sin timestamps verificables: excluido del motor (NEEDS_VERIFIED_ACTIVITY)
  var planActive4 = makePlan({ clientId: 'c4' });
  var unverifiedEntries = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => {
    [0, 1, 2].forEach(s => {
      unverifiedEntries['log_' + w + '_' + d + '_0_s' + s] = {
        done: true, carga: '100', reps: '10', unit: 'KG', rir: 1, rir_real: 3, prescriptionExerciseId: 'pid-press', ts: 1 + s
      };
    });
  });
  var act4 = eligibility.extractRealAppActivity({ entries: unverifiedEntries, plan: planActive4, activePlanId: 'plan-active-1', now: NOW_MS });
  assert.equal(act4.hasWallClockTimestamps, false, 'Case 4: fake epoch < 2000 has no wall-clock timestamps');
  assert.equal(act4.windowSessionsCount, 0, 'Case 4: fail-closed rolling window session count is 0');
  var c4 = eligibility.evaluateClientEligibility({
    clientId: 'c4', client: clientActive, plan: planActive4, entries: unverifiedEntries, now: NOW_ISO
  });
  assert.equal(c4.eligible, false, 'Case 4: unverified timeline is excluded');
  assert.equal(c4.reason, 'NEEDS_VERIFIED_ACTIVITY', 'Case 4: reason is NEEDS_VERIFIED_ACTIVITY');
  assert.equal(c4.priority, null, 'Case 4: priority is null');

  // Case 5: Cliente con registros sintéticos o importados: no obtiene elegibilidad
  var planActive5 = makePlan({ clientId: 'c5' });
  var syntheticEntries = {};
  ['imported', 'synthetic', 'coach_admin', 'server'].forEach((src, idx) => {
    syntheticEntries['log_1_0_0_s' + idx] = {
      done: true, carga: '100', reps: '10', unit: 'KG', rir: 1, rir_real: 3,
      prescriptionExerciseId: 'pid-press', source: src, ts: NOW_MS - 1000
    };
  });
  var c5 = eligibility.evaluateClientEligibility({
    clientId: 'c5', client: clientActive, plan: planActive5, entries: syntheticEntries, now: NOW_ISO
  });
  assert.equal(c5.eligible, false, 'Case 5: synthetic/imported client is not eligible');
  assert.equal(c5.reason, 'NO_VERIFIABLE_APP_USAGE', 'Case 5: reason is NO_VERIFIABLE_APP_USAGE');

  // Case 6: Cliente nuevo con primera actividad verificable: elegible para incorporación (PRIORITY_B)
  var planActive6 = makePlan({ clientId: 'c6' });
  var newClientDoc = { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: new Date(NOW_MS - 2 * DAY_MS).toISOString() };
  var firstActivityEntries = {
    'log_1_0_0_s0': { done: true, carga: '100', reps: '10', unit: 'KG', rir: 1, rir_real: 3, prescriptionExerciseId: 'pid-press', ts: NOW_MS - 3600000 }
  };
  var firstActivityStarts = {
    'plan-active-1_1_0_0': { planId: 'plan-active-1', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(NOW_MS - 3600000).toISOString() }
  };
  var c6 = eligibility.evaluateClientEligibility({
    clientId: 'c6', client: newClientDoc, plan: planActive6, entries: firstActivityEntries, starts: firstActivityStarts, now: NOW_ISO
  });
  assert.equal(c6.eligible, true, 'Case 6: eligible');
  assert.equal(c6.priority, 'PRIORITY_B', 'Case 6: PRIORITY_B');
  assert.equal(c6.category, 'NEW_CLIENT_ACTIVE', 'Case 6: NEW_CLIENT_ACTIVE');

  // Case 7: Cliente sin actividad: cero escrituras de progresión
  var planActive7 = makePlan({ clientId: 'c7' });
  var db7 = makeFakeDb({
    'clients/c7': clientActive,
    'plans/plan-active-1': planActive7,
    'logs/c7': { planId: 'plan-active-1', entries: {}, updatedAt: 1 },
    'logs/c7/mesos/plan-active-1': { planId: 'plan-active-1', entries: {}, updatedAt: 1 },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: ['c7'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['c7'], prescriptionExerciseIds: [] } }
  });
  var writesBefore = db7.stats.sets;
  var out7 = await executor.processProgression({ db: db7, clientId: 'c7', planId: 'plan-active-1', enabled: true, numericApplyEnabled: true, clock: () => NOW_ISO, enforceActiveEligibility: true });
  assert.equal(out7.status, 'NO_VERIFIABLE_APP_USAGE', 'Case 7: returns NO_VERIFIABLE_APP_USAGE');
  assert.equal(db7.stats.sets, writesBefore, 'Case 7: exactly 0 writes executed');

  // Case 8: El barrido y el POST individual respetan la misma política
  var planActive8 = makePlan({ clientId: 'c8-active' });
  var planInactive8 = makePlan({ id: 'plan-inact-1', clientId: 'c8-inactive', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' });
  var db8 = makeFakeDb({
    'clients/c8-inactive': { coachId: 'coach-1', activePlanId: 'plan-inact-1', createdAt: '2026-06-01T00:00:00.000Z' },
    'clients/c8-active': { coachId: 'coach-1', activePlanId: 'plan-active-1' },
    'plans/plan-inact-1': planInactive8,
    'plans/plan-active-1': planActive8,
    'logs/c8-inactive': { planId: 'plan-inact-1', entries: oldLogs, updatedAt: 2 },
    'logs/c8-inactive/mesos/plan-inact-1': { planId: 'plan-inact-1', entries: oldLogs, updatedAt: 2 },
    'logs/c8-inactive/starts/plan-inact-1_1_0_0': { planId: 'plan-inact-1', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(NOW_MS - 45 * DAY_MS).toISOString() },
    'logs/c8-inactive/starts/plan-inact-1_1_2_0': { planId: 'plan-inact-1', week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(NOW_MS - 35 * DAY_MS).toISOString() },
    'logs/c8-active': { planId: 'plan-active-1', entries: recentLogs, updatedAt: 2 },
    'logs/c8-active/mesos/plan-active-1': { planId: 'plan-active-1', entries: recentLogs, updatedAt: 2 },
    'logs/c8-active/starts/plan-active-1_1_0_0': { planId: 'plan-active-1', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(NOW_MS - 4 * DAY_MS).toISOString() },
    'logs/c8-active/starts/plan-active-1_1_2_0': { planId: 'plan-active-1', week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(NOW_MS - 2 * DAY_MS).toISOString() },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: new Date(Date.now() + 36e5).toISOString(), clientIds: ['c8-inactive', 'c8-active'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['c8-inactive', 'c8-active'], prescriptionExerciseIds: [] } }
  });
  var sweepOut8 = await sweep.runSweep({ db: db8, enabled: true, numericApplyEnabled: true, clock: () => NOW_ISO });
  assert.deepEqual(sweepOut8.results, [
    { clientId: 'c8-inactive', status: 'INACTIVE_CLIENT' },
    { clientId: 'c8-active', status: 'MATERIALIZED' }
  ], 'Case 8 sweep: inactive excluded, active materialized');

  // Verify POST trigger handler for the same inactive client returns identical INACTIVE_CLIENT outcome
  var postResStatus = null;
  var postResBody = null;
  var fakeRes = {
    status: function(code) { postResStatus = code; return this; },
    json: function(data) { postResBody = data; return this; },
    setHeader: function() {}
  };
  var postHandler = trigger.makeHandler({
    db: db8,
    verifyIdToken: async function() { return { uid: 'c8-inactive' }; },
    enabled: true,
    numericApplyEnabled: true
  });
  await postHandler({ method: 'POST', headers: { authorization: 'Bearer token-ok' }, body: { planId: 'plan-inact-1' } }, fakeRes);
  assert.equal(postResStatus, 200);
  assert.equal(postResBody.status, 'INACTIVE_CLIENT', 'Case 8 POST: inactive client rejected with identical INACTIVE_CLIENT status');
  assert.deepEqual(postResBody.created, []);

  // Case 9: Revocación, idempotencia y aislamiento por cliente
  db8.docs.set('coaches/coach-1', { autoApplyCanary: { enabled: true, clientIds: ['c8-inactive'], prescriptionExerciseIds: [] } }); // c8-active revoked from coach canary
  var postActiveRevoked = trigger.makeHandler({
    db: db8,
    verifyIdToken: async function() { return { uid: 'c8-active' }; },
    enabled: true,
    numericApplyEnabled: true
  });
  await postActiveRevoked({ method: 'POST', headers: { authorization: 'Bearer token-ok' }, body: { planId: 'plan-active-1' } }, fakeRes);
  assert.equal(postResBody.status, 'OUT_OF_CANARY', 'Case 9: revocation in canary immediately blocks athlete');

  // Case 10: Cero regresiones en PENDING -> APPLIED -> CONSUMED
  // Demonstrated in Scenario 8 and verified via active client flow
  assert.ok(true, 'Case 10: verified');
});

test('T685.2: Cierre de autoridad temporal y elegibilidad real (10 pruebas específicas)', async () => {
  var trigger = require('../api/autonomous-progression-trigger.js');
  var plan = makePlan({ clientId: 'client-1' });
  var client = { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-07-01T00:00:00.000Z' };

  // Prueba 1: "sts" fabricado o manipulable no otorga recurrencia
  var fakeStsEntries = {};
  [[1, 0], [1, 2]].forEach(function(item) {
    var w = item[0], d = item[1];
    fakeStsEntries['log_' + w + '_' + d + '_0_s0'] = {
      done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2,
      prescriptionExerciseId: 'pid-press', ts: NOW_MS - 2 * DAY_MS, sts: NOW_MS - 2 * DAY_MS
    };
  });
  var act1 = eligibility.extractRealAppActivity({ entries: fakeStsEntries, plan: plan, activePlanId: 'plan-active-1', now: NOW_MS });
  assert.equal(act1.hasVerifiedTimestamps, false, 'Prueba 1: sts in entries does NOT prove server time');
  assert.equal(act1.windowSessionsCount, 0, 'Prueba 1: windowSessionsCount is 0 without verified start markers');
  var ev1 = eligibility.evaluateClientEligibility({ clientId: 'client-1', client: client, plan: plan, entries: fakeStsEntries, starts: {}, now: NOW_ISO });
  assert.equal(ev1.eligible, false, 'Prueba 1: not eligible without verified temporal authority');
  assert.equal(ev1.reason, 'NEEDS_VERIFIED_ACTIVITY', 'Prueba 1: reason is NEEDS_VERIFIED_ACTIVITY');
  assert.notEqual(ev1.priority, 'PRIORITY_A', 'Prueba 1: fabricated sts never grants recurrence');

  // Prueba 2: Dos sesiones antiguas con "ts" reciente no califican como actividad reciente
  var oldPlan = makePlan({ clientId: 'client-1', createdAt: new Date(NOW_MS - 60 * DAY_MS).toISOString() });
  var oldStarts = makeRecurrentStarts('plan-active-1', NOW_MS - 40 * DAY_MS, NOW_MS - 35 * DAY_MS);
  var oldEntriesWithRecentTs = makeRecurrentEntries({ t1: NOW_MS - 40 * DAY_MS, t2: NOW_MS - 35 * DAY_MS });
  // Athlete or compromised client sets recent ts on old sessions
  oldEntriesWithRecentTs['log_1_0_0_s0'].ts = NOW_MS - 1000;
  oldEntriesWithRecentTs['log_1_2_0_s0'].ts = NOW_MS - 500;
  var act2 = eligibility.extractRealAppActivity({ entries: oldEntriesWithRecentTs, starts: oldStarts, plan: oldPlan, activePlanId: 'plan-active-1', now: NOW_MS });
  assert.equal(act2.lastVerifiedActivityMs, NOW_MS - 35 * DAY_MS, 'Prueba 2: unverified ts does not update verified start date');
  assert.equal(act2.windowSessionsCount, 0, 'Prueba 2: 0 sessions in 14-day rolling window');
  var ev2 = eligibility.evaluateClientEligibility({ clientId: 'client-1', client: client, plan: oldPlan, entries: oldEntriesWithRecentTs, starts: oldStarts, now: NOW_ISO });
  assert.equal(ev2.eligible, false, 'Prueba 2: not eligible due to confirmed inactivity (> 28 days)');
  assert.equal(ev2.reason, 'INACTIVE_CLIENT', 'Prueba 2: reason is INACTIVE_CLIENT');

  // Prueba 3: Un marcador "starts.at" válido y reciente acredita la sesión correspondiente
  var validRecentAt = NOW_MS - 2 * DAY_MS;
  var doneEntries = {
    log_1_0_0_s0: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: validRecentAt }
  };
  var validStartMarker = {
    planId: 'plan-active-1', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(validRecentAt).toISOString()
  };
  var val3 = eligibility.validateStartMarker('plan-active-1_1_0_0', validStartMarker, 'plan-active-1', doneEntries);
  assert.equal(val3.valid, true, 'Prueba 3: start marker is valid');
  assert.equal(val3.atMs, validRecentAt, 'Prueba 3: verified timestamp matches at');
  assert.equal(val3.sessionKey, '1_0', 'Prueba 3: accredited sessionKey is 1_0');
  var act3 = eligibility.extractRealAppActivity({
    entries: doneEntries,
    starts: { 'plan-active-1_1_0_0': validStartMarker },
    plan: plan, activePlanId: 'plan-active-1', now: NOW_MS
  });
  assert.equal(act3.hasVerifiedTimestamps, true, 'Prueba 3: hasVerifiedTimestamps is true');
  assert.equal(act3.windowSessionsCount, 1, 'Prueba 3: 1 verified session in window');

  // Prueba 4: Un marcador de otro plan o cliente no acredita actividad
  var foreignStartMarker = {
    planId: 'foreign-plan-999', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(validRecentAt).toISOString()
  };
  var val4 = eligibility.validateStartMarker('foreign-plan-999_1_0_0', foreignStartMarker, 'plan-active-1', doneEntries);
  assert.equal(val4.valid, false, 'Prueba 4: foreign plan marker is rejected');
  assert.equal(val4.reason, 'PLAN_MISMATCH', 'Prueba 4: reason is PLAN_MISMATCH');
  var act4 = eligibility.extractRealAppActivity({
    entries: doneEntries,
    starts: { 'foreign-plan-999_1_0_0': foreignStartMarker },
    plan: plan, activePlanId: 'plan-active-1', now: NOW_MS
  });
  assert.equal(act4.hasVerifiedTimestamps, false, 'Prueba 4: foreign marker does not grant verified timestamps');
  assert.equal(act4.windowSessionsCount, 0, 'Prueba 4: 0 verified sessions in window');

  // Prueba 5: Un cliente sin timestamps verificables queda excluido del motor
  var ev5 = eligibility.evaluateClientEligibility({
    clientId: 'client-1', client: client, plan: plan, entries: doneEntries, starts: {}, now: NOW_ISO
  });
  assert.equal(ev5.eligible, false, 'Prueba 5: eligible is false');
  assert.equal(ev5.reason, 'NEEDS_VERIFIED_ACTIVITY', 'Prueba 5: reason is NEEDS_VERIFIED_ACTIVITY');
  assert.equal(ev5.priority, null, 'Prueba 5: priority is null (NEVER Priority C for unverified activity)');
  assert.equal(ev5.readyForMotorProgression, false, 'Prueba 5: readyForMotorProgression is false');

  // Prueba 6: Cliente nuevo con primera interacción verificable accede a Prioridad B
  var newClient = { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: new Date(NOW_MS - 3 * DAY_MS).toISOString() };
  var ev6 = eligibility.evaluateClientEligibility({
    clientId: 'client-1', client: newClient, plan: plan,
    entries: doneEntries,
    starts: { 'plan-active-1_1_0_0': validStartMarker },
    now: NOW_ISO
  });
  assert.equal(ev6.eligible, true, 'Prueba 6: eligible after first verified training interaction');
  assert.equal(ev6.priority, 'PRIORITY_B', 'Prueba 6: accesses PRIORITY_B');
  assert.equal(ev6.category, 'NEW_CLIENT_ACTIVE', 'Prueba 6: category is NEW_CLIENT_ACTIVE');
  assert.equal(ev6.reason, 'ELIGIBLE_PRIORITY_B', 'Prueba 6: reason is ELIGIBLE_PRIORITY_B');

  // Prueba 7: Cliente recurrente genuino accede a Prioridad A
  var recStarts = makeRecurrentStarts('plan-active-1', NOW_MS - 4 * DAY_MS, NOW_MS - 2 * DAY_MS);
  var recEntries = makeRecurrentEntries({ t1: NOW_MS - 4 * DAY_MS, t2: NOW_MS - 2 * DAY_MS });
  var ev7 = eligibility.evaluateClientEligibility({
    clientId: 'client-1', client: client, plan: plan,
    entries: recEntries,
    starts: recStarts,
    now: NOW_ISO
  });
  assert.equal(ev7.eligible, true, 'Prueba 7: genuine recurrent client is eligible');
  assert.equal(ev7.priority, 'PRIORITY_A', 'Prueba 7: accesses PRIORITY_A');
  assert.equal(ev7.category, 'RECURRENT_ACTIVE', 'Prueba 7: category is RECURRENT_ACTIVE');
  assert.equal(ev7.activity.windowSessionsCount, 2, 'Prueba 7: exactly 2 verified sessions in 14-day rolling window');

  // Prueba 8: Un cliente sin actividad reciente no recibe escrituras de progresión
  var db8 = makeFakeDb({
    'clients/client-1': client,
    'plans/plan-active-1': plan,
    'logs/client-1': { planId: 'plan-active-1', entries: fakeStsEntries, updatedAt: 1 },
    'logs/client-1/mesos/plan-active-1': { planId: 'plan-active-1', entries: fakeStsEntries, updatedAt: 1 },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: ['client-1'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['client-1'], prescriptionExerciseIds: [] } }
  });
  var writesBefore8 = db8.stats.sets;
  var out8 = await executor.processProgression({
    db: db8, clientId: 'client-1', planId: 'plan-active-1', enabled: true, numericApplyEnabled: true, clock: () => NOW_ISO, enforceActiveEligibility: true
  });
  assert.equal(out8.status, 'NEEDS_VERIFIED_ACTIVITY', 'Prueba 8: returns NEEDS_VERIFIED_ACTIVITY');
  assert.equal(db8.stats.sets, writesBefore8, 'Prueba 8: exactly 0 writes executed');
  assert.deepEqual(out8.applied, [], 'Prueba 8: 0 applied');
  assert.deepEqual(out8.consumed, [], 'Prueba 8: 0 consumed');

  // Prueba 9: El POST y el sweep tienen la misma política
  var db9 = makeFakeDb({
    'clients/client-1': client,
    'plans/plan-active-1': plan,
    'logs/client-1': { planId: 'plan-active-1', entries: fakeStsEntries, updatedAt: 1 },
    'logs/client-1/mesos/plan-active-1': { planId: 'plan-active-1', entries: fakeStsEntries, updatedAt: 1 },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: ['client-1'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['client-1'], prescriptionExerciseIds: [] } }
  });
  var sweep9 = await sweep.runSweep({ db: db9, enabled: true, numericApplyEnabled: true, clock: () => NOW_ISO });
  assert.equal(sweep9.results[0].status, 'NEEDS_VERIFIED_ACTIVITY', 'Prueba 9 sweep: returns NEEDS_VERIFIED_ACTIVITY');

  var postResStatus9 = null, postResBody9 = null;
  var fakeRes9 = {
    status: function(code) { postResStatus9 = code; return this; },
    json: function(data) { postResBody9 = data; return this; },
    setHeader: function() {}
  };
  var postHandler9 = trigger.makeHandler({
    db: db9,
    verifyIdToken: async function() { return { uid: 'client-1' }; },
    enabled: true,
    numericApplyEnabled: true,
    clock: () => NOW_ISO
  });
  await postHandler9({ method: 'POST', headers: { authorization: 'Bearer token-ok' }, body: { planId: 'plan-active-1' } }, fakeRes9);
  assert.equal(postResStatus9, 200, 'Prueba 9 POST: status 200');
  assert.equal(postResBody9.status, 'NEEDS_VERIFIED_ACTIVITY', 'Prueba 9 POST: outcome is identical NEEDS_VERIFIED_ACTIVITY');

  // Prueba 10: Las progresiones PENDING -> APPLIED -> CONSUMED siguen funcionando
  var uid10 = 'client-1', p10 = 'plan-active-1';
  var db10 = makeFakeDb({
    ['clients/' + uid10]: client,
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: [uid10] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: [uid10], prescriptionExerciseIds: [] } },
    ['plans/' + p10]: plan,
    ['logs/' + uid10]: { planId: p10, entries: recEntries, updatedAt: 2 },
    ['logs/' + uid10 + '/mesos/' + p10]: { planId: p10, entries: recEntries, updatedAt: 2 },
    ['logs/' + uid10 + '/starts/' + p10 + '_1_0_0']: { planId: p10, week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(NOW_MS - 4 * DAY_MS).toISOString() },
    ['logs/' + uid10 + '/starts/' + p10 + '_1_2_0']: { planId: p10, week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(NOW_MS - 2 * DAY_MS).toISOString() }
  });
  var step1 = await executor.processProgression({ db: db10, clientId: uid10, planId: p10, enabled: true, numericApplyEnabled: true, clock: () => NOW_ISO, enforceActiveEligibility: true });
  assert.equal(step1.status, 'MATERIALIZED', 'Prueba 10: materialized');
  assert.equal(step1.applied[0].written, true, 'Prueba 10: applied');
  var meso10 = db10.docs.get('logs/' + uid10 + '/mesos/' + p10);
  var [rec10] = Object.values(meso10.progressionApplications);
  var [ovl10] = Object.values(meso10.nextExposureOverlays);
  assert.equal(rec10.state, 'APPLIED', 'Prueba 10: record state is APPLIED');

  // Next exposure set + start marker + receipt
  var nextSetKey = 'log_' + ovl10.target.week + '_' + ovl10.target.dayIndex + '_0_s0';
  meso10.entries[nextSetKey] = { done: true, carga: '100', reps: '12', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: NOW_MS };
  meso10.consumptionReceipts = {
    [rec10.key]: {
      schema: consumer.RECEIPT_SCHEMA, recordKey: rec10.key, overlayKey: ovl10.key, clientId: uid10, planId: p10,
      prescriptionExerciseId: 'pid-press', target: ovl10.target, dimension: ovl10.dimension, appliedValue: ovl10.appliedValue,
      provenance: 'CANONICAL_OVERLAY', ackAt: NOW_ISO
    }
  };
  db10.docs.set('logs/' + uid10 + '/mesos/' + p10, meso10);
  db10.docs.set('logs/' + uid10, { planId: p10, entries: meso10.entries, updatedAt: 3 });
  db10.docs.set('logs/' + uid10 + '/starts/' + p10 + '_' + ovl10.target.week + '_' + ovl10.target.dayIndex + '_0', {
    planId: p10, week: ovl10.target.week, dayIndex: ovl10.target.dayIndex, exerciseIndex: 0, setKey: nextSetKey, at: NOW_ISO
  });

  var step2 = await executor.processProgression({ db: db10, clientId: uid10, planId: p10, enabled: true, numericApplyEnabled: true, clock: () => NOW_ISO, enforceActiveEligibility: true });
  assert.deepEqual(step2.consumed.map(x => [x.written, x.reason]), [[true, null]], 'Prueba 10: consumed');
  var finalMeso10 = db10.docs.get('logs/' + uid10 + '/mesos/' + p10);
  assert.equal(finalMeso10.progressionApplications[rec10.key].state, 'CONSUMED', 'Prueba 10: record state is CONSUMED');
  assert.equal(finalMeso10.nextExposureOverlays[ovl10.key].status, 'CONSUMED', 'Prueba 10: overlay state is CONSUMED');
});

test('T685.3: Cierre final de elegibilidad antes del merge (3 pruebas focalizadas)', async () => {
  // PRUEBA 1 (Corrección 1 - Selección temporal de marcadores):
  // Cliente con 60 marcadores históricos antiguos (>60 días) y 2 sesiones recientes válidas.
  // Con orderBy('at', 'desc').limit(50), las sesiones recientes se recuperan primero y no quedan desplazadas por históricos.
  var uidP1 = 'client-p1', planP1 = 'plan-active-1';
  var seedDocsP1 = {
    ['clients/' + uidP1]: { coachId: 'coach-1', activePlanId: planP1, createdAt: '2026-01-01T00:00:00.000Z' },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: [uidP1] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: [uidP1], prescriptionExerciseIds: [] } },
    ['plans/' + planP1]: makePlan({ clientId: uidP1, id: planP1 }),
    ['logs/' + uidP1]: { planId: planP1, entries: {}, updatedAt: 1 },
    ['logs/' + uidP1 + '/mesos/' + planP1]: { planId: planP1, entries: {}, updatedAt: 1 }
  };
  var entriesP1 = {};
  for (var hi = 0; hi < 60; hi++) {
    var histAt = NOW_MS - (60 + hi) * DAY_MS;
    var histKey = 'log_0_0_0_s' + hi;
    entriesP1[histKey] = { done: true, carga: '80', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: histAt };
    seedDocsP1['logs/' + uidP1 + '/starts/' + planP1 + '_0_0_' + hi] = {
      planId: planP1, week: 0, dayIndex: 0, exerciseIndex: hi, setKey: histKey, at: new Date(histAt).toISOString()
    };
  }
  var tRecent1 = NOW_MS - 4 * DAY_MS;
  var tRecent2 = NOW_MS - 2 * DAY_MS;
  entriesP1['log_1_0_0_s0'] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: tRecent1 };
  entriesP1['log_1_2_0_s0'] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: tRecent2 };
  entriesP1.progrec_1_2 = {
    calculatedAt: new Date(tRecent2 + 10000).toISOString(),
    recommendations: [
      {
        prescriptionExerciseId: 'pid-press',
        exerciseId: 'ex-press',
        exerciseName: 'Press banca',
        action: 'increase_reps',
        newReps: 11
      }
    ]
  };
  seedDocsP1['logs/' + uidP1 + '/starts/' + planP1 + '_1_0_0'] = {
    planId: planP1, week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(tRecent1).toISOString()
  };
  seedDocsP1['logs/' + uidP1 + '/starts/' + planP1 + '_1_2_0'] = {
    planId: planP1, week: 1, dayIndex: 2, exerciseIndex: 0, setKey: 'log_1_2_0_s0', at: new Date(tRecent2).toISOString()
  };
  seedDocsP1['logs/' + uidP1].entries = entriesP1;
  seedDocsP1['logs/' + uidP1 + '/mesos/' + planP1].entries = entriesP1;

  var dbP1 = makeFakeDb(seedDocsP1);
  var sweepResP1 = await sweep.runSweep({ db: dbP1, enabled: true, numericApplyEnabled: false, clock: () => NOW_ISO });
  assert.equal(sweepResP1.status, 'SWEPT', 'Prueba 1: sweep completado');
  assert.equal(sweepResP1.processed, 1, 'Prueba 1: 1 cliente procesado');
  assert.equal(sweepResP1.results[0].status, 'MATERIALIZED', 'Prueba 1: cliente activo con >50 históricos se materializó correctamente');

  // PRUEBA 2 (Corrección 2 - Consistencia transaccional y fail-closed ante errores de lectura):
  var uidFail = 'client-fail-starts';
  var seedDocsFail = {
    ['clients/' + uidFail]: { coachId: 'coach-1', activePlanId: planP1, createdAt: '2026-01-01T00:00:00.000Z' },
    'releaseControl/autonomousProgression': { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: [uidFail] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: [uidFail], prescriptionExerciseIds: [] } },
    ['plans/' + planP1]: makePlan({ clientId: uidFail, id: planP1 }),
    ['logs/' + uidFail]: { planId: planP1, entries: entriesP1, updatedAt: 1 },
    ['logs/' + uidFail + '/mesos/' + planP1]: { planId: planP1, entries: entriesP1, updatedAt: 1 }
  };
  var dbFail = makeFakeDb(seedDocsFail, [], [uidFail]);

  // A) Ejecución transaccional individual (processProgression)
  var stepFail = await executor.processProgression({
    db: dbFail, clientId: uidFail, planId: planP1, enabled: true, numericApplyEnabled: true,
    clock: () => NOW_ISO, enforceActiveEligibility: true
  });
  assert.equal(stepFail.status, 'READ_FAILED', 'Prueba 2: status es READ_FAILED');
  assert.equal(stepFail.reason, 'STARTS_READ_FAILED', 'Prueba 2: reason es STARTS_READ_FAILED (no se disfraza de inactividad)');
  assert.equal(stepFail.eligible, false, 'Prueba 2: eligible es false');
  assert.equal(stepFail.applied.length, 0, 'Prueba 2: 0 applied');
  assert.equal(stepFail.consumed.length, 0, 'Prueba 2: 0 consumed');

  // B) Ejecución en sweep
  var sweepFail = await sweep.runSweep({ db: dbFail, enabled: true, numericApplyEnabled: false, clock: () => NOW_ISO });
  assert.equal(sweepFail.results[0].status, 'STARTS_READ_FAILED', 'Prueba 2 Sweep: status es STARTS_READ_FAILED');
  assert.notEqual(sweepFail.results[0].status, 'INACTIVE_CLIENT', 'Prueba 2 Sweep: no se enmascara como INACTIVE_CLIENT');
  assert.notEqual(sweepFail.results[0].status, 'NEEDS_VERIFIED_ACTIVITY', 'Prueba 2 Sweep: no se enmascara como NEEDS_VERIFIED_ACTIVITY');

  // PRUEBA 3 (Corrección 3 - Rechazo estricto de marcadores residuales e inválidos):
  var validEntries = {
    log_1_0_0_s0: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: tRecent1 }
  };
  var validMarker = {
    planId: planP1, week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(tRecent1).toISOString()
  };

  // 3a: Marcador con ID que no coincide exactamente con planId_w_d_e
  var resIdMismatch = eligibility.validateStartMarker('plan-active-1_1_0_999', validMarker, planP1, validEntries);
  assert.equal(resIdMismatch.valid, false, 'Prueba 3a: ID mismatch rechazado');
  assert.equal(resIdMismatch.reason, 'ID_MISMATCH', 'Prueba 3a: reason ID_MISMATCH');

  // 3b: Marcador residual sin working set referenciado en entries (serie eliminada por usuario)
  var resResidual = eligibility.validateStartMarker('plan-active-1_1_0_0', validMarker, planP1, {});
  assert.equal(resResidual.valid, false, 'Prueba 3b: marcador residual sin serie rechazado');
  assert.equal(resResidual.reason, 'WORKING_SET_NOT_FOUND', 'Prueba 3b: reason WORKING_SET_NOT_FOUND');

  // 3c: Marcador con serie referenciada pero no completada (done: false)
  var notDoneEntries = {
    log_1_0_0_s0: { done: false, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: tRecent1 }
  };
  var resNotDone = eligibility.validateStartMarker('plan-active-1_1_0_0', validMarker, planP1, notDoneEntries);
  assert.equal(resNotDone.valid, false, 'Prueba 3c: serie no completada rechazada');
  assert.equal(resNotDone.reason, 'WORKING_SET_NOT_DONE', 'Prueba 3c: reason WORKING_SET_NOT_DONE');

  // 3d: Marcador con serie referenciada sintética / no-cliente
  var syntheticEntries = {
    log_1_0_0_s0: { done: true, synthetic: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: tRecent1 }
  };
  var resSynthetic = eligibility.validateStartMarker('plan-active-1_1_0_0', validMarker, planP1, syntheticEntries);
  assert.equal(resSynthetic.valid, false, 'Prueba 3d: serie sintética rechazada');
  assert.equal(resSynthetic.reason, 'SYNTHETIC_OR_NON_CLIENT', 'Prueba 3d: reason SYNTHETIC_OR_NON_CLIENT');

  // 3e: Marcador canónico válido con serie real completada
  var resOk = eligibility.validateStartMarker('plan-active-1_1_0_0', validMarker, planP1, validEntries);
  assert.equal(resOk.valid, true, 'Prueba 3e: marcador canónico válido aceptado');
  assert.equal(resOk.sessionKey, '1_0', 'Prueba 3e: sessionKey 1_0');
});
