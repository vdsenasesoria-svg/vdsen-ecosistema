// T483: legacy progression recommendations (progrec newLoad/newReps) cannot become operational
// load/reps in the Client while canonical numeric auto-apply is disabled. Executed regions come
// from the real vdsen-cliente.html source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));

function between(source, startMarker, endMarker) {
  const a = source.indexOf(startMarker);
  assert.ok(a >= 0, 'start marker: ' + startMarker);
  const b = source.indexOf(endMarker, a);
  assert.ok(b > a, 'end marker: ' + endMarker);
  return source.slice(a, b);
}
function functionSource(source, name) {
  let start = source.indexOf('async function ' + name + '(');
  if (start < 0) start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let depth = 0, quote = null, escaped = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Cannot extract ' + name);
}

// The per-set input-default region of the workout card (real source).
const cardRegion = between(client, 'var _prefill = !saved.carga && !saved.reps;', "var rirReal = saved.rir_real|| '';");
const convert = functionSource(client, '_convertCarga') + functionSource(client, '_roundUnit');
const deepFreeze = o => { Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };

// Runs the real region for one set. `progrec` is a (possibly fresh, PID-verified) recommendation.
function inputDefaults({ saved = {}, s = 0, progrec = null, LOGS = {}, ej, prev = {}, histEx = {}, unit = 'KG' }) {
  ej = ej || { prescriptionExerciseId: 'pid-A', sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 2, load: 100 }] };
  const _progAutoApply = progrec && progrec.prescriptionExerciseId === ej.prescriptionExerciseId ? progrec : null;
  const context = { saved, s, _progAutoApply, progrec, LOGS, ej, prev, histEx, unit, di: 0, ei: 0, CURRENT_WEEK: 2,
    _isY3T: false, _effectiveSets: [], _ovEff: null, Set };
  vm.createContext(context);
  vm.runInContext(convert, context);
  vm.runInContext(cardRegion + '\nthis.__out = { carga: carga, reps: reps, _prevSesCarga: _prevSesCarga, _prevSesReps: _prevSesReps, _hasPrevSes: _hasPrevSes };', context);
  return context.__out;
}
const fresh = (over = {}) => Object.assign({ prescriptionExerciseId: 'pid-A', action: 'increase_load', newLoad: 82.5, newReps: 10,
  calculatedAt: '2026-09-27T12:00:00.000Z', rirTarget: 2 }, over);

test('T483.1/2 a fresh legacy newLoad/newReps does not prefill the next exposure', () => {
  for (const action of ['increase_load', 'reduce_load', 'maintain', 'deload', 'freeze_load']) {
    const out = inputDefaults({ progrec: fresh({ action }) });
    assert.equal(out.carga, '', action); assert.equal(out.reps, '', action);
  }
  assert.equal(inputDefaults({ progrec: fresh({ newLoad: 'not-a-number', newReps: 'x' }) }).carga, '');
  assert.ok(!client.includes('_progCargaConv') && !client.includes('_progRepsApply'));
});

test('T483.3 (T500) legacy recommendations are no longer presented to the athlete', () => {
  assert.ok(!client.includes('var headerRec = _getProgRecForExercise'));
  assert.ok(client.includes('function _buildSetReferenceHtml(prev, histEx'));
  assert.ok(!/Referencia: '\+progrec\.newLoad/.test(client));
});

test('T483.4/5 plan-authored load and reps are untouched and remain the reference targets', () => {
  const ej = deepFreeze({ prescriptionExerciseId: 'pid-A', sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 2, load: 100 },
    { setIndex: 1, repsTarget: 8, rirTarget: 1, load: 100 }] });
  assert.doesNotThrow(() => inputDefaults({ ej, progrec: fresh() }));
  assert.equal(ej.sets[0].load, 100); assert.equal(ej.sets[0].repsTarget, 10); assert.equal(ej.sets[1].repsTarget, 8);
  assert.ok(client.includes('function _warmupReferenceLoad(prevWeekData, historyEntry, planSet)') &&
    /var plan = planSet \? parseFloat\(planSet\.load\) : 0;/.test(client), 'plan-authored load stays a warm-up base (T485)');
});

test('T483.6/7/8 executed LOGS and manual athlete entries restore on resume/reload', () => {
  const saved = { carga: '80', reps: '8', unit: 'KG', done: true, rir_real: 2 };
  for (const progrec of [null, fresh(), fresh({ newLoad: 90, newReps: 12 })]) {
    const out = inputDefaults({ saved, progrec });
    assert.equal(out.carga, '80'); assert.equal(out.reps, '8');
  }
  assert.equal(inputDefaults({ saved: { carga: '77.5' }, progrec: fresh() }).carga, '77.5', 'manual load only');
  assert.equal(inputDefaults({ saved: { reps: '11' }, progrec: fresh() }).reps, '11', 'manual reps only');
  assert.equal(inputDefaults({ saved: { carga: '0', reps: '9' }, progrec: fresh() }).reps, '9');
});

test('T483.9 legitimate in-session copy from the previous set remains functional', () => {
  const LOGS = { log_2_0_0_s0: { carga: '80', reps: '8', unit: 'KG', done: true, rir_real: 2, ics: 8, pump: 1 } };
  const out = inputDefaults({ s: 1, LOGS, progrec: fresh() });
  assert.equal(out._hasPrevSes, true);
  assert.equal(out._prevSesCarga, '80'); assert.equal(out._prevSesReps, '8');
  assert.equal(out.carga, '', 'copy is offered by the helper, never taken from the recommendation');
  assert.ok(client.includes("var _prevSesKey  = s > 0 ? 'log_'+CURRENT_WEEK+'_'+di+'_'+ei+'_s'+(s-1) : null;"));
});

test('T483.10/11/12 no LOGS write, no plan mutation, no operational autoFilled from a recommendation', () => {
  const LOGS = deepFreeze({ log_2_0_0_s0: { carga: '80', reps: '8', done: true } });
  const before = JSON.stringify(LOGS);
  assert.doesNotThrow(() => inputDefaults({ LOGS, progrec: fresh() }));
  assert.equal(JSON.stringify(LOGS), before);
  assert.ok(!/LOGS\[[^\]]*\]\s*=|saveLogs\(|autoFilled|showToast|await /.test(cardRegion), 'render region is read-only and never flags autoFilled');
  assert.ok(!/autoFilled\s*:\s*true/.test(functionSource(client, '_getProgRecForExercise')));
});

test('T483.13 same-name/different-PID cannot affect another exercise', () => {
  const other = fresh({ prescriptionExerciseId: 'pid-B', exerciseName: 'Remo' });
  const ej = { prescriptionExerciseId: 'pid-A', exerciseName: 'Remo', sets: [{ repsTarget: 10 }] };
  assert.equal(inputDefaults({ ej, progrec: other }).carga, '');
  assert.equal(inputDefaults({ ej, progrec: fresh() }).carga, '', 'even the exact-PID recommendation does not prefill');
  assert.ok(!client.includes('_isFreshPidProgRec') && !client.includes('_progAutoApply'), 'the legacy gate is removed (T487); identity and stale checks live in the canonical shadow layer');
});

test('T483.14/15/16 stale, old-plan and old-client recommendations have no operational effect', () => {
  const stale = fresh({ calculatedAt: '2020-01-01T00:00:00.000Z' });
  const oldPlan = fresh({ planId: 'plan-OLD' });
  const oldClient = fresh({ clientId: 'client-OLD' });
  for (const rec of [stale, oldPlan, oldClient])
    assert.deepEqual([inputDefaults({ progrec: rec }).carga, inputDefaults({ progrec: rec }).reps], ['', '']);
  assert.ok(!/await |FB\.|USER/.test(cardRegion), 'no async callback can reach the operational inputs');
});

test('T483 superset-member prefill no longer reads a name/position-matched recommendation', () => {
  const region = between(client, "var _prevM = LOGS['log_'+(CURRENT_WEEK-1)+'_'+di+'_'+curIdx+'_s0'] || {};", '// Pre-rellenar con datos de la ronda anterior');
  assert.ok(!/_getProgRecForExercise|newLoad|newReps|_progM/.test(region));
  assert.ok(/_prevM\.carga/.test(region) && /_histM\.load/.test(region), 'athlete history sources remain');
});

test('T483.17/18 numeric apply disabled; no APPLIED state', () => {
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false); assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
  assert.ok(!('APPLIED' in policy.REASONS)); assert.equal(shadow.lifecycleTransition({ state: 'PENDING', revision: 1, events: [] }, 'APPLIED', { expectedRevision: 1, operationKey: 'x', at: 't' }).reasonCode, 'NUMERIC_APPLY_DISABLED');
  assert.deepEqual(shadow.attemptNumericApply(), { ok: false, reasonCode: 'MAGNITUDE_POLICY_MISSING', applied: false });
});

test('T483.19/20 Modulo D read-only and the T482 plan-writer neutralization remain intact', () => {
  assert.ok(!coach.includes('_applyAllModuloD') && !coach.includes('_applyRecLoadsToMonitor'), 'plan-writer stubs removed (T487)');
  assert.ok(!coach.includes('applyRecLoadsBtn') && !coach.includes('_mon-apply-single'));
});

test('Phase 8: remaining client consumers of progrec numerics are informational, never input defaults', () => {
  const lines = client.split('\n');
  const hits = [];
  lines.forEach((line, i) => { if (/\.newLoad|\.newReps|recommendedLoad/.test(line)) hits.push({ n: i + 1, line }); });
  assert.ok(hits.length >= 1, 'scan sees the remaining engine-internal consumers');
  // classification of every consumer by enclosing rendering/engine context: display, warm-up
  // reference, hint banner, reference block or engine internals — none writes an input value.
  const inputWriters = hits.filter(h => /_pfCM|_pfRM|getElementById\([^)]*\)\.value|\.value\s*=/.test(h.line));
  assert.deepEqual(inputWriters, []);
});
