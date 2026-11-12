// T489: ONE canonical progression presentation in the Coach Monitor. The AUTO feed (canonical shadow
// records) is primary; the legacy engine signal is collapsed evidence, labelled "no aplicada".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const shadow = require(path.join(__dirname, '..', 'assets/progression-auto-apply-shadow.js'));
const policy = require(path.join(__dirname, '..', 'assets/progression-magnitude-policy.js'));
function fn(name) {
  const start = coach.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  let depth = 0, quote = null, escaped = false;
  for (let i = coach.indexOf('{', start); i < coach.length; i++) {
    const c = coach[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return coach.slice(start, i + 1);
  }
  throw new Error(name);
}
const ctx = {};
vm.createContext(ctx);
const esc = coach.indexOf('  function _escH(s) {');
vm.runInContext(coach.slice(esc, coach.indexOf('\n  }\n', esc) + 4), ctx);
vm.runInContext(coach.slice(coach.indexOf('  var _REVIEW_BRANCH = {'), coach.indexOf('  function _moduloDCanonicalView(')), ctx); // T523 review helpers
vm.runInContext(coach.slice(coach.indexOf('  var _LIFECYCLE_LABEL ='), coach.indexOf('  function _lifecycleLines(')), ctx);
['_lifecycleLines', '_shadowAuditLines', '_renderShadowMagnitude', '_renderShadowAutoFeed'].forEach(n => vm.runInContext(fn(n), ctx));

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const plan = { clientId: 'c', weeks: 6, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [
  { prescriptionExerciseId: 'pid-A', exerciseName: 'Remo', sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 })) }] })) };
function record(last, action = 'increase_load') {
  const entries = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => {
    entries['log_' + w + '_' + d + '_0_s' + s] = Object.assign({ carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2,
      prescriptionExerciseId: 'pid-A', ts: T0 + d * 1000 + s }, s === 2 ? last : {}); // both exposures show the same signal
  }));
  return shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries, week: 1, dayIndex: 2,
    calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
    recommendation: { prescriptionExerciseId: 'pid-A', exerciseId: 'e', exerciseName: 'Remo', action, newLoad: 82.5 } }, '2026-09-27T13:00:00.000Z');
}
const feed = records => ctx._renderShadowAutoFeed(shadow.summarize(Object.fromEntries(records.map(r => [r.key, r])), 'p'));

test('T489.1 the AUTO item shows exercise, PID, source and next exposure, state and the resolved candidate', () => {
  const html = feed([record({ rir_real: 3 })]);
  for (const t of ['Remo', 'PID pid-A', 'Origen: Sem 1 · Día 3 → próxima exposición: Sem 2 · Día 1', 'Candidato resuelto en shadow — no se aplica',
    'CANDIDATO SHADOW · NO APLICADO', 'Regla A · LOAD → 102.5 (carga cruda)', 'PENDIENTE'])
    assert.ok(html.includes(t), t);
});

test('T489.2 blocked/unresolved candidates state why', () => {
  assert.ok(feed([record({ rir_real: 1 })]).includes('Revisión del Coach requerida: Regla D'), 'T523: D is a Coach-review state, not an unresolved branch');
  const one = record({ rir_real: 3 }); one.magnitude = policy.evaluate({ clientId: 'c', planId: 'p', prescriptionExerciseId: 'pid-A', plan, exposures: [], prescription: { prescriptionExerciseId: 'pid-A', sets: [] } });
  assert.ok(feed([one]).includes('Bloqueado: evidencia insuficiente o fuera de rango'));
});

test('T489.3 Coach KEEP decision, STALE and REJECTED states are explicit and not actionable', () => {
  const kept = shadow.transition(record({ rir_real: 3 }), 'KEEP_ORIGINAL', 1, 'op', '2026-09-27T14:00:00.000Z', 'coach').record;
  const keptHtml = feed([kept]);
  assert.ok(keptHtml.includes('Decisión del Coach: mantener la prescripción original') && keptHtml.includes('Revertir decisión'));
  assert.ok(!keptHtml.includes('CANDIDATO SHADOW'));
  const stale = shadow.markStale(record({ rir_real: 3 }), 'PLAN_CHANGED', '2026-09-27T14:00:00.000Z');
  const staleHtml = feed([stale]);
  assert.ok(staleHtml.includes('Obsoleta (PLAN_CHANGED) — no es un candidato vigente') && !staleHtml.includes('CANDIDATO SHADOW'));
});

test('T489.4 the legacy engine signal appears only as non-applied evidence inside the AUTO item', () => {
  const html = feed([record({ rir_real: 3 }, 'reduce_load')]);
  assert.ok(html.includes('Señal legacy del motor: bajar carga (evidencia, no aplicada)'));
  assert.ok(html.includes('Regla A · LOAD → 102.5 (carga cruda)'), 'the canonical candidate, not the legacy direction, is the numeric proposal');
});

test('T489.5 the legacy Monitor recommendation blocks are collapsed evidence, not a second recommendation', () => {
  assert.ok(coach.includes('id="_legacyProgEvidence"') && coach.includes('referencia, no aplicada'));
  assert.ok(coach.includes('Evidencia del motor legacy (no aplicada)'));
  for (const gone of ['Progresión recomendada', 'El cliente NO la aplicará', 'Siguiente: <strong', '>Recomendaciones · Sem'])
    assert.ok(!coach.includes(gone), gone);
  assert.ok(coach.includes('Referencia legacy (no aplicada):'));
  // details opened by the legacy heading are closed
  const a = coach.indexOf('id="_legacyProgEvidence"'), b = coach.indexOf('} else if (!lastRec)', a);
  assert.ok(coach.slice(a, b).includes('html += `</details>`;'));
});

test('T489.6 no writes were added: the feed and audit helpers are display-only', () => {
  const src = fn('_shadowAuditLines') + fn('_renderShadowMagnitude') + fn('_renderShadowAutoFeed');
  assert.ok(!/updateDoc|setDoc|addDoc|runTransaction|getDoc/.test(src));
});
