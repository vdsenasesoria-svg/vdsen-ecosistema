// T479: audit of _selectLogAuthority (logs/{uid} vs logs/{uid}/mesos/{planId}) and its callers.
// Pure Firestore doubles; no network. Matrix B1-B14 from the Phase 1 pre-merge brief.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const ROOT = 'logs/client-A', MESO = 'logs/client-A/mesos/plan-A';
const at = '2026-09-27T12:00:00.000Z';
const oldAt = '2026-09-26T12:00:00.000Z';
const rec = { prescriptionExerciseId: 'pid-A', exerciseId: 'ex-A', exerciseName: 'Remo',
  action: 'increase_load', newLoad: 52, newReps: 10 };
const parent = { calculatedAt: at, recommendations: [rec] };
const oldParent = { calculatedAt: oldAt, recommendations: [rec] };
const plan = { clientId: 'client-A', weeks: 4, updatedAt: '2026-09-25T00:00:00.000Z', days: [
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

const select = (() => {
  const context = {};
  vm.createContext(context);
  ['_logDocHasEvidence', '_isLegacyUnboundLog', '_selectLogAuthority'].forEach(n => vm.runInContext(functionSource(client, n), context));
  return context._selectLogAuthority;
})();

const doc = (updatedAt, entries, extra) => Object.assign({ planId: 'plan-A', updatedAt, entries }, extra || {});
const done = key => ({ [key]: { ts: 1 } });

// ── Selector matrix ───────────────────────────────────────────────────────────
test('B1 equal clocks resolve deterministically to the mesocycle document', () => {
  const meso = doc(5, { log_1_0_0_s0: { carga: 50 } }), rootDoc = doc(5, { log_1_0_0_s0: { carga: 55 } });
  assert.equal(select(meso, rootDoc, 'plan-A'), meso);
  assert.equal(select(meso, rootDoc, 'plan-A'), select(meso, rootDoc, 'plan-A'));
  const same = doc(5, { a: 1 });
  assert.equal(select(same, structuredClone(same), 'plan-A'), same);
});

test('B2 root with newer execution wins', () => {
  const meso = doc(5, done('done_1_0')), rootDoc = doc(9, Object.assign(done('done_1_0'), done('done_1_1')));
  assert.equal(select(meso, rootDoc, 'plan-A'), rootDoc);
});

test('B3 meso with newer execution wins', () => {
  const meso = doc(9, Object.assign(done('done_1_0'), done('done_1_1'))), rootDoc = doc(5, done('done_1_0'));
  assert.equal(select(meso, rootDoc, 'plan-A'), meso);
});

test('B4 missing root leaves the mesocycle document', () => {
  const meso = doc(5, done('done_1_0'));
  assert.equal(select(meso, null, 'plan-A'), meso);
  assert.equal(select(meso, undefined, 'plan-A'), meso);
});

test('B5 missing meso leaves the root document; both missing is null', () => {
  const rootDoc = doc(5, done('done_1_0'));
  assert.equal(select(null, rootDoc, 'plan-A'), rootDoc);
  assert.equal(select(null, null, 'plan-A'), null);
});

test('B6 invalid or missing clocks give a deterministic result', () => {
  const entries = { log_1_0_0_s0: { carga: 50 } };
  for (const bad of [undefined, null, 'garbage', NaN, {}, '']) {
    const meso = doc(bad, entries), rootDoc = doc(7, entries);
    assert.equal(select(meso, rootDoc, 'plan-A'), rootDoc, 'invalid meso clock is oldest: ' + String(bad));
    const meso2 = doc(7, entries), root2 = doc(bad, entries);
    assert.equal(select(meso2, root2, 'plan-A'), meso2, 'invalid root clock is oldest: ' + String(bad));
    assert.equal(select(doc(bad, entries), doc(bad, entries), 'plan-A').planId, 'plan-A');
  }
  const a = doc(undefined, entries), b = doc(undefined, entries);
  assert.equal(select(a, b, 'plan-A'), a, 'both invalid → meso');
});

test('B7 a root clock bumped without execution changes cannot regress newer meso evidence', () => {
  // meso saved session 1_1; the root mirror write failed. A root-only bump (Coach week change,
  // or any metadata write) then made root.updatedAt newer while its entries stay older.
  const meso = doc(10, Object.assign(done('done_1_0'), done('done_1_1')));
  const rootDoc = doc(15, done('done_1_0'), { currentWeek: 2 });
  assert.equal(select(meso, rootDoc, 'plan-A'), meso);
});

test('B8 a meso clock bumped without execution changes cannot regress newer root evidence', () => {
  const meso = doc(20, done('done_1_0'), { progressionApplicationSummary: { autoCount: 1 } });
  const rootDoc = doc(10, Object.assign(done('done_1_0'), done('done_1_1')));
  assert.equal(select(meso, rootDoc, 'plan-A'), rootDoc);
});

test('B13 completed-session evidence cannot be replaced by an older mirror, whatever its clock', () => {
  const rootDoc = doc(5, { done_1_0: { ts: 1 }, log_1_0_0_s0: { carga: 50 } });
  const staleMirror = doc(99, { log_1_0_0_s0: { carga: 50 } });
  assert.equal(select(staleMirror, rootDoc, 'plan-A'), rootDoc);
  assert.equal(select(rootDoc, staleMirror, 'plan-A'), rootDoc, 'argument roles do not matter');
  // Non-dominating evidence (each side has a session the other lacks): the clock decides.
  const left = doc(5, done('done_1_0')), right = doc(9, done('done_1_1'));
  assert.equal(select(left, right, 'plan-A'), right);
  assert.equal(select(right, left, 'plan-A'), right);
});

test('B14 same-millisecond writes stay deterministic and never lose completed sessions', () => {
  const meso = doc(50, done('done_1_0'));
  const rootDoc = doc(50, Object.assign(done('done_1_0'), done('done_1_1')));
  assert.equal(select(meso, rootDoc, 'plan-A'), rootDoc, 'tie broken by evidence, not by document order');
  assert.equal(select(rootDoc, meso, 'plan-A'), rootDoc);
  const equal = doc(50, done('done_1_0'));
  assert.equal(select(equal, doc(50, done('done_1_0')), 'plan-A'), equal, 'true tie → meso');
});

test('plan isolation: a document of another plan never wins', () => {
  const meso = doc(5, done('done_1_0')), other = Object.assign(doc(99, Object.assign(done('done_1_0'), done('done_1_1'))), { planId: 'plan-B' });
  assert.equal(select(meso, other, 'plan-A'), meso);
  assert.equal(select(other, doc(1, {}), 'plan-A').planId, 'plan-A');
});

// ── Writers: which clock does each one touch? ─────────────────────────────────
function fixture(opts = {}) {
  const docs = new Map([
    ['clients/client-A', { activePlanId: 'plan-A', coachId: 'coach-A', coachInterventions: [] }],
    ['plans/plan-A', structuredClone(plan)],
    [MESO, { planId: 'plan-A', updatedAt: 10, entries: Object.assign({ progrec_1_0: structuredClone(opts.mesoParent || parent) }, opts.mesoEntries || {}) }],
    [ROOT, { planId: 'plan-A', updatedAt: 10, entries: Object.assign({ progrec_1_0: structuredClone(opts.rootParent || parent) }, opts.rootEntries || {}) }]
  ]);
  const tx = {
    get: async ref => ({ exists: () => docs.has(ref), data: () => structuredClone(docs.get(ref)) }),
    set: (ref, value) => docs.set(ref, { ...docs.get(ref), ...structuredClone(value) })
  };
  return { docs, tx, writes: [] };
}

function fakeDate(now) {
  const D = function() { return new Date(...arguments); };
  D.now = now; D.parse = Date.parse; D.UTC = Date.UTC; D.prototype = Date.prototype;
  return D;
}

function contextFor(f, { now = () => 1000, failMeso = () => false, failRoot = () => false, storage } = {}) {
  const map = new Map();
  const store = storage || { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value),
    removeItem: key => map.delete(key) };
  const context = { window: { VDSEN_AUTO_APPLY_SHADOW: shadow }, USER: { uid: 'client-A' },
    ACTIVE_PLAN_ID: 'plan-A', Date: fakeDate(now),
    FB: { db: {}, doc: (_db, ...parts) => parts.join('/'),
      getDoc: async ref => f.tx.get(ref),
      setDoc: async (ref, value) => {
        if (ref === MESO && failMeso()) throw new Error('mirror unavailable');
        if (ref === ROOT && failRoot()) throw new Error('root unavailable');
        f.writes.push(ref);
        f.docs.set(ref, { ...f.docs.get(ref), ...structuredClone(value) });
      },
      runTransaction: async (_db, fn) => fn(f.tx) },
    localStorage: store, LOGS: {}, REAL_WEEK: 1, EXERCISE_UNITS: {}, EXERCISE_HISTORY: {},
    _saveLogsTimer: null, _logsWriteInFlight: 0, _showSaveOk: () => {},
    document: { getElementById: () => null }, showToast: () => {}, console };
  vm.createContext(context);
  ['_doSaveLogs', '_recordShadowProgression', '_readShadowQueue', '_writeShadowQueue',
    '_queueShadowProgression', '_drainShadowProgression', '_getSessionCompletionState',
    '_sessionHasRealLoggedSets', '_getSessionLifecycleState', '_logDocHasEvidence', '_isLegacyUnboundLog', '_selectLogAuthority']
    .forEach(name => vm.runInContext(functionSource(client, name), context));
  return context;
}

test('listener and refresh callers compare against the local executed entries, not only a clock', () => {
  const stub = /_selectLogAuthority\(\{ planId: ACTIVE_PLAN_ID, updatedAt: _logsAuthorityUpdatedAt, entries: LOGS \}/g;
  assert.equal((client.match(stub) || []).length, 2, 'both stale-callback callers include local LOGS');
  assert.ok(client.includes('var logData = _selectLogAuthority('), 'load path reads both real documents');
});

