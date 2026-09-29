// T484: legacy progression `reduce_sets` cannot change the operational/prescribed set count in the
// Client. The set-count region of the real _buildExCard source is executed for the behavioural cases.
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

function between(source, a, b) {
  const i = source.indexOf(a); assert.ok(i >= 0, a);
  const j = source.indexOf(b, i); assert.ok(j > i, b);
  return source.slice(i, j);
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
// Top-level function slice (up to the next column-0 function): robust to regex literals in bodies.
function topLevelFn(source, name) {
  let i = source.indexOf('\nasync function ' + name + '(');
  if (i < 0) i = source.indexOf('\nfunction ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  const rest = source.slice(i + 1);
  const m = /\n(async function|function) /.exec(rest.slice(10));
  return m ? rest.slice(0, m.index + 10) : rest;
}
const deepFreeze = o => { Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };

// Real set-count region of the workout card (PASO 1-3 + FST7 ceiling).
const region = between(client, '// ── Determinar numSeries: 3 pasos en orden', '// Para FST7: siempre exactamente 7 sets') +
  "if ((ej.technique || '').toLowerCase() === 'fst7') numSeries = Math.min(numSeries, (ej.sets || []).length || 7);";

function setCount({ planSets = 4, LOGS = {}, week = 2, progrec = null, ej, y3t = false, effective = [] }) {
  ej = ej || { prescriptionExerciseId: 'pid-A', sets: Array.from({ length: planSets }, (_, i) => ({ setIndex: i, repsTarget: 10, rirTarget: 2 })) };
  const context = { LOGS, CURRENT_WEEK: week, di: 0, ei: 0, ej, progrec, _isY3T: y3t, _effectiveSets: effective,
    numSeries: y3t ? effective.length : (ej.numSeries || ej.sets.length),
    // a recommendation-aware gate must not be reachable any more: it would throw if called
    _isFreshPidProgRec: () => { throw new Error('legacy gate consulted for set count'); } };
  vm.createContext(context);
  vm.runInContext(region + '\nthis.__n = numSeries; this.__done = _doneCount;', context);
  return { numSeries: context.__n, done: context.__done };
}
const reduce = (over = {}) => Object.assign({ prescriptionExerciseId: 'pid-A', action: 'reduce_sets', newSets: 2, newLoad: 80,
  calculatedAt: '2026-09-27T12:00:00.000Z', reason: 'Dolor muscular alto' }, over);

test('T484.1/2 a fresh reduce_sets does not reduce rendered working sets (fresh render and reload)', () => {
  assert.equal(setCount({ progrec: reduce() }).numSeries, 4);
  assert.equal(setCount({ progrec: reduce({ newSets: 1 }) }).numSeries, 4);
  assert.equal(setCount({ progrec: reduce(), week: 3 }).numSeries, 4, 'a later render / reload keeps the plan count');
  assert.equal(setCount({ progrec: null }).numSeries, 4);
});

test('T484.3/4/5 no plan mutation, no LOGS write, no omitted set marked complete/skipped', () => {
  const ej = deepFreeze({ prescriptionExerciseId: 'pid-A', sets: [0, 1, 2, 3].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, load: 100 })) });
  const LOGS = deepFreeze({ log_2_0_0_s0: { carga: '80', reps: '8', done: true } });
  const before = JSON.stringify(LOGS);
  assert.doesNotThrow(() => setCount({ ej, LOGS, progrec: reduce() }));
  assert.equal(ej.sets.length, 4); assert.equal(JSON.stringify(LOGS), before);
  assert.ok(!/LOGS\[[^\]]*\]\s*=|saveLogs\(|skipped|done\s*:/.test(region), 'the set-count region is read-only');
});

test('T484.6/7 executed sets restore and the remaining prescribed sets stay visible after resume', () => {
  const LOGS = { log_2_0_0_s0: { carga: '80', reps: '8', done: true }, log_2_0_0_s1: { carga: '80', reps: '8', done: true } };
  const r = setCount({ LOGS, progrec: reduce({ newSets: 2 }) });
  assert.equal(r.done, 2); assert.equal(r.numSeries, 4, 'sets 3 and 4 remain exposed');
  const all = { log_2_0_0_s0: { done: true }, log_2_0_0_s1: { done: true }, log_2_0_0_s2: { done: true } };
  assert.equal(setCount({ LOGS: all, progrec: reduce({ newSets: 1 }) }).numSeries, 4);
  const extra = Object.fromEntries([0, 1, 2, 3, 4].map(i => ['log_2_0_0_s' + i, { done: true }]));
  assert.equal(setCount({ LOGS: extra, progrec: reduce() }).numSeries, 5, 'never hides sets the athlete already logged');
});

test('T484.8/D an explicit Coach-authored 3-set plan renders 3 sets', () => {
  assert.equal(setCount({ planSets: 3, progrec: reduce({ newSets: 2 }) }).numSeries, 3);
  assert.equal(setCount({ planSets: 3, progrec: null }).numSeries, 3);
  assert.equal(setCount({ ej: { prescriptionExerciseId: 'p', numSeries: 5, sets: [{}, {}] }, progrec: reduce() }).numSeries, 5, 'explicit numSeries');
});

test('T484.9/10/11/12 other-PID, stale, old-plan and old-client recommendations have no effect', () => {
  const variants = [reduce({ prescriptionExerciseId: 'pid-B', exerciseName: 'Remo' }),
    reduce({ calculatedAt: '2020-01-01T00:00:00.000Z' }), reduce({ planId: 'plan-OLD' }), reduce({ clientId: 'client-OLD' })];
  for (const rec of variants) assert.equal(setCount({ progrec: rec }).numSeries, 4);
  assert.ok(!/_isFreshPidProgRec\(|\.newSets|\.action/.test(region), 'the set-count region never reads the recommendation');
});

test('T484 no code path outside the engine lets a recommendation set the set count', () => {
  const lines = client.split('\n'), hits = [];
  lines.forEach((l, i) => { if (/\.newSets\b/.test(l)) hits.push({ n: i + 1, l }); });
  assert.ok(hits.length >= 3, 'the informational display sites remain');
  for (const h of hits) assert.ok(!/\b(numSeries|numSets|setsCount|nSeries)\s*=[^=]/.test(h.l), 'newSets assigned at ' + h.n + ': ' + h.l.trim());
  assert.equal((client.match(/action === 'reduce_sets'/g) || []).length, 0);
  assert.equal(client.split('_isFreshPidProgRec(').length - 1, 1, 'the exact-PID freshness gate has no caller (definition only)');
  for (const fn of ['ssCompleteRound', 'ssCompleteLastRound', 'markExpressSSDone', 'buildBoostcampExercise', '_maybeSuggestExtraSet']) {
    const body = topLevelFn(client, fn);
    assert.ok(!/action === 'reduce_sets'|_pcRec|_isFreshPidProgRec\(/.test(body), fn + ' never consumes the legacy set recommendation');
  }
});

test('T484.13 superserie member/set topology is unchanged by legacy reduce_sets', () => {
  const planTopology = /var numSets = _ejIdx \? \(_ejIdx\.numSeries \|\| \(_ejIdx\.sets \? _ejIdx\.sets\.length : 3\)\) : 3;/;
  const ssLast = topLevelFn(client, 'ssCompleteLastRound'), express = topLevelFn(client, 'markExpressSSDone');
  assert.ok(planTopology.test(ssLast) && planTopology.test(express), 'both express writers use the plan topology');
  assert.equal((ssLast.match(/\bnumSets\s*=[^=]/g) || []).length, 1, 'ssCompleteLastRound: single numSets definition');
  assert.equal((express.match(/\bnumSets\s*=[^=]/g) || []).length, 1, 'markExpressSSDone: a single plan-topology definition');
  assert.ok(!/_pcRec|_getProgRecForExercise|action === 'reduce_sets'/.test(topLevelFn(client, 'ssCompleteRound')));
  assert.ok(client.includes("// T484: the set count is the plan's; a recommendation never changes how many sets are logged."));
});

test('T484.14 explicit safety mechanisms exist and never depend on the legacy recommendation', () => {
  for (const fn of ['skipSession', 'skipExercise', '_endSessionAsPartial', '_skipPresession', '_skipExerciseWithReason', '_skipSessionWithReason']) {
    const body = topLevelFn(client, fn);
    assert.ok(body.length > 40, fn + ' exists');
    assert.ok(!/reduce_sets|newSets|_getProgRecForExercise|_isFreshPidProgRec|record\.magnitude/.test(body), fn + ' is independent of progression recommendations');
  }
  const skip = topLevelFn(client, 'skipExercise');
  assert.ok(skip.includes("'exskip_'") && skip.includes("'PAIN'") && skip.includes('avisale a tu coach'), 'the explicit pain/injury skip still records exskip_ with its reason');
});

test('T484.15 the recommendation stays informational', () => {
  assert.ok(client.includes("reduce_sets:'#FF8844'") && client.includes("reduce_sets:'-SERIES'"), 'summary chip label remains');
  assert.ok(/reduce_sets:\s*\{ label: 'Revisar con Coach'/.test(client), 'review-with-Coach wording remains');
  assert.ok(client.includes("action = 'reduce_sets';"), 'the engine still emits the recommendation (unchanged)');
  assert.ok(client.includes("'💪 El algoritmo recomienda <strong>+1 serie</strong> la próxima semana. Tu coach actualizará el plan.'") ||
    client.includes('Tu coach actualizará el plan'), 'add_sets banner stays a Coach-facing signal');
});

test('T484.16/17/18/19 numeric apply disabled; Modulo D read-only; T482 and T483 neutralizations intact', () => {
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false); assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
  assert.ok(!('APPLIED' in shadow.STATES));
  assert.ok(!/updateDoc|setDoc|addDoc|getDoc|runTransaction/.test(functionSource(coach, '_applyAllModuloD')));
  assert.ok(!/updateDoc|setDoc|addDoc|getDoc|runTransaction/.test(functionSource(coach, '_applyRecLoadsToMonitor')));
  assert.ok(!coach.includes('applyRecLoadsBtn') && !coach.includes('_mon-apply-single'));
  assert.ok(!client.includes('_progCargaConv') && !client.includes('_progRepsApply') && !/_progM\b/.test(client));
  assert.ok(client.includes("var carga   = saved.carga   || '';") && client.includes("var reps    = saved.reps    || '';"));
});

test('T484.20 no new structural auto-apply path: no recommendation field feeds set topology or the plan', () => {
  const writers = client.split('\n').filter(l => /LOGS\[['"]exmod_|numSeries:\s*/.test(l) && /rec\b|progrec|newSets|recommend/.test(l));
  assert.deepEqual(writers, []);
  assert.ok(!/(updateDoc|setDoc)\([^)]*plans/.test(client));
  // other structural recommendation actions stay display-only
  for (const banner of ['addSetsBannerHtml', 'substHtml'])
    assert.ok(client.includes('var ' + banner), banner + ' is a rendered banner variable');
  assert.ok(!/numSeries\s*=\s*[^;\n]*(add_sets|substituteExercise)/.test(client));
});
