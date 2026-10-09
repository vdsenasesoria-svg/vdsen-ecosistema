// T518: (a) provenance on authored increments, (b) safe bulk export/import (preview, all-or-nothing, no fabricated numbers),
// (c) change-impact preview from local data only. Uses the existing coach document; no new collection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));
const C = require(path.join(root, 'assets/equipment-context.js'));
const R = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const NOW = '2026-09-30T10:00:00.000Z', GYM = 'smart-fit-san-diego', DB = 'functional-dumbbells', BB = 'functional-olympic-barbell';
const step = (n, o) => Object.assign({ kind: 'STEP', step: n, unit: 'KG', source: 'COACH_CONFIGURED' }, o);
const parse = (text, config) => C.parseImport(text, { catalog, config: config || null, now: NOW, uid: 'coach-1' });

// ---------------- provenance
test('T518.1 authored increments carry scope / configuredAt / configuredBy / revision', () => {
  let cfg = C.setEquipmentIncrement(null, { scope: 'SHARED', equipmentId: DB, meta: step(2.5), provenance: { now: NOW, uid: 'coach-1' } });
  assert.deepEqual([cfg.shared[DB].scope, cfg.shared[DB].configuredAt, cfg.shared[DB].configuredBy, cfg.shared[DB].revision, cfg.shared[DB].source], ['SHARED_EQUIPMENT', NOW, 'coach-1', 1, 'COACH_CONFIGURED']);
  cfg = C.setEquipmentIncrement(cfg, { scope: 'GYM', gymId: GYM, equipmentId: DB, meta: step(1.25), provenance: { now: NOW, uid: 'coach-1' } });
  assert.equal(cfg.gyms[GYM][DB].scope, 'GYM_EQUIPMENT');
});

test('T518.2 changed values bump the revision; identical re-saves keep provenance; no uid -> no configuredBy', () => {
  let cfg = C.setEquipmentIncrement(null, { scope: 'SHARED', equipmentId: DB, meta: step(2.5), provenance: { now: NOW, uid: 'u' } });
  const same = C.setEquipmentIncrement(cfg, { scope: 'SHARED', equipmentId: DB, meta: step(2.5), provenance: { now: '2027-01-01T00:00:00.000Z', uid: 'other' } });
  assert.deepEqual(same.shared[DB], cfg.shared[DB], 'identical values do not create a phantom revision');
  const changed = C.setEquipmentIncrement(cfg, { scope: 'SHARED', equipmentId: DB, meta: step(5), provenance: { now: '2026-10-01T00:00:00.000Z' } });
  assert.deepEqual([changed.shared[DB].revision, changed.shared[DB].configuredAt, 'configuredBy' in changed.shared[DB]], [2, '2026-10-01T00:00:00.000Z', false]);
});

test('T518.3 provenance fields never break validation or resolution', () => {
  const cfg = C.setEquipmentIncrement(null, { scope: 'SHARED', equipmentId: DB, meta: step(2.5), provenance: { now: NOW, uid: 'u' } });
  const ref = C.equipmentRefForExercise({ catalog, exerciseId: 'legacy-goblet-squat', config: cfg });
  const r = R.resolveLoad({ currentLoad: 20, desiredLoad: 22.5, direction: 'UP', unit: 'KG', equipment: ref });
  assert.deepEqual([r.resolutionState, r.incrementRevision, r.incrementConfiguredAt, r.incrementKind], ['RESOLVED', 1, NOW, 'STEP']);
});

const PID = 'pid-r', EXID = 'legacy-remo-mancuerna-unilateral', T0 = Date.parse('2026-09-27T12:00:00.000Z');
const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [
  { prescriptionExerciseId: PID, exerciseId: EXID, exerciseName: 'Remo', sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 })) }] })) };
const entries = {}; [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { entries['log_' + w + '_' + d + '_0_s' + s] = { carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 3, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }; }));
const record = () => shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries, week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
  recommendation: { prescriptionExerciseId: PID, exerciseId: EXID, exerciseName: 'Remo', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
const plan1 = (rec, cfg) => consumer.planApplication({ record: rec, context: { clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries, interventions: [],
  equipmentResolution: R.resolveForCandidate({ magnitude: rec.magnitude, equipment: C.equipmentRefForExercise({ catalog, exerciseId: EXID, config: cfg }) }), existingOverlays: {}, now: '2026-09-28T00:00:00.000Z', resolveNextExposure: shadow.resolveNextExposure } });

test('T518.4 the overlay SNAPSHOTS the increment it used; later config changes cannot alter it', () => {
  const cfg1 = C.setEquipmentIncrement(null, { scope: 'SHARED', equipmentId: DB, meta: step(2.5), provenance: { now: NOW, uid: 'u' } });
  const d1 = plan1(record(), cfg1), frozen = JSON.stringify(d1.overlay);
  assert.deepEqual(d1.overlay.equipmentSnapshot, { source: 'COACH_CONFIGURED', scope: 'SHARED_EQUIPMENT', revision: 1, configuredAt: NOW, kind: 'STEP', unit: 'KG' });
  const cfg2 = C.setEquipmentIncrement(cfg1, { scope: 'SHARED', equipmentId: DB, meta: step(1), provenance: { now: '2026-10-05T00:00:00.000Z', uid: 'u' } });
  assert.equal(JSON.stringify(d1.overlay), frozen, 'a recorded overlay is data, not a live reference');
  assert.equal(plan1(record(), cfg2).overlay.equipmentSnapshot.revision, 2);
  assert.equal(plan1(record(), cfg2).overlay.appliedValue, 102, 'the new metadata only affects NEW plans');
});

test('T518.5 executed LOGS never reference equipment metadata (config changes cannot rewrite history)', () => {
  const client = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
  assert.ok(!/equipmentIncrements|loadIncrement|equipmentSnapshot/.test(client));
  assert.ok(!/equipmentIncrements|loadIncrement/.test(fs.readFileSync(path.join(root, 'assets/progression-auto-apply-shadow.js'), 'utf8')));
  assert.ok(!/equipmentIncrements|loadIncrement/.test(fs.readFileSync(path.join(root, 'assets/progression-magnitude-policy.js'), 'utf8')));
});

// ---------------- bulk export
test('T518.6 the template lists every resolved-identity equipment with BLANK metadata (no fabricated numbers)', () => {
  const t = C.exportTemplate({ catalog });
  assert.ok(t.rows.length >= 39); assert.ok(t.rows.every(r => r.kind === '' && r.step === '' && r.loads === '' && r.unit === ''));
  const parsed = JSON.parse(t.text); assert.equal(parsed.schema, C.BULK_SCHEMA); assert.equal(parsed.items.length, t.rows.length);
  assert.deepEqual(t.notConfigurableInBulk.map(x => x.name).sort(), ['Accesorio de polea', 'Máquina']);
  assert.ok(!/\b(2\.5|1\.25|5|20)\b/.test(t.text.replace(/"note"[^\n]*\n/, '').replace(/[a-z0-9-]+/gi, m => (/^\d+(\.\d+)?$/.test(m) ? m : ''))), 'no numeric values in the template');
});

test('T518.7 CSV template round-trips: header + blank rows; configured values are exported and re-import as UNCHANGED', () => {
  const csv = C.exportTemplate({ catalog, format: 'csv' });
  assert.equal(csv.text.split('\n')[0], C.BULK_FIELDS.join(','));
  const cfg = C.setEquipmentIncrement(null, { scope: 'SHARED', equipmentId: BB, meta: { kind: 'PLATE_LOADED_BAR', barWeight: 20, smallestPlate: 1.25, unit: 'KG', source: 'COACH_CONFIGURED' }, provenance: { now: NOW } });
  const again = C.exportTemplate({ catalog, config: cfg, format: 'csv' });
  const r = parse(again.text, cfg);
  assert.equal(r.ok, true); assert.deepEqual([r.counts.added, r.counts.changed, r.counts.removed, r.counts.unchanged], [0, 0, 0, 1]);
  const j = parse(C.exportTemplate({ catalog, config: cfg }).text, cfg); assert.equal(j.counts.unchanged, 1);
});

// ---------------- bulk import
test('T518.8 a valid batch previews ADDED / CHANGED / REMOVED / UNCHANGED and yields the next config with provenance', () => {
  const base = C.setEquipmentIncrement(null, { scope: 'SHARED', equipmentId: BB, meta: step(2.5), provenance: { now: '2026-01-01T00:00:00.000Z' } });
  const text = JSON.stringify({ schema: C.BULK_SCHEMA, items: [
    { equipmentId: DB, scope: 'SHARED', kind: 'AVAILABLE_LOADS', unit: 'KG', loads: '10 12,5 15' },
    { equipmentId: BB, scope: 'SHARED', kind: 'STEP', unit: 'KG', step: '5' },
    { equipmentId: 'functional-trap-bar', scope: 'GYM', gymId: GYM, kind: 'STEP', unit: 'KG', step: '2,5' },
    { equipmentId: 'functional-cable-station', scope: 'SHARED' }] });
  const r = parse(text, base);
  assert.equal(r.ok, true); assert.deepEqual([r.counts.added, r.counts.changed, r.counts.removed, r.counts.skipped], [2, 1, 0, 1]);
  assert.deepEqual(r.rows.map(x => x.action), ['ADDED', 'CHANGED', 'ADDED']);
  assert.deepEqual(r.nextConfig.shared[DB].loads, [10, 12.5, 15]); assert.equal(r.nextConfig.shared[DB].configuredBy, 'coach-1');
  assert.equal(r.nextConfig.shared[BB].revision, 2); assert.equal(r.nextConfig.gyms[GYM]['functional-trap-bar'].scope, 'GYM_EQUIPMENT');
  assert.equal(base.shared[BB].step, 2.5, 'the input config is untouched until the Coach confirms');
});

test('T518.9 kind NONE removes an existing definition; NONE on nothing is UNCHANGED', () => {
  const base = C.setEquipmentIncrement(null, { scope: 'SHARED', equipmentId: DB, meta: step(2.5), provenance: { now: NOW } });
  const r = parse(JSON.stringify({ schema: C.BULK_SCHEMA, items: [{ equipmentId: DB, kind: 'NONE' }, { equipmentId: BB, kind: 'NONE' }] }), base);
  assert.equal(r.ok, true); assert.deepEqual(r.rows.map(x => x.action), ['REMOVED', 'UNCHANGED']); assert.deepEqual(r.nextConfig.shared, {});
});

test('T518.10 ALL-OR-NOTHING: any invalid row rejects the whole batch with human-readable, row-numbered errors', () => {
  const text = JSON.stringify({ schema: C.BULK_SCHEMA, items: [
    { equipmentId: DB, kind: 'STEP', unit: 'KG', step: '2.5' },
    { equipmentId: 'made-up-id', kind: 'STEP', unit: 'KG', step: '5' },
    { equipmentId: BB, kind: 'STEP', unit: 'KG', step: '-3' },
    { equipmentId: 'functional-trap-bar', kind: 'STEP', step: '5' },
    { equipmentId: 'functional-trap-bar', scope: 'GYM', gymId: 'nowhere', kind: 'STEP', unit: 'KG', step: '5' },
    { equipmentId: 'functional-cable-station', scope: 'WORLD', kind: 'STEP', unit: 'KG', step: '5' },
    { equipmentId: 'functional-adjustable-bench', step: '5' },
    { equipmentId: 'functional-hyperextension-bench', kind: 'STEP', unit: 'KG', step: '5', extra: 1 }] });
  const r = parse(text);
  assert.equal(r.ok, false); assert.equal(r.nextConfig, null); assert.deepEqual(r.rows, []);
  const msgs = r.errors.join('\n');
  for (const frag of ['Fila 2:', 'no es un equipo canónico', 'Fila 3:', 'no es un valor válido', 'Fila 4:', 'unidad', 'Fila 5:', 'sede "nowhere" desconocida', 'Fila 6:', 'alcance', 'Fila 7:', 'falta kind', 'Fila 8:', 'campo desconocido'])
    assert.ok(msgs.includes(frag), frag + '\n' + msgs);
  assert.ok(!/Fila 1:/.test(msgs), 'the valid row is fine; the batch is still rejected');
});

test('T518.11 duplicate rows: identical are merged, CONFLICTING are rejected', () => {
  const dup = (a, b) => parse(JSON.stringify({ schema: C.BULK_SCHEMA, items: [Object.assign({ equipmentId: DB, kind: 'STEP', unit: 'KG' }, a), Object.assign({ equipmentId: DB, kind: 'STEP', unit: 'KG' }, b)] }));
  assert.equal(dup({ step: '2.5' }, { step: '2,5' }).ok, true);
  const bad = dup({ step: '2.5' }, { step: '5' });
  assert.equal(bad.ok, false); assert.ok(/duplicada y contradictoria/.test(bad.errors[0]));
  const scoped = parse(JSON.stringify({ schema: C.BULK_SCHEMA, items: [{ equipmentId: DB, kind: 'STEP', unit: 'KG', step: '5' }, { equipmentId: DB, scope: 'GYM', gymId: GYM, kind: 'STEP', unit: 'KG', step: '2.5' }] }));
  assert.equal(scoped.ok, true, 'different scopes are different definitions');
});

test('T518.12 malformed files are rejected cleanly (empty, wrong schema, broken JSON/CSV, unknown columns)', () => {
  for (const t of ['', '   ', '{"schema":"other","items":[]}', '{ nope', 'equipmentId,foo\nfunctional-dumbbells,1', 'kind,unit\nSTEP,KG', '[1,2]', '"equipmentId,name\n'])
    assert.equal(parse(t).ok, false, JSON.stringify(t));
  assert.ok(parse('equipmentId,foo\nx,1').errors.some(e => /Columna desconocida "foo"/.test(e)));
});

test('T518.13 CSV import: quoted cells, CRLF and BOM are handled', () => {
  const csv = '﻿equipmentId,name,scope,gymId,kind,unit,step,min,max,barWeight,smallestPlate,loads\r\nfunctional-dumbbells,"Mancuernas, pares",SHARED,,AVAILABLE_LOADS,KG,,,,,,"10 12,5 15"\r\n';
  const r = parse(csv); assert.equal(r.ok, true); assert.deepEqual(r.nextConfig.shared[DB].loads, [10, 12.5, 15]);
});

// ---------------- impact preview
const load = (cfg) => ({ key: 'k', exerciseId: EXID, magnitude: record().magnitude, config: cfg });
test('T518.14 impact preview: BLOCKED->READY, READY->different load, READY->BLOCKED, unchanged', () => {
  const cands = [{ key: 'k', exerciseId: EXID, magnitude: record().magnitude }];
  const none = null, s25 = C.setEquipmentIncrement(null, { scope: 'SHARED', equipmentId: DB, meta: step(2.5), provenance: { now: NOW } });
  const s5 = C.setEquipmentIncrement(null, { scope: 'SHARED', equipmentId: DB, meta: step(5), provenance: { now: NOW } });
  const s1 = C.setEquipmentIncrement(null, { scope: 'SHARED', equipmentId: DB, meta: step(1), provenance: { now: NOW } });
  const p = (a, b) => C.previewImpact({ catalog, config: a, nextConfig: b, candidates: cands });
  assert.equal(p(none, s25).candidates.blockedToReady, 1);
  assert.equal(p(s25, none).candidates.readyToBlocked, 1);
  assert.equal(p(s25, s1).candidates.readyLoadChanged, 1);
  assert.equal(p(s25, s25).candidates.unchangedReady, 1);
  assert.equal(p(none, none).candidates.unchangedBlocked, 1);
  assert.equal(p(s25, s5).candidates.readyToBlocked + p(s25, s5).candidates.readyLoadChanged + p(s25, s5).candidates.unchangedReady, 1);
  assert.equal(p(none, s25).mode, 'CANDIDATES');
  void load;
});

test('T518.15 with no candidate data the preview falls back to catalog impact counts (mode CATALOG)', () => {
  const s = C.setEquipmentIncrement(null, { scope: 'SHARED', equipmentId: DB, meta: step(2.5), provenance: { now: NOW } });
  const p = C.previewImpact({ catalog, config: null, nextConfig: s, candidates: [] });
  assert.equal(p.mode, 'CATALOG'); assert.equal(p.catalog.exercisesNewlyConfigured, 14); assert.equal(p.catalog.equipmentTouched, 1);
  const back = C.previewImpact({ catalog, config: s, nextConfig: null, candidates: [] });
  assert.equal(back.catalog.exercisesLosingConfiguration, 14);
  const val = C.previewImpact({ catalog, config: s, nextConfig: C.setEquipmentIncrement(s, { scope: 'SHARED', equipmentId: DB, meta: step(5), provenance: { now: NOW } }), candidates: [] });
  assert.equal(val.catalog.exercisesChangedValue, 14);
});

test('T518.16 bulk + impact are pure: they write nothing and the module has no I/O', () => {
  const src = fs.readFileSync(path.join(root, 'assets/equipment-context.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/updateDoc|setDoc|addDoc|fetch\(|localStorage|document\.|window\./.test(src));
});
