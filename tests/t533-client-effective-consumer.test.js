// T533: the athlete app consumes the effective prescription (base + eligible overlay) behind the flag, presents it minimally, keeps executed LOGS
// separate, and may only ever perform APPLIED -> CONSUMED after the first PERSISTED working set. Shipped flag false => no behavior change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('./helpers/lifecycle-fixture.js');
const { makeStore } = require('./helpers/fake-firestore.js');
const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

function functionSource(source, name) {
  let start = source.indexOf('async function ' + name + '(');
  if (start < 0) start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let depth = 0, quote = null, escaped = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }   // T543: comments (apostrophes) must not flip quote state
    if (c === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Cannot extract ' + name);
}
const NAMES = ['_withOverlayRest', 'isY3TExercise_stub', '_lifecycleEnabled', '_captureLifecycleState', '_resolveOverlayForExercise', '_autoAdjustHtml', '_maybeConsumeOverlays'];

const LOGKEY = 'log_2_0_0_s0', FIRST = { carga: '100', reps: '10', unit: 'KG', done: true, rir_real: 2, prescriptionExerciseId: 'pid-1', ts: 5 };
function env({ flagOn = true, state = 'APPLIED', week = 2, persisted = false, localLogs = {} } = {}) {
  const modules = flagOn ? F.on : F.off;
  const sc = F.scenario(), a = F.applied(sc, { state });
  const meso = { planId: 'p', entries: Object.assign({}, sc.entries, persisted ? { [LOGKEY]: FIRST } : {}), progressionApplications: a.records, nextExposureOverlays: a.overlays };
  const store = makeStore({ 'logs/c/mesos/p': meso });
  let txCalls = 0;
  const context = { window: { VDSEN_EFFECTIVE_PRESCRIPTION: modules.effective, VDSEN_APPLICATION_CONSUMER: modules.consumer }, USER: { uid: 'c' }, ACTIVE_PLAN_ID: 'p', CURRENT_WEEK: week,
    LOGS: Object.assign({}, sc.entries, localLogs), LIFECYCLE_STATE: null, console, Date,
    FB: { db: {}, doc: (db, ...p) => p.join('/'), runTransaction: (db, fn) => { txCalls++; return store.run(fn); } } };
  vm.createContext(context);
  context.isY3TExercise = () => false; context.getExUnit = () => 'KG';
  NAMES.filter(n => !n.endsWith('_stub')).forEach(n => vm.runInContext(functionSource(client, n), context));
  vm.runInContext(functionSource(client, '_captureLifecycleState'), context);
  const snap = { exists: () => true, data: () => structuredClone(meso) };
  vm.runInContext('var __cap = function(){ _captureLifecycleState("c", "p", PLANDOC, { coachInterventions: [] }, SNAP); }', Object.assign(context, { PLANDOC: sc.plan, SNAP: snap }));
  context.__cap();
  return { context, store, sc, a, txCalls: () => txCalls, ej: { prescriptionExerciseId: 'pid-1', sets: F.baseSets() } };
}
const resolve = (e, unit = 'KG') => { const c = e.context; c.__ej = e.ej; return vm.runInContext('_resolveOverlayForExercise(__ej, 0, ' + JSON.stringify(unit) + ')', c); };

test('T533.1 shipped flag false: nothing is captured, nothing is resolved, nothing is rendered, nothing is consumed', async () => {
  const e = env({ flagOn: false }), st = e.context.LIFECYCLE_STATE;
  assert.deepEqual([Object.keys(st.records).length, Object.keys(st.overlays).length, st.planDoc], [0, 0, null]);
  assert.equal(resolve(e), null);
  e.context.LOGS[LOGKEY] = FIRST;
  await vm.runInContext('_maybeConsumeOverlays("c")', e.context);
  assert.equal(e.txCalls(), 0);
});

test('T533.2 flag-on sandbox: an APPLIED overlay for the exact PID/week/day becomes the effective prescription; base sets are untouched', () => {
  const e = env(), r = resolve(e);
  assert.equal(r.provenance, 'CANONICAL_OVERLAY'); assert.equal(r.dimension, 'LOAD');
  assert.ok(r.sets.every(s => s.effective.load === 102.5 && s.base.load === 0));
  assert.deepEqual(e.ej.sets, F.baseSets(), 'the plan exercise object is never mutated');
});

test('T533.3 wrong week / other exercise / other unit fall back to the base plan (no overlay)', () => {
  assert.equal(resolve(env({ week: 3 })), null);
  const e = env(); e.ej = { prescriptionExerciseId: 'other', sets: F.baseSets() }; assert.equal(resolve(e), null);
  assert.equal(resolve(env(), 'LB'), null);
});

test('T533.4 REVERTED / OVERRIDDEN / STALE overlays are never consumed; a CONSUMED one keeps being shown for its started exposure', () => {
  for (const state of ['REVERTED', 'OVERRIDDEN', 'STALE']) assert.equal(resolve(env({ state })), null, state);
  assert.equal(resolve(env({ state: 'CONSUMED' })).provenance, 'CANONICAL_OVERLAY');
});

test('T533.5 presentation is minimal: label + "previous -> applied unit"; no internals leak', () => {
  const e = env(), r = resolve(e); e.context.__x = { _overlay: r };
  const html = vm.runInContext('_autoAdjustHtml(__x)', e.context);
  assert.ok(html.includes('AUTOAJUSTE VDSEN') && html.includes('100 → 102.5 kg'));
  assert.ok(!/ovl_|v1_|pid-1|overlay|CANONICAL|equipment|revision|lifecycle/i.test(html.replace(/data-autoadjust/g, '')));
  e.context.__x = {}; assert.equal(vm.runInContext('_autoAdjustHtml(__x)', e.context), '');
});

test('T533.6 rendering never consumes: resolving/presenting many times performs zero transactions', () => {
  const e = env(); for (let i = 0; i < 5; i++) { resolve(e); }
  assert.equal(e.txCalls(), 0);
});

test('T533.7 the athlete only ACKNOWLEDGES: a persisted first set appends ONE receipt (never canonical state); local-only sets do nothing', async () => {
  const e = env({ localLogs: { [LOGKEY]: FIRST } });      // started on screen only (meso not written yet)
  await vm.runInContext('_maybeConsumeOverlays("c")', e.context);
  assert.equal(e.store.get('logs/c/mesos/p').consumptionReceipts, undefined, 'not persisted => no receipt');
  e.store.docs.get('logs/c/mesos/p').entries[LOGKEY] = FIRST;                     // now persisted
  await vm.runInContext('_maybeConsumeOverlays("c")', e.context);
  const m = e.store.get('logs/c/mesos/p'), rec = m.progressionApplications[e.sc.rec.key];
  assert.deepEqual(Object.keys(m.consumptionReceipts), [e.sc.rec.key]);
  assert.equal(m.consumptionReceipts[e.sc.rec.key].appliedValue, 102.5);
  assert.equal(rec.state, 'APPLIED', 'the athlete never moves canonical state (Firestore rules would deny it)');
  assert.deepEqual(e.store.log, ['logs/c/mesos/p'], 'the only document written is the meso document, receipt key only');
  const before = e.txCalls();
  await vm.runInContext('_maybeConsumeOverlays("c")', e.context);
  assert.equal(e.txCalls(), before, 'reload / next save does not create a second receipt');
  assert.equal(resolve(e).provenance, 'CANONICAL_OVERLAY', 'the started exposure keeps its effective prescription even before the Coach records CONSUMED');
});

test('T533.8 executed vs prescribed vs base stay separate: athlete enters 100 while the overlay says 102.5', async () => {
  const e = env({ persisted: true, localLogs: { [LOGKEY]: FIRST } });
  await vm.runInContext('_maybeConsumeOverlays("c")', e.context);
  const m = e.store.get('logs/c/mesos/p');
  assert.equal(m.entries[LOGKEY].carga, '100', 'LOGS keep the executed value');
  assert.equal(m.nextExposureOverlays['ovl_' + e.sc.rec.key].appliedValue, 102.5, 'overlay keeps the prescribed/effective value');
  assert.equal(m.consumptionReceipts[e.sc.rec.key].appliedValue, 102.5, 'the receipt records what was shown, not what was executed');
  assert.deepEqual(F.baseSets().map(s => s.load), [0, 0, 0], 'base plan values are a third, independent value');
  assert.equal(e.context.LOGS[LOGKEY].carga, '100', 'client LOGS untouched');
});

test('T533.9 a stale callback (user / plan changed mid-flight) never writes', async () => {
  const e = env({ persisted: true, localLogs: { [LOGKEY]: FIRST } });
  e.context.USER = { uid: 'other' };
  await vm.runInContext('_maybeConsumeOverlays("c")', e.context);
  assert.equal(e.txCalls(), 0);
  e.context.USER = { uid: 'c' }; e.context.ACTIVE_PLAN_ID = 'p2';
  await vm.runInContext('_maybeConsumeOverlays("c")', e.context);
  assert.equal(e.txCalls(), 0); assert.equal(e.store.log.length, 0);
});

test('T533.10 wiring: card uses the effective sets (not for substituted / Y3T exercises), keeps LOAD as an editable prefill, saves trigger the consume check', () => {
  const card = functionSource(client, '_buildExCard');
  assert.ok(/var _ovEff = \(_exSubData \|\| isY3TExercise\(ej\)\) \? null : _resolveOverlayForExercise\(ej, di, getExUnit\(di, ei\)\);/.test(card));
  assert.ok(card.indexOf('_ovEff = ') < card.indexOf('var nombre = ') && card.includes('_autoAdjustHtml(ej)') && card.includes("_ovEff.dimension === 'REPS'") && card.includes("_ovEff.dimension === 'LOAD'"));
  assert.ok(/_showSaveOk\(\);\s*try \{ _maybeConsumeOverlays\(_uidAtStart\); \} catch/.test(client), 'consume is checked only after a successful persisted save');
  assert.ok(/_captureLifecycleState\(user\.uid, activePlanId, planData, clientData, _mesoSnapPF\);/.test(client));
  for (const s of ['progression-effective-prescription.js', 'progression-application-consumer.js']) assert.ok(client.includes('assets/' + s) && sw.includes('/assets/' + s), s);
});

test('T533.11 the set-input region: overlay LOAD prefills set 1 only when nothing was saved; it never overwrites a saved value', () => {
  const a = client.indexOf('var _prefill = !saved.carga && !saved.reps;'), b = client.indexOf("var rirReal = saved.rir_real|| '';");
  const region = client.slice(a, b) + '\nthis.__out = { _histCargaConv: _histCargaConv, carga: carga };';
  const convert = functionSource(client, '_convertCarga') + functionSource(client, '_roundUnit');
  const run = (saved, ov) => { const c = { saved, s: 0, _progAutoApply: null, progrec: null, LOGS: {}, ej: { prescriptionExerciseId: 'pid-1', sets: [] }, prev: {}, histEx: { load: '95', unit: 'KG' }, unit: 'KG', di: 0, ei: 0, CURRENT_WEEK: 2,
    _isY3T: false, _effectiveSets: [], _ovEff: ov, Set }; vm.createContext(c); vm.runInContext(convert, c); vm.runInContext(region, c); return c.__out; };
  assert.equal(run({}, { dimension: 'LOAD', appliedValue: 102.5 })._histCargaConv, '102.5');
  assert.equal(run({}, null)._histCargaConv, '95', 'without an overlay the history prefill is unchanged');
  assert.equal(run({}, { dimension: 'REST', appliedValue: 120 })._histCargaConv, '95');
  assert.equal(run({ carga: '100', reps: '10' }, { dimension: 'LOAD', appliedValue: 102.5 }).carga, '100', 'saved execution wins');
});

test('T533.12 REST overlay reaches the rest timers (both completion paths); flag off / no overlay returns the very same exercise object', () => {
  const e = env({ persisted: false }), ov = F.applied(F.scenario({ prior: F.OK, latest: F.C9 }), { config: null });
  const c = e.context;
  // re-point the captured state at a REST overlay
  c.LIFECYCLE_STATE.records = ov.records; c.LIFECYCLE_STATE.overlays = ov.overlays;
  c.__ej = { prescriptionExerciseId: 'pid-1', sets: F.baseSets() };
  const w = vm.runInContext('_withOverlayRest(__ej, 0, 0)', c);
  assert.ok(w !== c.__ej && w.sets.every(s => s.restSeconds === 120) && c.__ej.sets.every(s => s.restSeconds === 90));
  const off = env({ flagOn: false }); off.context.__ej = off.ej;
  assert.equal(vm.runInContext('_withOverlayRest(__ej, 0, 0)', off.context), off.ej);
  assert.ok(/var _ejCur = _withOverlayRest\(\(_EJERCICIOS_DIA \|\| \[\]\)\[ei\] \|\| null, di, ei\);/.test(client) && (client.match(/_withOverlayRest\(/g) || []).length >= 3);
});
