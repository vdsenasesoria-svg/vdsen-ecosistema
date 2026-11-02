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

function makeFakeDb(seedDocs, failingClients) {
  var docs = new Map(Object.entries(seedDocs || {}));
  var failSet = new Set(failingClients || []);
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
    return {
      path: colPath,
      doc: function(id) { return makeRef(colPath + '/' + id); },
      where: function(field, op, expected) {
        return {
          get: async function() {
            stats.queries++;
            stats.pathsRead.push('QUERY:' + colPath + ':' + field);
            var out = [];
            for (let [k, v] of docs.entries()) {
              if (k.indexOf(colPath + '/') === 0 && k.slice(colPath.length + 1).indexOf('/') < 0) {
                var actual = field.split('.').reduce(function(o, p) { return o ? o[p] : undefined; }, v);
                if (op === '==' && actual === expected) {
                  let snapCopy = structuredClone(v);
                  out.push({ id: k.split('/').pop(), data: function() { return structuredClone(snapCopy); } });
                }
              }
            }
            return { docs: out };
          }
        };
      }
    };
  }

  var tx = {
    get: async function(ref) {
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
  var releaseDoc = { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: ['client-1'] };
  var coachDoc = { autoApplyCanary: { enabled: true, clientIds: ['client-1'], prescriptionExerciseIds: [] } };
  var ev = eligibility.evaluateClientEligibility({
    clientId: 'client-1',
    client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-08-01T00:00:00.000Z' },
    plan: plan,
    entries: entries,
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

  // 2b) First real working set recorded in App Cliente -> becomes eligible as PRIORITY_B
  var firstSetTs = NOW_MS - 1 * DAY_MS;
  var afterFirstSet = eligibility.evaluateClientEligibility({
    clientId: 'client-new',
    client: client,
    plan: plan,
    entries: {
      log_1_0_0_s0: { done: true, carga: '60', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: firstSetTs, sts: firstSetTs }
    },
    now: NOW_ISO
  });
  assert.equal(afterFirstSet.eligible, true);
  assert.equal(afterFirstSet.priority, 'PRIORITY_B');
  assert.equal(afterFirstSet.priorityRank, 2);
  assert.equal(afterFirstSet.category, 'NEW_CLIENT_ACTIVE');
  assert.equal(afterFirstSet.activity.windowSessionsCount, 1);

  // 2c) First exposure start marker in logs/{uid}/starts/* also counts as verifiable first activity
  var afterStartMarker = eligibility.evaluateClientEligibility({
    clientId: 'client-new',
    client: client,
    plan: plan,
    entries: {},
    starts: {
      'plan-active-1_1_0_0': { planId: 'plan-active-1', week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: new Date(firstSetTs).toISOString() }
    },
    now: NOW_ISO
  });
  assert.equal(afterStartMarker.eligible, true);
  assert.equal(afterStartMarker.priority, 'PRIORITY_B');
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
  var inactiveEv = eligibility.evaluateClientEligibility({
    clientId: 'client-1',
    client: existingClient,
    plan: plan,
    entries: oldEntries,
    now: NOW_ISO,
    windowDays: 14,
    inactiveDays: 28
  });
  assert.equal(inactiveEv.eligible, false);
  assert.equal(inactiveEv.reason, 'INACTIVE_CLIENT');

  // 5b) Existing client with activity 20 days ago and 5 days ago (only 1 session in the 14-day rolling window, not inactive) -> PRIORITY_C
  var occasionalEntries = makeRecurrentEntries({ t1: NOW_MS - 20 * DAY_MS, t2: NOW_MS - 5 * DAY_MS });
  var occasionalEv = eligibility.evaluateClientEligibility({
    clientId: 'client-1',
    client: existingClient,
    plan: plan,
    entries: occasionalEntries,
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
    'logs/client-1/mesos/plan-active-1': { planId: 'plan-active-1', entries: entries, updatedAt: 2 }
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
    items.push({
      clientId: 'rec-' + ia,
      client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-07-01T00:00:00.000Z' },
      plan: makePlan({ clientId: 'rec-' + ia }),
      entries: makeRecurrentEntries({ t1: NOW_MS - (ia + 2) * DAY_MS, t2: NOW_MS - ia * DAY_MS }),
      now: NOW_ISO
    });
  }
  // 4 Priority B new active clients (1 session after onboarding)
  for (var ib = 1; ib <= 4; ib++) {
    var tsB = NOW_MS - ib * 3600000;
    items.push({
      clientId: 'new-active-' + ib,
      client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-10-10T00:00:00.000Z' },
      plan: makePlan({ clientId: 'new-active-' + ib, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' }),
      entries: { log_1_0_0_s0: { done: true, carga: '80', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: 'pid-press', ts: tsB, sts: tsB } },
      now: NOW_ISO
    });
  }
  // 3 Priority C occasional clients
  for (var ic = 1; ic <= 3; ic++) {
    items.push({
      clientId: 'occ-' + ic,
      client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-05-01T00:00:00.000Z' },
      plan: makePlan({ clientId: 'occ-' + ic, createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' }),
      entries: makeRecurrentEntries({ t1: NOW_MS - 22 * DAY_MS, t2: NOW_MS - 6 * DAY_MS }),
      now: NOW_ISO
    });
  }
  // 5 Excluded clients (no plan, new without activity, no app usage, inactive, safety hold)
  items.push({ clientId: 'ex-noplan', client: { coachId: 'coach-1', activePlanId: null }, plan: null, entries: {}, now: NOW_ISO });
  items.push({ clientId: 'ex-new-idle', client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-10-13T00:00:00.000Z' }, plan: makePlan({ clientId: 'ex-new-idle', createdAt: '2026-10-13T00:00:00.000Z' }), entries: {}, now: NOW_ISO });
  items.push({ clientId: 'ex-unused', client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-05-01T00:00:00.000Z' }, plan: makePlan({ clientId: 'ex-unused' }), entries: {}, now: NOW_ISO });
  items.push({ clientId: 'ex-inactive', client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-05-01T00:00:00.000Z' }, plan: makePlan({ clientId: 'ex-inactive' }), entries: makeRecurrentEntries({ t1: NOW_MS - 45 * DAY_MS, t2: NOW_MS - 35 * DAY_MS }), now: NOW_ISO });
  var painEntries = makeRecurrentEntries();
  painEntries.postsession_1_2 = { completedAt: NOW_ISO, articularPain: { present: true } };
  items.push({ clientId: 'ex-pain', client: { coachId: 'coach-1', activePlanId: 'plan-active-1', createdAt: '2026-05-01T00:00:00.000Z' }, plan: makePlan({ clientId: 'ex-pain' }), entries: painEntries, now: NOW_ISO });

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
      ['logs/' + uid + '/mesos/' + planId]: { planId: planId, entries: entries, updatedAt: 2 }
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
    'logs/client-1/mesos/plan-active-1': { planId: planId, entries: entries, updatedAt: 2 }
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
    'logs/client-ok/mesos/plan-ok': { planId: 'plan-ok', entries: entries, updatedAt: 2 }
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

  // 13c) Pilot runtime OFF baseline aligns with T682/T683 canonical release
  var releaseState = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.release', 'vdsen-client.json'), 'utf8'));
  assert.equal(pilotRuntime.T671, appLive.SAFE_OFF_BASELINE.runtimeSha);
  assert.equal(pilotRuntime.OFF_BASELINE_SHA, 'c3c1875425fe53981df512bdaa0dbe18d81de34d');
  assert.equal(pilotRuntime.T671, releaseState.runtime_sha);
  assert.equal(pilotRuntime.LEGACY_T671_SHA, 'a8cf462c78c4bd795cc9f485a82f64429c179f00');
});
