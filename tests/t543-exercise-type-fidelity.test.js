// T543: exercise-type fidelity. Canonical source: plan exercise `exerciseType` (fuerza | calistenia | cardio | estacion | circuito; absent = fuerza),
// documented in references/entrenamiento-funcional.md §10.10 and consumed by _getExType() / the specialized renderers.
// Path: plans/{id}.days[].exercises[].exerciseType -> loadPlan (ex object) -> PLAN.entrenamiento.sesiones[].exercises[] -> _EJERCICIOS_DIA -> _buildExCard dispatch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('vdsen-cliente.html', 'utf8');

function fn(name) {
  const i = html.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let d = 0, j = html.indexOf('{', i);
  for (let k = j; k < html.length; k++) { if (html[k] === '{') d++; else if (html[k] === '}' && --d === 0) return html.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
const ctx = {};
vm.createContext(ctx);
function load() { const m = html.match(/var _PERF_RX_FIELDS = \[[\s\S]*?\];/); assert.ok(m, '_PERF_RX_FIELDS'); vm.runInContext(m[0] + '\n' + fn('_getExType') + '\n' + fn('_carryPerfPrescription') + '\n' + fn('_carryPerfSetFields'), ctx); }

const TYPES = ['calistenia', 'cardio', 'estacion', 'circuito'];
const PERF = {
  calistenia: { rpeTarget: 8 },
  cardio: { modo: 'z2', duracionMin: 30, distanciaKm: 5, fcZonaMin: 120, fcZonaMax: 140, ritmoObjetivo: '6:00', repeticiones: 4, bloqueTrabajo: '4:00', bloqueDescanso: '3:00' },
  estacion: { dosis: 100, dosisUnit: 'm', tiempoObjetivoSeg: 90 },
  circuito: { estructura: 'AMRAP', roundsObjetivo: 5, timeCapMin: 12, movimientos: [{ nombre: 'Burpee', dosis: 10 }, 'Remo'] }
};

test('T543.1 the client honours exactly the repository enum and defaults to fuerza (no name inference)', () => {
  load();
  for (const t of TYPES) assert.equal(ctx._getExType({ exerciseType: t }), t);
  assert.equal(ctx._getExType({ exerciseType: 'CARDIO' }), 'cardio');
  assert.equal(ctx._getExType({}), 'fuerza');
  assert.equal(ctx._getExType({ exerciseType: 'fuerza' }), 'fuerza');
  assert.equal(ctx._getExType({ nombre: 'Dominadas', exerciseName: 'Caminadora cardio' }), 'fuerza', 'never inferred from the exercise name');
  assert.equal(ctx._getExType({ exerciseType: 'inventado' }), 'fuerza');
});

test('T543.2 loadPlan carries exerciseType and only the Coach prescription fields the renderers read', () => {
  load();
  for (const t of TYPES) {
    const src = Object.assign({ exerciseType: t, exerciseName: 'X', prescriptionExerciseId: 'pid-1', exerciseId: 'e-1', ignored: 'nope' }, PERF[t]);
    const out = ctx._carryPerfPrescription(src);
    assert.equal(out.exerciseType, t, t + ' type preserved');
    for (const [k, v] of Object.entries(PERF[t])) assert.deepEqual(out[k], v, t + ' keeps ' + k);
    assert.equal(out.ignored, undefined, 'whitelist only');
    for (const k of ['prescriptionExerciseId', 'exerciseId', 'sets', 'rirTarget', 'exerciseName']) assert.equal(out[k], undefined, k + ' is not touched by the type carrier');
  }
});

test('T543.3 strength / untyped exercises are unchanged (backward compatible)', () => {
  load();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._carryPerfPrescription({ exerciseName: 'Press', sets: [] }))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._carryPerfPrescription({ exerciseType: 'fuerza', modo: 'z2' }))), { exerciseType: 'fuerza' }, 'no performance fields leak onto a strength exercise');
});

test('T543.4 set-level Coach doses survive (estacion dosis, calistenia rpeTarget) without touching sets/reps/RIR', () => {
  load();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._carryPerfSetFields({ setIndex: 0, repsTarget: 10, rirTarget: 2, dosis: 50, rpeTarget: 8 }))), { dosis: 50, rpeTarget: 8 });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._carryPerfSetFields({ setIndex: 0, repsTarget: 10, rirTarget: 2 }))), {});
});

test('T543.5 loadPlan wires the carriers into the exercise and set mapping without renaming identity or prescription fields', () => {
  const lp = html.slice(html.indexOf('async function loadPlan(user)'), html.indexOf('\nfunction renderPlanRoto'));
  assert.ok(/_carryPerfPrescription\(e\)/.test(lp), 'exercise carrier');
  assert.ok(/_carryPerfSetFields\(s\)/.test(lp), 'set carrier');
  for (const keep of ['prescriptionExerciseId: e.prescriptionExerciseId || undefined', 'exerciseId: e.exerciseId || undefined', "rirTarget:  (s.rirTarget !== undefined && s.rirTarget !== null) ? s.rirTarget : rirTarget"])
    assert.ok(lp.includes(keep), keep);
});

test('T543.6 dispatch: every supported type reaches its own renderer', () => {
  const d = fn('_buildExCard').slice(0, 900);
  for (const [t, b] of [['calistenia', '_buildCalisteniaCard'], ['cardio', '_buildCardioCard'], ['estacion', '_buildEstacionCard'], ['circuito', '_buildCircuitoCard']])
    assert.ok(new RegExp("_ejType === '" + t + "'\\)\\s+return " + b + '\\(').test(d), t + ' -> ' + b);
});

test('T543.7 execution contracts: historical storage keys and shapes are unchanged; nothing prescribed becomes observed', () => {
  const shapes = {
    completeCalisteniaSet: ["exType:'calistenia'", 'reps:reps', 'lastre:lastre', 'asistencia:asistencia', 'rpe:rpe||null', 'ics:ics||null', 'done:true'],
    completeCardio: ["exType:'cardio'", 'duracionMin:', 'distanciaKm:', 'fcMedia:', 'fcMax:', 'ritmo:', 'rpe:', 'done:true'],
    completeEstacionSet: ["exType:'estacion'", 'dosis:dosis', 'dosisUnit:dosisUnit', 'tiempoSeg:tiempo', 'rpe:rpe||null', 'done:true'],
    completeCircuito: ["exType:'circuito'", 'estructura:', 'rounds:', 'tiempoTotalMin:', 'tiempoTotalSeg:', 'done:true']
  };
  for (const [f, needles] of Object.entries(shapes)) { const s = fn(f); for (const n of needles) assert.ok(s.includes(n), f + ' keeps ' + n); }
  for (const f of ['_buildCalisteniaCard', '_buildCardioCard', '_buildEstacionCard', '_buildCircuitoCard']) {
    const s = fn(f);
    assert.ok(/'log_'\+CURRENT_WEEK\+'_'\+di\+'_'\+ei/.test(s), f + ' logs under the historical log_{W}_{D}_{E} key');
    assert.ok(!/value="'\+(tDuracion|tDistancia|tRitmo|tRounds|dosis|repsTarget)/.test(s), f + ' never pre-fills an input from the prescription');
  }
  assert.ok(!/prescriptionExerciseId\s*[:=]/.test(fn('_saveExLog')), 'the shared log writer never touches identity');
});

test('T543.8 non-strength exercises stay out of strength-only lifecycle / progression capture', () => {
  assert.ok((html.match(/_getExType\(ej\) !== 'fuerza'/g) || []).length >= 2);
});

test('T543.9 performance cards keep every historical input id / handler and render in the V3 language (no emoji, no inline color state)', () => {
  const ids = { _buildCalisteniaCard: ['cal_reps_', 'cal_load_', 'cal_rpe_', 'cal_ics_', 'completeCalisteniaSet('], _buildCardioCard: ['card_dur_', 'card_dist_', 'card_fcm_', 'card_fcx_', 'card_pace_', 'card_rpe_', 'card_notes_', 'completeCardio('],
    _buildEstacionCard: ['est_dose_', 'est_time_', 'est_rpe_', 'completeEstacionSet(', 'saveEstacionWearable('], _buildCircuitoCard: ['cir_rds_', 'cir_time_', 'cir_rpe_', 'cir_notes_', 'completeCircuito('] };
  for (const [f, needles] of Object.entries(ids)) {
    const s = fn(f);
    for (const n of needles) assert.ok(s.includes(n), f + ' keeps ' + n);
    assert.ok(/<section class="pf" data-extype="/.test(s), f + ' uses the pf plate');
    assert.ok(/_perfSpec\(/.test(s) && /class="kick pf-reg">REGISTRO/.test(s), f + ' separates PRESCRIPCIÓN (spec plate) from REGISTRO');
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s.replace(/[✓≤±]/g, '')), f + ' has no emoji');
    assert.ok(!/style="[^"]*(background|color):/.test(s), f + ' has no inline color / background styling');
  }
  const shared = fn('_perfHeader') + fn('_perfSpec') + fn('_perfField') + fn('_perfCheck') + fn('_perfCta') + fn('_buildWearableBlock');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(shared.replace(/[✓≤±—]/g, '')));
  assert.ok(/aria-pressed/.test(fn('_perfCheck')) && /aria-label/.test(fn('_perfCheck')), 'set check buttons are named toggles');
  assert.ok(/aria-label="Prescripción del coach"/.test(fn('_perfSpec')));
});

test('T543.10 the type chip helper is neutral (label carries the type; no rainbow, no emoji)', () => {
  const s = fn('_exTypeChip');
  assert.ok(!/#[0-9a-fA-F]{3,6}/.test(s) && !/[\u{1F300}-\u{1FAFF}]/u.test(s));
  for (const l of ['CALISTENIA', 'CARDIO', 'ESTACIÓN', 'CIRCUITO']) assert.ok(s.includes(l));
});

test('T543.11 the Coach-authored technique detail container is geometry-safe', () => {
  for (const r of ['.tq-d img', 'max-width:100%', 'overflow-wrap:anywhere', '.tq-b{overflow:hidden}', 'position:static!important']) assert.ok(html.includes(r), r);
});
