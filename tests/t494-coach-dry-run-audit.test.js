// T494: the Coach AUTO item explains, read-only, what the canonical application layer WOULD do and what blocks it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));

function fn(name) {
  const st = coach.indexOf('  function ' + name + '('); assert.ok(st >= 0, name);
  let d = 0, q = null, e = false;
  for (let i = coach.indexOf('{', st); i < coach.length; i++) { const c = coach[i];
    if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; } if (c === '{') d++; if (c === '}' && --d === 0) return coach.slice(st, i + 1); }
}
const ctx = {}; vm.createContext(ctx);
const esc = coach.indexOf('  function _escH(s) {'); vm.runInContext(coach.slice(esc, coach.indexOf('\n  }\n', esc) + 4), ctx);
['_dryRunLine', '_shadowAuditLines', '_renderShadowMagnitude', '_renderShadowAutoFeed'].forEach(n => vm.runInContext(fn(n), ctx));

const PID = 'pid-A', T0 = Date.parse('2026-09-27T12:00:00.000Z');
const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [
  { prescriptionExerciseId: PID, exerciseName: 'Remo', sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 })) }] })) };
const entries = (last) => { const e = {}; [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { e['log_' + w + '_' + d + '_0_s' + s] =
  Object.assign({ carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }, s === 2 ? last : {}); })); return e; };
const record = (last) => shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: entries(last), week: 1, dayIndex: 2,
  calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
  recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Remo', action: 'increase_load', newLoad: 5 } }, '2026-09-27T13:00:00.000Z');
const dry = (rec, over = {}) => consumer.planApplication({ record: rec, context: Object.assign({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: entries({}),
  interventions: [], existingOverlays: null, resolveNextExposure: shadow.resolveNextExposure, now: 'n' }, over) });
const feed = (rec, decision) => ctx._renderShadowAutoFeed(shadow.summarize({ [rec.key]: rec }, 'p'), { [rec.key]: decision });

test('T494.1 a blocked candidate says why (unresolved equipment increment is the real state today)', () => {
  const rec = record({ rir_real: 3 });
  const html = feed(rec, dry(rec));
  assert.ok(html.includes('Simulación (dry-run): No se aplicaría: incremento del equipo sin definir'));
  assert.ok(!html.includes('aplicación numérica desactivada'), 'the global switch is not repeated as if it were the blocker');
});

test('T494.2 a would-be overlay shows target exposure, dimension and values, marked as simulation', () => {
  const rec = record({ rir_real: 3 });
  const resolution = resolver.resolveLoad({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG',
    equipment: { equipmentId: 'e1', gymId: 'g', loadIncrement: { kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' } } });
  const html = feed(rec, dry(rec, { equipmentResolution: resolution }));
  assert.ok(html.includes('Aplicaría en Sem 2 · Día 1: LOAD 100 → 102.5 (simulación, no activo)'));
});

test('T494.3 other blockers are explained in Spanish', () => {
  const rec = record({ rir_real: 3 });
  const cases = [[{ entries: Object.assign(entries({}), { log_2_0_0_s0: { done: true } }) }, 'la exposición destino ya empezó'],
    [{ interventions: [{ targetType: 'EXERCISE', targetId: PID, planId: 'p', action: 'KEEP', decidedAt: '2026-09-27T12:01:00.000Z' }] }, 'decisión del Coach posterior'],
    [{ plan: Object.assign({}, plan, { updatedAt: '2026-09-28T00:00:00.000Z' }) }, 'plan editado después de la evidencia'],
    [{ existingOverlays: { ['ovl_' + rec.key]: {} } }, 'ya registrado']];
  for (const [over, text] of cases) assert.ok(feed(rec, dry(rec, over)).includes(text), text);
  const unresolved = record({ rir_real: 1 });
  assert.ok(feed(unresolved, dry(unresolved)).includes('rama de política sin resolver'));
});

test('T494.4 non-PENDING items and items without a dry-run decision show no simulation', () => {
  const rec = record({ rir_real: 3 });
  const stale = shadow.markStale(rec, 'PLAN_CHANGED', 'x');
  assert.ok(!feed(stale, dry(stale)).includes('Simulación (dry-run)'));
  assert.ok(!ctx._renderShadowAutoFeed(shadow.summarize({ [rec.key]: rec }, 'p'), {}).includes('Simulación (dry-run)'));
  assert.ok(!ctx._renderShadowAutoFeed(shadow.summarize({ [rec.key]: rec }, 'p')).includes('Simulación (dry-run)'));
});

test('T494.5 the Monitor wiring is read-only: canonical full records only, no writes, consumer script loaded', () => {
  assert.ok(coach.includes('<script src="assets/progression-application-consumer.js"></script>'));
  const i = coach.indexOf('// T494: dry-run of the canonical application layer'), j = coach.indexOf('html += _renderShadowAutoFeed(autoSummary, _dryRuns);', i);
  assert.ok(i > 0 && j > i);
  const block = coach.slice(i, j);
  assert.ok(/planApplication\(\{ record: full,/.test(block));
  assert.ok(!/updateDoc|setDoc|addDoc|runTransaction|applyOverlayTransaction|tx\./.test(block));
  assert.ok(!/progrec|lastRec|newLoad|newReps/.test(block), 'never the legacy recommendation');
  for (const name of ['_dryRunLine', '_renderShadowAutoFeed']) assert.ok(!/updateDoc|setDoc|addDoc|runTransaction/.test(fn(name)), name);
  assert.equal(consumer.NUMERIC_APPLY_ENABLED, false);
});
