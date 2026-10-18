'use strict';
// T581: explicit plan <-> catalog links. Pure parser (all-or-nothing, never inferred from names), executor wiring and Coach UI wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ctx = require('../assets/equipment-context.js');
const catalog = require('../assets/exercise-visual-catalog.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const EX = 'sf-sd-converging-lat-pulldown-plate-loaded';
const parse = (t, o) => ctx.parseLinksImport(t, Object.assign({ catalog, config: ctx.emptyConfig() }, o || {}));
const HEAD = 'prescriptionExerciseId,catalogExerciseId\n';

test('T581.1 CSV: valid rows are accepted and report the equipment the catalog entry resolves to', () => {
  const r = parse(HEAD + 'pid-1,' + EX + '\npid-2,legacy-jalon-prono\n');
  assert.equal(r.ok, true, r.errors.join('|'));
  assert.deepEqual(r.links, { 'pid-1': EX, 'pid-2': 'legacy-jalon-prono' });
  assert.equal(r.rows[0].equipmentId, EX);
  assert.equal(r.rows[1].equipmentName, 'Polea alta');
});

test('T581.2 the `aprobar` column gates the import: only rows marked SI are taken (a proposal file imports nothing until approved)', () => {
  const csv = 'prescriptionExerciseId,catalogExerciseId,aprobar\npid-1,' + EX + ',SI\npid-2,legacy-jalon-prono,\npid-3,legacy-jalon-neutro,no\n';
  const r = parse(csv);
  assert.equal(r.ok, true); assert.deepEqual(Object.keys(r.links), ['pid-1']); assert.equal(r.skipped, 2);
  const none = parse('prescriptionExerciseId,catalogExerciseId,aprobar\npid-1,' + EX + ',\n');
  assert.equal(none.ok, false); assert.match(none.errors.join(' '), /ninguna aprobada/);
});

test('T581.3 JSON forms: { links: {pid: id} } and a list of objects', () => {
  assert.deepEqual(parse(JSON.stringify({ links: { 'pid-1': EX } })).links, { 'pid-1': EX });
  assert.deepEqual(parse(JSON.stringify([{ prescriptionExerciseId: 'pid-1', catalogExerciseId: EX }])).links, { 'pid-1': EX });
});

test('T581.4 any invalid row rejects the whole file with a reason (unknown catalog id, empty id, bad PID, conflicting duplicate, bad format)', () => {
  const bad = [
    [HEAD + 'pid-1,' + EX + '\npid-2,ex-not-in-catalog\n', /no existe en el catálogo/],
    [HEAD + 'pid-1,\n', /falta el catalogExerciseId/],
    [HEAD + ',' + EX + '\n', /prescriptionExerciseId vacío o inválido/],
    [HEAD + 'a.b,' + EX + '\n', /inválido/],
    [HEAD + 'pid-1,' + EX + '\npid-1,legacy-jalon-prono\n', /dos ejercicios distintos/],
    ['foo,bar\n1,2\n', /Faltan las columnas/],
    ['{ not json', /Formato inválido/],
    ['', /vacío/],
  ];
  for (const [t, re] of bad) { const r = parse(t); assert.equal(r.ok, false, t); assert.equal(r.links, null); assert.match(r.errors.join(' '), re, t); }
});

test('T581.5 identity comes from the explicit id only: a name column is ignored and nothing is guessed', () => {
  const r = parse('prescriptionExerciseId,catalogExerciseId,ejercicio\npid-1,' + EX + ',Cualquier nombre\n');
  assert.equal(r.ok, true); assert.equal(r.links['pid-1'], EX);
  assert.ok(!/normalizeLabel|label:|fuzzy|similar|jaccard|indexOf\(.*exerciseName/i.test(ctx.parseLinksImport.toString()), 'no label / name matching inside the parser');
});

test('T581.6 executor: the link is consulted only after the plan own exerciseId, by exact PID, from the athlete coach document', () => {
  const src = read('api/_autonomousProgression.js');
  assert.match(src, /exerciseLinks/);
  assert.match(src, /pex\.exerciseId \|\| \(links && typeof links\[pex\.prescriptionExerciseId\] === 'string'/);
  assert.ok(!/exerciseName[^;]*exerciseLinks|exerciseLinks[^;]*exerciseName/.test(src), 'never keyed by name');
});

test('T581.7 Coach UI: preview parses with the shared parser; confirm writes dotted exerciseLinks.<pid> fields on the coach doc only (no plan write)', () => {
  const html = read('vdsen-coach.html');
  const i = html.indexOf('function openExerciseLinksImporter');
  assert.ok(i > 0); const block = html.slice(i, html.indexOf('window.openExerciseLinksImporter'));
  assert.ok(html.includes('id="eqqLinks"') && /getElementById\('eqqLinks'\)\.onclick = function\(\) \{ openExerciseLinksImporter\(\); \}/.test(html), 'launched from the Equipos queue');
  assert.match(block, /parseLinksImport\(/);
  assert.match(block, /'exerciseLinks\.' \+ pid/);
  assert.match(block, /updateDoc\(doc\(db, 'coaches', currentCoach\.uid\), upd\)/);
  assert.ok(!/doc\(db, 'plans'/.test(block), 'the link never writes the plan');
  assert.equal((html.match(/id="eqlPreview"/g) || []).length, 1); assert.equal((html.match(/id="eqlCommit"/g) || []).length, 1);
});

test('T581.8 Firestore rules need no change: a coach may update its own document except the protected server-managed keys, which exclude exerciseLinks', () => {
  const rules = read('firestore.rules');
  const m = rules.match(/function protectedCoachKeys\(\)\s*\{\s*return \[([^\]]*)\]/);
  assert.ok(m, 'protectedCoachKeys found'); assert.ok(!/exerciseLinks/.test(m[1]));
});
