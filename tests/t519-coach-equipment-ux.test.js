// T519: Coach UX for real equipment data entry: obvious kinds, placeholders (never saved values), impact preview before saving,
// provenance stamped on save, safe bulk import UI (preview then confirm, single write of the coach doc).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const C = require(path.join(root, 'assets/equipment-context.js'));
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));
const fn = (a, b) => { const i = coach.indexOf(a); assert.ok(i >= 0, a); return coach.slice(i, coach.indexOf(b, i)); };

test('T519.1 the three increment kinds are obvious and explained without example VALUES', () => {
  const m = fn('function _incFormMarkup(', 'function _incFormBind');
  for (const k of ['STEP — paso fijo', 'PLATE_LOADED_BAR — barra + discos', 'AVAILABLE_LOADS — lista de cargas']) assert.ok(m.includes(k), k);
  assert.ok(/placeholder="' \+ _escH\(hint/.test(m));
  assert.ok(!/value="\d|placeholder="\d|placeholder="[^"]*\b\d+([.,]\d+)?\s*(kg|lb)/i.test(m), 'no numeric example in placeholders');
  assert.ok(!/(hint|placeholder)[^;]*\b(2[.,]5|1[.,]25)\b/.test(m));
});

test('T519.2 the equipment editor shows an impact preview and stamps provenance on save', () => {
  const e = fn('async function openEquipmentIncrementEditor', 'window.openEquipmentIncrementEditor');
  assert.ok(e.includes('previewImpact') && e.includes('describeImpact') && e.includes('ei-impact'));
  assert.ok(/provenance: \{ now: new Date\(\)\.toISOString\(\), uid: currentCoach\.uid \}/.test(e));
  const x = fn('async function openEquipmentIncrementEditor', 'window.openEquipmentIncrementEditor');
  assert.ok(!/updateDoc\(doc\(db, 'plans'|progressionApplications|nextExposureOverlays|logs/.test(x));
});

test('T519.3 the per-exercise override is stamped too (scope EXERCISE, previous revision kept)', () => {
  const e = fn('function openLoadIncrementEditor(', 'window.openLoadIncrementEditor');
  assert.ok(/stampProvenance\(meta, \{ prev: exercise\.loadIncrement \|\| null, scope: 'EXERCISE'/.test(e));
  assert.ok(/updateDoc\(doc\(db, 'exercises', exercise\.id\), \{ loadIncrement: meta \}\)/.test(e));
});

test('T519.4 bulk UI: templates, file/paste, PREVIEW first, single confirmed write to the coach doc, nothing on error', () => {
  const q = fn('async function openEquipmentReadinessQueue', 'window.openEquipmentReadinessQueue');
  for (const s of ['eqqTplJson', 'eqqTplCsv', 'eqqFile', 'eqqPreview', 'eqqCommit', 'exportTemplate', 'parseImport', 'previewImpact']) assert.ok(q.includes(s), s);
  assert.ok(/id="eqqCommit" disabled/.test(q), 'commit is disabled until a valid preview exists');
  assert.equal(q.split('updateDoc(').length - 1, 1, 'one write, only on confirm');
  assert.ok(/updateDoc\(doc\(db, 'coaches', currentCoach\.uid\), \{ equipmentIncrements: _pending \}\)/.test(q));
  assert.ok(/if \(!r\.ok\) \{ out\.textContent = 'No se importó nada/.test(q));
  assert.ok(!/collection\(db/.test(q));
});

test('T519.5 queue rows show unit / source / scope / revision; candidates carry magnitude for the impact preview', () => {
  const q = fn('async function openEquipmentReadinessQueue', 'window.openEquipmentReadinessQueue');
  assert.ok(q.includes('r.incrementUnit') && q.includes('r.incrementRevision') && q.includes('r.incrementScope'));
  assert.ok(/_lastLoadCandidates\.push\(\{ key: it\.key,[\s\S]*magnitude: full\.magnitude/.test(coach));
  assert.ok(coach.includes('_ref.exerciseDoc = exerciseDoc'));
});

test('T519.6 describeImpact produces readable Spanish lines for both modes', () => {
  const s = { mode: 'CATALOG', candidates: { total: 0, blockedToReady: 0, readyToBlocked: 0, readyLoadChanged: 0, unchangedReady: 0, unchangedBlocked: 0, items: [] },
    catalog: { exercisesNewlyConfigured: 14, exercisesLosingConfiguration: 0, exercisesChangedValue: 0, exercisesUnchanged: 57, equipmentTouched: 1 } };
  assert.ok(/Sin candidatos LOAD locales/.test(C.describeImpact(s)[0]) && /nuevos con incremento: 14/.test(C.describeImpact(s)[1]));
  const c = Object.assign({}, s, { mode: 'CANDIDATES', candidates: Object.assign({}, s.candidates, { total: 3, blockedToReady: 2, unchangedBlocked: 1 }) });
  assert.ok(/Bloqueado → listo \(sin aplicar\): 2/.test(C.describeImpact(c)[1]));
  assert.deepEqual(C.describeImpact(null), []);
  void catalog;
});
