const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const client = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const at = '2026-09-27T12:00:00.000Z';
const plan = { clientId: 'client-A', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [
  { dayIndex: 0, exercises: [{ prescriptionExerciseId: 'pid-A', exerciseId: 'ex-A', exerciseName: 'Remo', sets: [{ load: 50, repsTarget: 10 }] }] },
  { dayIndex: 2, exercises: [{ prescriptionExerciseId: 'pid-A', exerciseId: 'ex-A', exerciseName: 'Remo', sets: [{ load: 50, repsTarget: 10 }] }] }
] };
const rec = { prescriptionExerciseId: 'pid-A', exerciseId: 'ex-A', exerciseName: 'Remo', action: 'increase_load', newLoad: 52, newReps: 10 };
const base = { clientId: 'client-A', planId: 'plan-A', activePlanId: 'plan-A', plan,
  week: 1, dayIndex: 0, calculatedAt: at, recommendation: rec, sourceMatches: true, sourcePidCount: 1 };

function functionSource(source, name) {
  let start = source.indexOf('async function ' + name + '(');
  if (start < 0) start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let depth = 0, quote = null, escaped = false, body = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') { depth++; body = true; }
    if (c === '}' && --depth === 0 && body) return source.slice(start, i + 1);
  }
  throw new Error('Could not extract ' + name);
}

test('contract resolves next exposure by PID and blocks all numeric writes', () => {
  assert.deepEqual(shadow.resolveNextExposure(plan, 'pid-A', 1, 0), { week: 1, dayIndex: 2 });
  assert.deepEqual(shadow.resolveNextExposure(plan, 'pid-A', 1, 2), { week: 2, dayIndex: 0 });
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false);
  assert.deepEqual(shadow.attemptNumericApply({ plan, rec }),
    { ok: false, reasonCode: 'MAGNITUDE_POLICY_MISSING', applied: false });
  assert.equal(shadow.assess(base).state, 'PENDING');
  assert.equal(shadow.assess(base).reasonCode, 'MAGNITUDE_POLICY_MISSING');
  assert.equal(shadow.assess({ ...base, calculatedAt: null }).reasonCode, 'CALCULATED_AT_MISSING');
  assert.equal(shadow.assess({ ...base, plan: { ...plan, updatedAt: null } }).reasonCode, 'PLAN_TIMESTAMP_MISSING');
  assert.equal(shadow.assess({ ...base, plan: { ...plan, updatedAt: '2026-09-28T00:00:00.000Z' } }).state, 'STALE');
  assert.equal(shadow.assess({ ...base, recommendation: { ...rec, prescriptionExerciseId: 'pid-B' } }).reasonCode, 'IDENTITY_CONFLICT');
  assert.equal(shadow.assess({ ...base, sourcePidCount: 2 }).reasonCode, 'IDENTITY_CONFLICT');
  assert.equal(shadow.assess({ ...base, interventions: [{ targetType: 'EXERCISE', targetId: 'pid-A',
    planId: 'plan-A', action: 'KEEP', decidedAt: '2026-09-27T12:01:00.000Z' }] }).reasonCode, 'COACH_OVERRIDE');
  assert.equal(shadow.assess({ ...base, recommendation: { ...rec, action: 'reduce_sets' } }).reasonCode, 'UNSUPPORTED_ACTION');
  assert.equal(shadow.assess({ ...base, recommendation: { ...rec, action: 'maintain', newReps: 9 } }).dimension, 'REPS');
  assert.equal(shadow.assess({ ...base, recommendation: { ...rec, action: 'maintain', newReps: 10 } }).reasonCode, 'NO_NUMERIC_DELTA');
  assert.deepEqual(plan.days[0].exercises[0].sets[0], { load: 50, repsTarget: 10 });
});

test('record transitions are revision checked, idempotent and reversible without APPLIED state', () => {
  const pending = shadow.buildRecord(base, at);
  const keep = shadow.transition(pending, 'KEEP_ORIGINAL', 1, 'decision-1', at, 'coach-A');
  assert.equal(keep.record.state, 'REJECTED');
  assert.equal(keep.record.revision, 2);
  assert.equal(shadow.transition(keep.record, 'KEEP_ORIGINAL', 1, 'decision-1', at, 'coach-A').idempotent, true);
  assert.equal(shadow.transition(keep.record, 'REVERT_DECISION', 1, 'decision-2', at, 'coach-A').reasonCode, 'REVISION_CONFLICT');
  const reverted = shadow.transition(keep.record, 'REVERT_DECISION', 2, 'decision-2', at, 'coach-A');
  assert.equal(reverted.record.state, 'PENDING');
  assert.equal(reverted.record.reasonCode, 'MAGNITUDE_POLICY_MISSING');
  assert.equal(shadow.transition(pending, 'REVERT_DECISION', 1, 'bad', at, 'coach-A').reasonCode, 'INVALID_TRANSITION');
  assert.deepEqual(reverted.record.events.map(e => e.state), ['PENDING', 'REJECTED', 'PENDING']);
});

test('client transaction persists authority and Monitor summary atomically; retries do not duplicate', async () => {
  const parent = { calculatedAt: at, recommendations: [rec, { exerciseName: 'Legacy', action: 'increase_load', newLoad: 20 }] };
  const docs = new Map([
    ['clients/client-A', { activePlanId: 'plan-A', coachId: 'coach-A', coachInterventions: [] }],
    ['plans/plan-A', structuredClone(plan)],
    ['logs/client-A/mesos/plan-A', { planId: 'plan-A', entries: { progrec_1_0: parent } }],
    ['logs/client-A', { planId: 'plan-A', entries: { progrec_1_0: parent } }]
  ]);
  const writes = [];
  const tx = {
    get: async ref => ({ exists: () => docs.has(ref), data: () => structuredClone(docs.get(ref)) }),
    set: (ref, value, opts) => { writes.push({ ref, value, opts }); docs.set(ref, { ...docs.get(ref), ...structuredClone(value) }); }
  };
  const context = { window: { VDSEN_AUTO_APPLY_SHADOW: shadow }, USER: { uid: 'client-A' },
    ACTIVE_PLAN_ID: 'plan-A', FB: { db: {}, doc: (_db, ...parts) => parts.join('/'), runTransaction: async (_db, fn) => fn(tx) } };
  vm.createContext(context);
  ['_getSessionCompletionState', '_sessionHasRealLoggedSets', '_getSessionLifecycleState', '_selectLogAuthority']
    .forEach(name => vm.runInContext(functionSource(client, name), context));
  vm.runInContext(functionSource(client, '_recordShadowProgression'), context);
  assert.equal(await context._recordShadowProgression('client-A', 'plan-A', 1, 0, parent), true);
  const meso = docs.get('logs/client-A/mesos/plan-A');
  const rootLog = docs.get('logs/client-A');
  assert.equal(Object.keys(meso.progressionApplications).length, 2);
  assert.equal(meso.progressionApplicationSummary.autoCount, 1);
  assert.equal(meso.progressionApplicationSummary.counts.REJECTED, 1);
  assert.deepEqual(rootLog.progressionApplicationSummary, meso.progressionApplicationSummary);
  assert.deepEqual(docs.get('plans/plan-A'), plan);
  assert.ok(writes.every(w => w.opts && w.opts.merge === true));
  await context._recordShadowProgression('client-A', 'plan-A', 1, 0, parent);
  assert.equal(Object.keys(docs.get('logs/client-A/mesos/plan-A').progressionApplications).length, 2);
  const newer = { calculatedAt: '2026-09-27T12:30:00.000Z', recommendations: [rec] };
  docs.get('logs/client-A/mesos/plan-A').entries.progrec_1_0 = newer;
  docs.get('plans/plan-A').updatedAt = '2026-09-28T00:00:00.000Z';
  await context._recordShadowProgression('client-A', 'plan-A', 1, 0, newer);
  assert.equal(docs.get('logs/client-A/mesos/plan-A').progressionApplicationSummary.counts.STALE, 2);
  assert.equal(docs.get('logs/client-A').progressionApplicationSummary.autoCount, 0);
  context.USER = { uid: 'client-B' };
  assert.equal(await context._recordShadowProgression('client-A', 'plan-A', 1, 0, parent), false);
  context.USER = { uid: 'client-A' };
  const beforeLate = writes.length;
  context.FB.runTransaction = async (_db, fn) => fn({ ...tx,
    get: async ref => {
      const result = await tx.get(ref);
      if (ref === 'logs/client-A') context.USER = { uid: 'client-B' };
      return result;
    }
  });
  assert.equal(await context._recordShadowProgression('client-A', 'plan-A', 1, 0, newer), false);
  assert.equal(writes.length, beforeLate);
});

test('saveLogs merges existing application fields on both paths', async () => {
  const docs = new Map([
    ['logs/client-A/mesos/plan-A', { entries: { old_plan_set: true }, progressionApplications: { prior: { state: 'PENDING' } } }],
    ['logs/client-A', { entries: { old_plan_set: true }, progressionApplicationSummary: { autoCount: 1 } }]
  ]);
  const context = { USER: { uid: 'client-A' }, FB: { db: {}, doc: (_db, ...parts) => parts.join('/'),
      setDoc: async (ref, payload, opts) => {
        assert.equal(JSON.stringify(opts.mergeFields), JSON.stringify(Object.keys(payload)));
        docs.set(ref, { ...docs.get(ref), ...payload });
      } },
    LOGS: {}, REAL_WEEK: 1, ACTIVE_PLAN_ID: 'plan-A', EXERCISE_UNITS: {}, EXERCISE_HISTORY: {},
    _saveLogsTimer: null, _logsWriteInFlight: 0, _showSaveOk: () => {},
    document: { getElementById: () => null }, showToast: () => {}, console };
  vm.createContext(context);
  vm.runInContext(functionSource(client, '_doSaveLogs'), context);
  assert.equal(await context._doSaveLogs(), true);
  assert.equal(docs.get('logs/client-A/mesos/plan-A').progressionApplications.prior.state, 'PENDING');
  assert.equal(docs.get('logs/client-A').progressionApplicationSummary.autoCount, 1);
  assert.equal(JSON.stringify(docs.get('logs/client-A').entries), '{}');
  assert.equal(JSON.stringify(docs.get('logs/client-A/mesos/plan-A').entries), '{}');
});

test('Coach Monitor binds the existing deep link and requires exact PID for mutation context', () => {
  assert.match(coach, /_renderShadowAutoFeed\(autoSummary(, _dryRuns)?\)/);
  assert.match(coach, /_deepLinkToExercise\(item\.exerciseNameSnapshot, item\.prescriptionExerciseId, exposureDay\)/);
  assert.match(coach, /runTransaction\(db, async function\(tx\)/);
  assert.match(coach, /tx\.update\(clientRef, \{ coachInterventions: interventions \}\)/);
  const resolver = coach.slice(coach.indexOf('function _resolveExerciseRowId('), coach.indexOf('\n  window._resolveExerciseRowId', coach.indexOf('function _resolveExerciseRowId(')));
  const sandbox = {};
  vm.runInNewContext(resolver + '\nthis.resolve = _resolveExerciseRowId;', sandbox);
  assert.equal(sandbox.resolve('Remo', plan, 'pid-missing'), null);
  assert.equal(sandbox.resolve('Remo', plan, 'pid-A'), null); // duplicate PID across days is ambiguous
  assert.equal(sandbox.resolve('Remo', plan, 'pid-A', 2).di, 1);
  assert.equal(sandbox.resolve('Remo', { days: [plan.days[0]] }, 'pid-A').pid, 'pid-A');
});

test('the client PWA precaches its shadow contract dependency', () => {
  assert.match(client, /<script src="assets\/progression-auto-apply-shadow\.js"><\/script>/);
  assert.match(sw, /'\/assets\/progression-auto-apply-shadow\.js'/);
});

test('Coach keep/revert are atomic CAS decisions with intervention history and no plan writes', async () => {
  const parent = { calculatedAt: at, recommendations: [rec] };
  const pending = shadow.buildRecord(base, at);
  const docs = new Map([
    ['clients/client-A', { activePlanId: 'plan-A', coachId: 'coach-A', coachInterventions: [] }],
    ['plans/plan-A', structuredClone(plan)],
    ['logs/client-A/mesos/plan-A', { planId: 'plan-A', entries: { progrec_1_0: parent },
      progressionApplications: { [pending.key]: pending } }],
    ['logs/client-A', { planId: 'plan-A', progressionApplicationSummary: shadow.summarize({ [pending.key]: pending }, 'plan-A') }]
  ]);
  const writes = [];
  const tx = {
    get: async ref => ({ exists: () => docs.has(ref), data: () => structuredClone(docs.get(ref)) }),
    set: (ref, value) => { writes.push(ref); docs.set(ref, { ...docs.get(ref), ...structuredClone(value) }); },
    update: (ref, value) => { writes.push(ref); docs.set(ref, { ...docs.get(ref), ...structuredClone(value) }); }
  };
  const context = { _shadowMonitorContext: { clientId: 'client-A', planId: 'plan-A',
      items: [shadow.summarize({ [pending.key]: pending }, 'plan-A').items[0]] },
    _detailClientId: 'client-A', _detailClientData: { activePlanId: 'plan-A' },
    _detailPlanData: plan, _detailActiveTab: 'monitor', _shadowActionBusy: false,
    currentCoach: { uid: 'coach-A' }, window: { VDSEN_AUTO_APPLY_SHADOW: shadow },
    _buildCoachIntervention: input => ({ ...input, id: 'int-' + input.action }),
    showToast: () => {}, document: { getElementById: () => null },
    db: {}, doc: (_db, ...parts) => parts.join('/'),
    runTransaction: async (_db, fn) => fn(tx), console };
  vm.createContext(context);
  vm.runInContext(functionSource(coach, '_onShadowAutoAction'), context);
  const button = { disabled: false };
  await context._onShadowAutoAction('KEEP_ORIGINAL', pending.key, 1, button);
  let stored = docs.get('logs/client-A/mesos/plan-A').progressionApplications[pending.key];
  assert.equal(stored.state, 'REJECTED');
  assert.equal(stored.revision, 2);
  assert.equal(docs.get('logs/client-A').progressionApplicationSummary.autoCount, 0);
  assert.equal(docs.get('clients/client-A').coachInterventions.length, 1);
  assert.equal(docs.get('clients/client-A').coachInterventions[0].action, 'KEEP');
  const writtenBeforeRetry = writes.length;
  await context._onShadowAutoAction('KEEP_ORIGINAL', pending.key, 1, button);
  assert.equal(writes.length, writtenBeforeRetry);
  assert.equal(docs.get('clients/client-A').coachInterventions.length, 1);
  context._shadowMonitorContext.items = [shadow.summarize({ [pending.key]: stored }, 'plan-A').items[0]];
  await context._onShadowAutoAction('REVERT_DECISION', pending.key, 2, button);
  stored = docs.get('logs/client-A/mesos/plan-A').progressionApplications[pending.key];
  assert.equal(stored.state, 'PENDING');
  assert.equal(stored.revision, 3);
  assert.equal(docs.get('logs/client-A').progressionApplicationSummary.autoCount, 1);
  assert.equal(docs.get('clients/client-A').coachInterventions[1].action, 'NO_CHANGE');
  assert.deepEqual(docs.get('plans/plan-A'), plan);
  assert.ok(writes.every(ref => ref !== 'plans/plan-A'));
  context._shadowMonitorContext.items = [shadow.summarize({ [pending.key]: stored }, 'plan-A').items[0]];
  const beforeLate = writes.length;
  context.runTransaction = async (_db, fn) => fn({ ...tx,
    get: async ref => {
      const result = await tx.get(ref);
      if (ref === 'logs/client-A') context._detailClientId = 'client-B';
      return result;
    }
  });
  await context._onShadowAutoAction('KEEP_ORIGINAL', pending.key, 3, button);
  assert.equal(writes.length, beforeLate);
  context._detailClientId = 'client-A';
  context.runTransaction = async (_db, fn) => fn(tx);
  docs.get('clients/client-A').coachId = 'coach-B';
  await context._onShadowAutoAction('KEEP_ORIGINAL', pending.key, 3, button);
  assert.equal(writes.length, beforeLate); // another coach cannot mutate this client's audit
});

test('Monitor reconciliation persists an expired exposure as STALE without touching the plan', async () => {
  const parent = { calculatedAt: at, recommendations: [rec] };
  const pending = shadow.buildRecord(base, at);
  const docs = new Map([
    ['clients/client-A', { activePlanId: 'plan-A', coachId: 'coach-A', coachInterventions: [] }],
    ['plans/plan-A', structuredClone(plan)],
    ['logs/client-A/mesos/plan-A', { planId: 'plan-A', entries: { progrec_1_0: parent },
      progressionApplications: { [pending.key]: pending } }],
    ['logs/client-A', { planId: 'plan-A', progressionApplicationSummary: shadow.summarize({ [pending.key]: pending }, 'plan-A') }]
  ]);
  const writes = [];
  const tx = {
    get: async ref => ({ exists: () => docs.has(ref), data: () => structuredClone(docs.get(ref)) }),
    set: (ref, value) => { writes.push(ref); docs.set(ref, { ...docs.get(ref), ...structuredClone(value) }); }
  };
  const context = { window: { VDSEN_AUTO_APPLY_SHADOW: shadow }, _detailClientId: 'client-A',
    _detailActiveTab: 'monitor', currentCoach: { uid: 'coach-A' },
    db: {}, doc: (_db, ...parts) => parts.join('/'),
    runTransaction: async (_db, fn) => fn(tx) };
  vm.createContext(context);
  vm.runInContext(functionSource(coach, '_reconcileShadowAuto'), context);
  assert.equal((await context._reconcileShadowAuto('client-A', 'plan-A')).autoCount, 1);
  assert.equal(writes.length, 0);
  docs.get('logs/client-A/mesos/plan-A').entries.done_1_2 = { ts: 1 };
  const result = await context._reconcileShadowAuto('client-A', 'plan-A');
  assert.equal(result.autoCount, 0);
  assert.equal(result.counts.STALE, 1);
  assert.equal(docs.get('logs/client-A/mesos/plan-A').progressionApplications[pending.key].reasonCode, 'EXPOSURE_PASSED');
  assert.deepEqual(docs.get('logs/client-A').progressionApplicationSummary, result);
  assert.ok(writes.every(ref => ref !== 'plans/plan-A'));
  const kept = shadow.transition(pending, 'KEEP_ORIGINAL', 1, 'coach-keep', at, 'coach-A').record;
  docs.get('logs/client-A/mesos/plan-A').progressionApplications[pending.key] = kept;
  delete docs.get('logs/client-A/mesos/plan-A').entries.done_1_2;
  docs.get('clients/client-A').coachInterventions = [{ targetType: 'EXERCISE', targetId: 'pid-A',
    planId: 'plan-A', action: 'KEEP', decidedAt: '2026-09-27T12:01:00.000Z' }];
  const writesBefore = writes.length;
  assert.equal((await context._reconcileShadowAuto('client-A', 'plan-A')).counts.REJECTED, 1);
  assert.equal(writes.length, writesBefore); // its own KEEP intervention is not a stale signal
  docs.get('plans/plan-A').updatedAt = '2026-09-28T00:00:00.000Z';
  assert.equal((await context._reconcileShadowAuto('client-A', 'plan-A')).counts.STALE, 1);
});
