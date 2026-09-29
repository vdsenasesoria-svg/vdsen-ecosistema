const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const at = '2026-09-27T12:00:00.000Z';
const rec = { prescriptionExerciseId: 'pid-A', exerciseId: 'ex-A', exerciseName: 'Remo',
  action: 'increase_load', newLoad: 52, newReps: 10 };
const parent = { calculatedAt: at, recommendations: [rec] };
const plan = { clientId: 'client-A', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [
  { dayIndex: 0, exercises: [{ prescriptionExerciseId: 'pid-A', exerciseId: 'ex-A', sets: [{ load: 50, repsTarget: 10 }] }] },
  { dayIndex: 2, exercises: [{ prescriptionExerciseId: 'pid-A', exerciseId: 'ex-A', sets: [{ load: 50, repsTarget: 10 }] }] }
] };

function functionSource(source, name) {
  let start = source.indexOf('async function ' + name + '(');
  if (start < 0) start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let depth = 0, quote = null, escaped = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Cannot extract ' + name);
}

function fixture(mesoSource = parent) {
  const docs = new Map([
    ['clients/client-A', { activePlanId: 'plan-A', coachId: 'coach-A', coachInterventions: [] }],
    ['plans/plan-A', structuredClone(plan)],
    ['logs/client-A/mesos/plan-A', { planId: 'plan-A', entries: { progrec_1_0: structuredClone(mesoSource) } }],
    ['logs/client-A', { planId: 'plan-A', entries: { progrec_1_0: structuredClone(parent) } }]
  ]);
  const tx = {
    get: async ref => ({ exists: () => docs.has(ref), data: () => structuredClone(docs.get(ref)) }),
    set: (ref, value) => docs.set(ref, { ...docs.get(ref), ...structuredClone(value) })
  };
  return { docs, tx };
}

function contextFor(f, storage, online = () => true) {
  const context = { window: { VDSEN_AUTO_APPLY_SHADOW: shadow }, USER: { uid: 'client-A' },
    ACTIVE_PLAN_ID: 'plan-A', FB: { db: {}, doc: (_db, ...parts) => parts.join('/'),
      getDoc: async ref => f.tx.get(ref),
      setDoc: async (ref, value) => {
        if (ref === 'logs/client-A/mesos/plan-A' && !online()) throw new Error('mirror unavailable');
        f.docs.set(ref, { ...f.docs.get(ref), ...structuredClone(value) });
      },
      runTransaction: async (_db, fn) => {
        if (!online()) throw new Error('unavailable');
        return fn(f.tx);
      } },
    localStorage: storage, LOGS: { progrec_1_0: parent }, REAL_WEEK: 1,
    EXERCISE_UNITS: {}, EXERCISE_HISTORY: {}, _saveLogsTimer: null,
    _logsWriteInFlight: 0, _showSaveOk: () => {},
    document: { getElementById: () => null }, showToast: () => {}, console };
  vm.createContext(context);
  const names = ['_doSaveLogs',
    '_getSessionCompletionState', '_sessionHasRealLoggedSets', '_getSessionLifecycleState',
    '_selectLogAuthority',
    'submitPostSession'];
  vm.runInContext(names.map(name => functionSource(client, name)).join('\n'), context);
  return context;
}

test('root listener adopts newer same-count entries instead of leaving LOGS stale', () => {
  const old = { calculatedAt: '2026-09-26T12:00:00.000Z', recommendations: [rec] };
  const f = fixture(old), map = new Map();
  const ctx = contextFor(f, { getItem: key => map.get(key) || null,
    setItem: (key, value) => map.set(key, value) });
  ctx.LOGS = { progrec_1_0: old };
  ctx._logsAuthorityUpdatedAt = 100;
  ctx._logsLastSeen = 0;
  ctx.CURRENT_WEEK = 1;
  ctx.user = { uid: 'client-A' };
  ctx._rebuildLogsByWeek = () => {};
  ctx.renderEntrenamiento = () => {};
  ctx.renderResumen = () => {};
  f.docs.get('logs/client-A').updatedAt = 200;
  const marker = client.indexOf('_liveUnsubLogs = FB.onSnapshot(FB.doc(FB.db, \'logs\', user.uid)');
  const start = client.indexOf('function(snap) {', marker);
  const end = client.indexOf('\n      });', start);
  assert.ok(marker >= 0 && start >= 0 && end > start);
  vm.runInContext('globalThis.rootListener = (' + client.slice(start, end + 8) + ')', ctx);
  ctx.rootListener({ exists: () => true, data: () => structuredClone(f.docs.get('logs/client-A')) });
  assert.equal(ctx.LOGS.progrec_1_0.calculatedAt, at);
});

test('OPEN focuses the exact row for a repeated PID on its resolved day', () => {
  const rows = [0, 2].map((day, di) => ({ id: 'exrow_' + di + '_0', style: {},
    scrollIntoView() {}, hasAttribute: () => false, focus() { this.focused = true; } }));
  const document = {
    getElementById: id => id === 'training-editor' ? { style: { display: 'block' } }
      : id === 'training-view' ? { style: { display: 'none' } }
      : rows.find(row => row.id === id) || null,
    querySelector: () => rows[0], querySelectorAll: () => []
  };
  const context = { window: {}, document, _activePlanCache: plan,
    _switchClientTab: () => {}, setTimeout: fn => fn() };
  vm.createContext(context);
  const resolver = coach.slice(coach.indexOf('function _resolveExerciseRowId('),
    coach.indexOf('window._resolveExerciseRowId = _resolveExerciseRowId;'));
  const deepLink = coach.slice(coach.indexOf('function _deepLinkToExercise('),
    coach.indexOf('window._deepLinkToExercise = _deepLinkToExercise;'));
  vm.runInContext(resolver + '\n' + deepLink, context);
  assert.equal(context._resolveExerciseRowId('Remo', plan, 'pid-A', 2).di, 1);
  context._deepLinkToExercise('Remo', 'pid-A', 2);
  assert.equal(rows[0].focused, undefined);
  assert.equal(rows[1].focused, true);
});
