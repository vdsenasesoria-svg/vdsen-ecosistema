'use strict';
// T858 — Cross-plan log isolation & Week-1 activation regression suite
// Reproduces Ayrton's exact real transition (D5fVjlS3NysTD6Yg2ZpW Sem 3 -> ucwGfeXn2NGPhnY6CZjb 13-week virgin -> Sem 1 D1 19 sets).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CLIENT_HTML = fs.readFileSync(path.join(ROOT, 'vdsen-cliente.html'), 'utf8');
const COACH_HTML = fs.readFileSync(path.join(ROOT, 'vdsen-coach.html'), 'utf8');
const shadow = require(path.join(ROOT, 'assets/progression-auto-apply-shadow.js'));
const eligibility = require(path.join(ROOT, 'api/_clientEligibility.js'));

const OLD_PLAN = 'D5fVjlS3NysTD6Yg2ZpW';
const NEW_PLAN = 'ucwGfeXn2NGPhnY6CZjb';
const OLD_PID = '49211d1e-1223-42f5-b679-92fe1ccdb6a1';
const NEW_D1_PIDS = [
  'c1755fad-dcd4-4a66-bb7c-e688df1ba641',
  '336e5f35-2e57-479f-9bce-380b1844f732',
  '8821a34a-3474-4c13-a6c9-6246f92ed438',
  '36cbdd0f-aa80-4ff9-9e0d-75419ee5ae20',
  '25745638-3c92-415a-854b-00cafa88e130',
  '0f4ced2a-f875-4ae4-8f45-7f3ff3bb90b0',
  'b1819cdd-abaa-4fd9-be7f-88580bb0258e',
  '21ed2c3b-218b-49dc-b944-acf2a0f71030',
];

function extractFn(src, name) {
  let idx = src.indexOf('async function ' + name + '(');
  if (idx < 0) idx = src.indexOf('function ' + name + '(');
  assert.ok(idx >= 0, 'Missing function: ' + name);
  let depth = 0, quote = null, esc = false;
  for (let i = src.indexOf('{', idx); i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return src.slice(idx, i + 1);
  }
  throw new Error('Unbalanced braces for ' + name);
}

function makeOldPlanRootLog() {
  return {
    planId: OLD_PLAN,
    currentWeek: 3,
    updatedAt: Date.parse('2026-11-20T03:00:00.000Z'),
    exerciseHistory: { 'Press Convergente Inclinado': [{ carga: 30, reps: 8, date: '2026-11-20' }] },
    seguimientoSummary: { pendingCount: 0 },
    entries: {
      log_3_0_0_s0: { done: true, carga: 80, reps: 6, rir: 3, ics: 10, planId: OLD_PLAN, prescriptionExerciseId: OLD_PID, ts: Date.parse('2026-11-20T03:00:00.000Z') },
      log_3_0_0_s1: { done: true, carga: 80, reps: 6, rir: 3, ics: 10, planId: OLD_PLAN, prescriptionExerciseId: OLD_PID, ts: Date.parse('2026-11-20T03:01:00.000Z') },
      log_3_0_0_s2: { done: true, carga: 80, reps: 6, rir: 3, ics: 10, planId: OLD_PLAN, prescriptionExerciseId: OLD_PID, ts: Date.parse('2026-11-20T03:02:00.000Z') },
      log_3_0_0_s3: { done: true, carga: 80, reps: 6, rir: 3, ics: 10, planId: OLD_PLAN, prescriptionExerciseId: OLD_PID, ts: Date.parse('2026-11-20T03:03:00.000Z') },
      done_3_0: { ts: Date.parse('2026-11-20T03:05:00.000Z') },
      progrec_3_0: { calculatedAt: '2026-11-20T03:05:00.000Z', recommendations: [{ prescriptionExerciseId: OLD_PID, action: 'increase_load', newLoad: 82.5 }] },
    },
  };
}

test('T858.1 selectLogAuthority rejects previous-plan root when new meso doc does not exist yet (parity shadow === client)', () => {
  const ctx = {};
  vm.createContext(ctx);
  ['_logDocHasEvidence', '_isLegacyUnboundLog', '_selectLogAuthority'].forEach(n => vm.runInContext(extractFn(CLIENT_HTML, n), ctx));

  const oldRoot = makeOldPlanRootLog();
  assert.equal(shadow.selectLogAuthority(null, oldRoot, NEW_PLAN), null, 'shadow must return null, never old plan root');
  assert.equal(ctx._selectLogAuthority(null, oldRoot, NEW_PLAN), null, 'client must return null, never old plan root');
  assert.equal(shadow.selectLogAuthority(oldRoot, null, NEW_PLAN), null, 'shadow must reject mismatched meso');
  assert.equal(ctx._selectLogAuthority(oldRoot, null, NEW_PLAN), null, 'client must reject mismatched meso');

  // Same-plan control still resolves normally
  assert.equal(shadow.selectLogAuthority(null, oldRoot, OLD_PLAN), oldRoot);
  assert.equal(ctx._selectLogAuthority(null, oldRoot, OLD_PLAN), oldRoot);

  // New meso alongside stale old root selects new meso
  const newMeso = { planId: NEW_PLAN, currentWeek: 1, updatedAt: Date.parse('2026-11-21T18:00:00.000Z'), entries: {} };
  assert.equal(shadow.selectLogAuthority(newMeso, oldRoot, NEW_PLAN), newMeso);
  assert.equal(ctx._selectLogAuthority(newMeso, oldRoot, NEW_PLAN), newMeso);
});

test('T858.2 App Coach _selectCoachLogForActivePlan isolates Dashboard & Monitor from previous plan carryover', () => {
  const ctx = { window: { VDSEN_AUTO_APPLY_SHADOW: shadow }, Object };
  vm.createContext(ctx);
  vm.runInContext(extractFn(COACH_HTML, '_selectCoachLogForActivePlan'), ctx);

  const oldRoot = makeOldPlanRootLog();
  const isolated = JSON.parse(JSON.stringify(ctx._selectCoachLogForActivePlan(oldRoot, NEW_PLAN, null)));
  assert.equal(isolated.planId, NEW_PLAN);
  assert.equal(isolated.currentWeek, 1, 'must start at Week 1, never inherit Sem 3');
  assert.deepEqual(isolated.entries, {}, 'must not leak old sets or progrec_3_0 / old PIDs');
  assert.deepEqual(isolated.seguimientoSummary, { pendingCount: 0 }, 'preserves plan-independent seguimientoSummary');

  // Once new plan has real Week 1 Day 1 entries, Coach reads them cleanly
  const newRoot = { planId: NEW_PLAN, currentWeek: 1, updatedAt: Date.now(), entries: { log_1_0_0_s0: { done: true, carga: 4.5, reps: 15 } } };
  const live = ctx._selectCoachLogForActivePlan(newRoot, NEW_PLAN, null);
  assert.equal(live, newRoot);
  assert.equal(live.currentWeek, 1);
  assert.equal(live.entries.log_1_0_0_s0.carga, 4.5);
});

test('T858.3 App Cliente & App Coach wire cross-plan isolation into loadPlan, Dashboard, Monitor, and plan activation', () => {
  // App Cliente handles !logData by preserving EXERCISE_HISTORY and resetting to Week 1
  assert.ok(CLIENT_HTML.includes('T858: virgin plan or cross-plan root rejected by _selectLogAuthority'));
  assert.ok(CLIENT_HTML.includes('if (_rootDataRaw && _rootDataRaw.exerciseHistory) EXERCISE_HISTORY = _rootDataRaw.exerciseHistory;'));
  // App Coach Dashboard, Standalone Monitor, and Modal Monitor use _selectCoachLogForActivePlan
  assert.ok(COACH_HTML.includes('const logData = _selectCoachLogForActivePlan(_rawLogData, c.activePlanId, null);'));
  assert.ok(COACH_HTML.includes('window._selectCoachLogForActivePlan(logsSnap.data(), _monitorActivePlanId, null)'));
  assert.ok(COACH_HTML.includes('window._selectCoachLogForActivePlan(_rawLogsData, c && c.activePlanId, null)'));
  // Plan activation invokes _initNewPlanWeekOne
  assert.ok(COACH_HTML.includes("if (outcome === 'COMMITTED' && typeof _initNewPlanWeekOne === 'function') await _initNewPlanWeekOne(o.clientId, planId, prevId);"));
  assert.ok(COACH_HTML.includes('await _initNewPlanWeekOne(clientId, planId, _prevActivePlanId);'));
});

test('T858.4 _initNewPlanWeekOne initializes Week 1 on new plan while preserving previous meso & exerciseHistory, and never overwrites existing sets', async () => {
  const store = new Map();
  const oldRoot = makeOldPlanRootLog();
  store.set('logs/ayrton', structuredClone(oldRoot));
  store.set('logs/ayrton/mesos/' + OLD_PLAN, structuredClone(oldRoot));

  const ctx = {
    Date, Object, Promise, console,
    doc: (_db, ...segs) => segs.join('/'),
    db: {},
    runTransaction: async (_db, fn) => {
      const writes = [];
      const tx = {
        get: async (ref) => ({ exists: () => store.has(ref), data: () => structuredClone(store.get(ref)) }),
        set: (ref, payload) => { writes.push([ref, structuredClone(payload)]); },
      };
      await fn(tx);
      for (const [ref, payload] of writes) store.set(ref, payload);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFn(COACH_HTML, '_initNewPlanWeekOne'), ctx);

  // 1) Activate new virgin plan -> initializes Week 1 on root + new meso, leaves old meso untouched
  await ctx._initNewPlanWeekOne('ayrton', NEW_PLAN, OLD_PLAN);
  const newMeso = store.get('logs/ayrton/mesos/' + NEW_PLAN);
  const newRoot = store.get('logs/ayrton');
  const oldMesoAfter = store.get('logs/ayrton/mesos/' + OLD_PLAN);

  assert.equal(newMeso.planId, NEW_PLAN);
  assert.equal(newMeso.currentWeek, 1);
  assert.deepEqual(newMeso.entries, {});
  assert.deepEqual(newMeso.exerciseHistory, oldRoot.exerciseHistory, 'exerciseHistory preserved');
  assert.equal(newRoot.planId, NEW_PLAN);
  assert.equal(newRoot.currentWeek, 1);
  assert.deepEqual(newRoot.entries, {});
  assert.equal(Object.keys(oldMesoAfter.entries).filter(k => k.startsWith('log_')).length, 4, 'previous plan 4 sets preserved untouched');

  // 2) After Ayrton logs real Week 1 Day 1 sets on NEW_PLAN, re-running _initNewPlanWeekOne MUST NOT overwrite them
  newMeso.entries = { log_1_0_0_s0: { done: true, carga: 4.5, reps: 15, rir: 3, ics: 10, prescriptionExerciseId: NEW_D1_PIDS[0] } };
  store.set('logs/ayrton/mesos/' + NEW_PLAN, structuredClone(newMeso));
  await ctx._initNewPlanWeekOne('ayrton', NEW_PLAN, OLD_PLAN);
  assert.equal(store.get('logs/ayrton/mesos/' + NEW_PLAN).entries.log_1_0_0_s0.carga, 4.5, 'existing real workout sets never overwritten');
});

test('T858.5 Eligibility on Ayrton scenario: 0 exposures on virgin plan -> 19 real sets Week 1 Day 1 (NEEDS_EVIDENCE, returning athlete)', () => {
  const nowIso = '2026-11-21T21:00:00.000Z';
  const planActivated = '2026-11-21T06:00:00.000Z';
  const client = { uid: 'ayrton', coachId: 'coach-1', activePlanId: NEW_PLAN, createdAt: '2026-09-05T00:00:00.000Z' };
  const setCounts = [3, 3, 3, 2, 2, 2, 2, 2]; // 19 sets total across 8 D1 exercises
  const plan = {
    id: NEW_PLAN, clientId: 'ayrton', coachId: 'coach-1', status: 'active', weeks: 13,
    createdAt: planActivated, activatedAt: planActivated, updatedAt: planActivated,
    days: [{
      dayIndex: 0,
      exercises: NEW_D1_PIDS.map((pid, ei) => ({
        exerciseIndex: ei, exerciseType: 'fuerza', prescriptionExerciseId: pid,
        sets: Array.from({ length: setCounts[ei] }, (_, si) => ({ setIndex: si, repsTarget: 10, rirTarget: 3 })),
      })),
    }],
  };

  // Before training: stale old root present, no new meso yet -> 0 sets, NEEDS_EVIDENCE, isNewClient=false
  const ev0 = eligibility.evaluateClientEligibility({
    clientId: 'ayrton', client, plan, meso: null, root: makeOldPlanRootLog(), starts: {}, now: nowIso,
  });
  assert.equal(ev0.technicalState, 'NEEDS_EVIDENCE');
  assert.equal(ev0.isNewClient, false);
  assert.equal(ev0.activity.realSetsCount, 0);

  // After Week 1 Day 1 (19 real sets + T603 start marker) -> 19 sets, 1 session, still NEEDS_EVIDENCE (needs 2 comparable exposures)
  const w1Ts = Date.parse('2026-11-21T19:30:00.000Z');
  const entries = { done_1_0: { ts: w1Ts + 4800000, planId: NEW_PLAN } };
  const starts = {};
  NEW_D1_PIDS.forEach((pid, ei) => {
    starts[`${NEW_PLAN}_1_0_${ei}`] = { planId: NEW_PLAN, week: 1, dayIndex: 0, exerciseIndex: ei, setKey: `log_1_0_${ei}_s0`, at: { toMillis: () => w1Ts + ei * 60000 } };
    for (let si = 0; si < setCounts[ei]; si++) {
      entries[`log_1_0_${ei}_s${si}`] = { done: true, carga: 30, reps: 10, rir: 2, ics: 10, ts: w1Ts + ei * 60000 + si * 1000, planId: NEW_PLAN, prescriptionExerciseId: pid };
    }
  });
  const mesoW1 = { planId: NEW_PLAN, currentWeek: 1, updatedAt: w1Ts + 4800000, entries };
  const ev1 = eligibility.evaluateClientEligibility({
    clientId: 'ayrton', client, plan, meso: mesoW1, root: mesoW1, starts, now: nowIso,
  });
  assert.equal(ev1.activity.realSetsCount, 19, 'all 19 real Week 1 Day 1 sets counted');
  assert.equal(ev1.activity.realSessionsCount, 1);
  assert.equal(ev1.activity.exercisesWithTwoExposures, 0);
  assert.equal(ev1.technicalState, 'NEEDS_EVIDENCE', 'no premature progression after 1 exposure');
  assert.equal(ev1.readyForMotorProgression, false);
  assert.equal(ev1.isNewClient, false);
});
