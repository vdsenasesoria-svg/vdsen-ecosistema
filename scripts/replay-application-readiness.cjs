#!/usr/bin/env node
// T514: deterministic SHADOW REPLAY of the canonical application chain over synthetic fixtures. No production data, no
// analytics infrastructure: it answers "when the flag is eventually enabled, WHY would candidates apply or not".
// Equipment configuration used here is SYNTHETIC (fixture-only) and never touches the shipped catalog.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const consumer = require(path.join(repo, 'assets/progression-application-consumer.js'));
const shadow = require(path.join(repo, 'assets/progression-auto-apply-shadow.js'));
const resolver = require(path.join(repo, 'assets/progression-equipment-resolver.js'));
const ctxMod = require(path.join(repo, 'assets/equipment-context.js'));
const catalog = require(path.join(repo, 'assets/exercise-visual-catalog.js'));

const PID = 'pid-replay', T0 = Date.parse('2026-09-27T12:00:00.000Z');
const DUMBBELL_EX = 'legacy-remo-mancuerna-unilateral';
const g = catalog.gyms['smart-fit-san-diego'];
const FAMILY_EX = 'legacy-press-inclinado-maquina'; // generic "Máquina" label: no canonical identity
const step = (o) => Object.assign({ kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' }, o);
const CFG_OK = { shared: { 'functional-dumbbells': step() }, gyms: {} };

function planFor(exerciseId) {
  return { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [
    { prescriptionExerciseId: PID, exerciseId, exerciseName: 'Fixture', sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 })) }] })) };
}
function entriesFor(spec, unit) {
  const e = {};
  spec.forEach(([w, d, over]) => [0, 1, 2].forEach(s => { e['log_' + w + '_' + d + '_0_s' + s] = Object.assign({ carga: '100', reps: '10', unit: unit || 'KG', done: true, rir: 2, rir_real: 2,
    prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }, s === 2 ? over : {}); }));
  return e;
}
const GOOD = [[1, 0, { rir_real: 3 }], [1, 2, { rir_real: 3 }]];

// name, evidence, extra {exercise, config, unit, ctx}
const SCENARIOS = [
  ['A-load ready (synthetic shared step)', GOOD, {}],
  ['A-load, equipment increment not configured', GOOD, { config: null }],
  ['A-load, equipment identity unresolved (generic label)', GOOD, { exercise: FAMILY_EX }],
  ['A-load, increment unit mismatch', GOOD, { unit: 'LB' }],
  ['A-load, grid step swallows the move', GOOD, { config: { shared: { 'functional-dumbbells': step({ step: 10 }) }, gyms: {} } }],
  ['A-load, above equipment maximum', GOOD, { config: { shared: { 'functional-dumbbells': step({ max: 100 }) }, gyms: {} } }],
  ['C rest ready, first occurrence (independent of equipment)', [[1, 0, {}], [1, 2, { reps: '8', rir_real: 2 }]], { config: null }],
  ['C persists at the next comparable exposure (Coach review)', [[1, 0, { reps: '8', rir_real: 2 }], [1, 2, { reps: '8', rir_real: 2 }]], {}],
  ['D+E: reps incomplete and effort harder (Coach review)', [[1, 0, { reps: '8', rir_real: 0 }], [1, 2, { reps: '8', rir_real: 0 }]], {}],
  ['D: effort harder than prescribed (Coach review)', [[1, 0, { reps: '10', rir_real: 0 }], [1, 2, { reps: '10', rir_real: 0 }]], {}],
  ['E: reps incomplete without RIR evidence (Coach review)', [[1, 0, { reps: '8', rir_real: '' }], [1, 2, { reps: '8', rir_real: '' }]], {}],
  ['Rule A with target RIR 0 (policy undefined by the source)', [[1, 0, { rir: 0, rir_real: 1 }], [1, 2, { rir: 0, rir_real: 1 }]], {}],
  ['single exposure only', [[1, 2, { rir_real: 3 }]], {}],
  ['direction unconfirmed by prior exposure', [[1, 0, { rir_real: 2 }], [1, 2, { rir_real: 3 }]], {}],
  ['direction conflicting across exposures', [[1, 0, { reps: '6', rir_real: 0 }], [1, 2, { rir_real: 3 }]], {}],
  ['safety conflict', GOOD, { ctx: { safetyConflict: true } }],
  ['Coach override after evidence', GOOD, { ctx: { interventions: [{ targetType: 'EXERCISE', targetId: PID, planId: 'p', decidedAt: '2026-09-27T14:00:00.000Z', action: 'CHANGE' }] } }],
  ['target exposure already started', GOOD, { started: true }]
];

function runScenario([name, spec, o]) {
  o = o || {};
  const exerciseId = o.exercise || DUMBBELL_EX, plan = planFor(exerciseId);
  const unit = o.unit || 'KG';
  const rec = shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: entriesFor(spec, unit), week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z',
    sourceMatches: true, sourcePidCount: 1, recommendation: { prescriptionExerciseId: PID, exerciseId, exerciseName: 'Fixture', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
  const config = o.config === undefined ? CFG_OK : o.config;
  const ref = ctxMod.equipmentRefForExercise({ catalog, exerciseId, config });
  const eqRes = resolver.resolveForCandidate({ magnitude: rec.magnitude, equipment: ref });
  const entries = Object.assign(entriesFor([[1, 0, {}], [1, 2, {}]], unit), o.started ? { log_2_0_0_s0: { carga: '100', done: true } } : {});
  const d = consumer.planApplication({ record: rec, context: Object.assign({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries, interventions: [],
    equipmentResolution: eqRes || undefined, existingOverlays: {}, now: '2026-09-28T00:00:00.000Z', resolveNextExposure: shadow.resolveNextExposure }, o.ctx || {}) });
  return { name, dimension: d.overlay ? d.overlay.dimension : (rec.magnitude.dimension || null), state: d.readiness.state, previewClass: d.readiness.preview.primary,
    blockers: d.blockers.filter(b => b !== 'NUMERIC_APPLY_DISABLED'), scienceGaps: d.audit.scienceGaps, appliedValue: d.overlay ? d.overlay.appliedValue : null };
}

const EQUIPMENT_CODES = ['EQUIPMENT_IDENTITY_UNRESOLVED', 'UNRESOLVED_EQUIPMENT_INCREMENT', 'UNIT_MISMATCH', 'DIRECTION_NOT_REALIZABLE', 'EQUIPMENT_OUT_OF_RANGE', 'EQUIPMENT_INPUT_INVALID', 'EQUIPMENT_RESOLUTION_MISMATCH'];
const SCIENCE_CODES = ['SCIENCE_POLICY_UNRESOLVED', 'MAGNITUDE_BRANCH_UNRESOLVED'];
const REVIEW_CODES = ['COACH_REVIEW_REQUIRED'];

function replay() {
  const rows = SCENARIOS.map(runScenario);
  const byReason = {};
  rows.forEach(r => r.blockers.forEach(b => { byReason[b] = (byReason[b] || 0) + 1; }));
  const count = (f) => rows.filter(f).length;
  return { rows, summary: { candidates: rows.length, readyButDisabled: count(r => r.state === 'READY_BUT_DISABLED'), blocked: count(r => r.state === 'BLOCKED'), coachReviewState: count(r => r.state === 'COACH_REVIEW_REQUIRED'),
    executable: count(r => r.state === 'EXECUTABLE'), blockersByReason: Object.fromEntries(Object.entries(byReason).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    byPreviewClass: rows.reduce((m, r) => { m[r.previewClass] = (m[r.previewClass] || 0) + 1; return m; }, {}),
    equipmentBlocked: count(r => r.blockers.some(b => EQUIPMENT_CODES.includes(b))), scienceBlocked: count(r => r.blockers.some(b => SCIENCE_CODES.includes(b))),
    coachReview: count(r => r.blockers.some(b => REVIEW_CODES.includes(b))) } };
}

function render(rp) {
  const s = rp.summary;
  const L = ['# Reproducción en sombra: preparación de aplicación (sintética)', '',
    'Generado por `node scripts/replay-application-readiness.cjs` sobre fixtures sintéticos deterministas (sin datos de producción; la configuración de equipo es de prueba y no toca el catálogo).',
    'Responde: cuando se active la bandera, ¿por qué se aplicaría o no cada candidato?', '',
    '- Candidatos: **' + s.candidates + '** · READY_BUT_DISABLED: **' + s.readyButDisabled + '** · REVISIÓN DEL COACH: **' + s.coachReviewState + '** · BLOCKED: **' + s.blocked + '** · EXECUTABLE: **' + s.executable + '**',
    '- Bloqueados por equipo: **' + s.equipmentBlocked + '** · revisión del Coach (política de producto D/E, C→E): **' + s.coachReview + '** · otra política/ciencia sin resolver: **' + s.scienceBlocked + '**', '',
    '## Clases de vista rápida', '', '| Clase | Candidatos |', '|---|---|'];
  Object.entries(s.byPreviewClass).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([k, v]) => L.push('| ' + k + ' | ' + v + ' |'));
  L.push('', '## Bloqueos por motivo', '', '| Motivo | Candidatos |', '|---|---|');
  Object.entries(s.blockersByReason).forEach(([k, v]) => L.push('| ' + k + ' | ' + v + ' |'));
  L.push('', '## Detalle', '', '| Escenario | Dimensión | Estado | Clase | Bloqueos | Ciencia |', '|---|---|---|---|---|---|');
  rp.rows.forEach(r => L.push('| ' + [r.name, r.dimension || '—', r.state, r.previewClass, r.blockers.join(', ') || '—', r.scienceGaps.join(', ') || '—'].join(' | ') + ' |'));
  L.push('');
  return L.join('\n');
}

module.exports = { replay, render, SCENARIOS, runScenario };
if (require.main === module) {
  const out = render(replay());
  const target = path.join(repo, 'docs', 'SHADOW_REPLAY_REPORT.md');
  if (process.argv.includes('--check')) process.exit(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === out ? 0 : 1);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(replay(), null, 2)); process.exit(0); }
  fs.writeFileSync(target, out); console.log('wrote docs/SHADOW_REPLAY_REPORT.md');
}
