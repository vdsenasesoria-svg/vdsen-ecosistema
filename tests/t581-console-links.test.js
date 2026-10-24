'use strict';
// T581: the Coach-console bridge (docs/pilot/coach-console-links.js) used until the "Vínculos" window reaches production.
// It runs against FAKE Firebase modules here: dry mode writes nothing; apply mode writes ONLY dotted exerciseLinks.<pid> fields on the coach's own document.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../assets/exercise-visual-catalog.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pilot', 'coach-console-links.js'), 'utf8');

const PLAN = { days: [{ label: 'D1', exercises: [
  { exerciseName: 'Jalón al pecho agarre neutro', prescriptionExerciseId: 'pid-exact' },                 // exact catalog name
  { exerciseName: 'Press Convergente Horizontal', prescriptionExerciseId: 'pid-extra' },                 // approved in EXTRA
  { exerciseName: 'Curl femoral acostado máquina', prescriptionExerciseId: 'pid-lying' },                // similar to a DIFFERENT machine: must NOT be linked
  { exerciseName: 'Remo Gironda', prescriptionExerciseId: 'pid-none' },
  { exerciseName: 'Crunch Máquina' },                                                                      // no PID
] }] };

function harness(o) {
  o = o || {};
  const writes = [];
  const store = { 'coaches/coach-1': { exerciseLinks: {} }, 'plans/plan-1': PLAN };
  const clients = o.clients || [{ id: 'cli-1', data: { displayName: 'Ayrton VD', coachId: 'coach-1', activePlanId: 'plan-1' } }];
  const F = {
    getFirestore: () => ({}), collection: (db, n) => ({ n }), where: () => ({}), query: (c) => c,
    getDocs: async () => ({ forEach: (fn) => clients.forEach((c) => fn({ id: c.id, data: () => c.data })) }),
    doc: (db, col, id) => ({ key: col + '/' + id }),
    getDoc: async (r) => ({ exists: () => r.key in store, data: () => store[r.key] }),
    updateDoc: async (r, upd) => { writes.push([r.key, upd]); Object.keys(upd).forEach((k) => { const [f, ...rest] = k.split('.'); store[r.key][f] = Object.assign({}, store[r.key][f], { [rest.join('.')]: upd[k] }); }); },
  };
  const mods = { 'firebase-app.js': { getApp: () => ({}) }, 'firebase-firestore.js': F, 'firebase-auth.js': { getAuth: () => ({ currentUser: o.noUser ? null : { uid: 'coach-1' } }) } };
  const logs = [], tables = [], warns = [];
  const consoleStub = { log: (...a) => logs.push(a.join(' ')), table: (r) => tables.push(r), warn: (...a) => warns.push(a.join(' ')) };
  const code = SRC.replace(/import\(G \+ '([^']+)'\)/g, "__imp('$1')").replace("const MODE = 'dry'", "const MODE = '" + (o.mode || 'dry') + "'");
  const run = new Function('window', '__imp', 'console', 'return ' + code.slice(code.indexOf('(async')));
  const result = run({ VDSEN_EXERCISE_VISUAL_CATALOG: catalog }, async (n) => mods[n], consoleStub);
  return { result, writes, store, logs, tables, warns };
}

test('T581.C1 dry mode: proposes exact + approved links, never the lookalike machine, and writes NOTHING', async () => {
  const h = harness({ mode: 'dry' }); const r = await h.result;
  assert.equal(r.guardado, 0); assert.equal(h.writes.length, 0);
  assert.deepEqual(r.links, { 'pid-exact': 'legacy-jalon-neutro', 'pid-extra': 'sf-sd-matrix-chest-press-selectorized' });
  const rows = h.tables[0], by = (n) => rows.find((x) => x.ejercicio === n);
  assert.equal(by('Jalón al pecho agarre neutro').estado, 'EXACTA');
  assert.equal(by('Press Convergente Horizontal').estado, 'APROBADO (EXTRA)');
  assert.equal(by('Curl femoral acostado máquina').estado, 'sin vínculo');
  assert.equal(by('Remo Gironda').estado, 'sin vínculo');
  assert.equal(by('Crunch Máquina').estado, 'sin vínculo', 'no PID and no match: nothing to link');
});

test('T581.C2 apply mode: one update on the coach own document with dotted exerciseLinks.<pid> fields, read back and verified', async () => {
  const h = harness({ mode: 'apply' }); const r = await h.result;
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0][0], 'coaches/coach-1');
  assert.deepEqual(h.writes[0][1], { 'exerciseLinks.pid-exact': 'legacy-jalon-neutro', 'exerciseLinks.pid-extra': 'sf-sd-matrix-chest-press-selectorized' });
  assert.equal(r.guardado, 2); assert.equal(r.verificado, true);
  assert.equal(JSON.stringify(h.store['plans/plan-1']), JSON.stringify(PLAN), 'the plan is never touched');
});

test('T581.C3 guards: no session, ambiguous or missing athlete stop before any write', async () => {
  await assert.rejects(() => harness({ noUser: true, mode: 'apply' }).result, /Inicia sesión/);
  const two = [{ id: 'a', data: { displayName: 'Ayrton A', coachId: 'coach-1', activePlanId: 'plan-1' } }, { id: 'b', data: { displayName: 'Ayrton B', coachId: 'coach-1', activePlanId: 'plan-1' } }];
  const h2 = harness({ clients: two, mode: 'apply' }); await assert.rejects(() => h2.result, /más de uno/); assert.equal(h2.writes.length, 0);
  const h3 = harness({ clients: [], mode: 'apply' }); await assert.rejects(() => h3.result, /No encontré/); assert.equal(h3.writes.length, 0);
});

test('T581.C4 static: no name-fuzzy matching, no other collection is written, only the coach own doc', () => {
  assert.ok(!/jaccard|fuzzy|similar/i.test(SRC.replace(/^\/\/.*$/gm, '')));
  assert.equal((SRC.match(/F\.updateDoc\(/g) || []).length, 1);
  assert.match(SRC, /F\.updateDoc\(F\.doc\(db, 'coaches', me\.uid\), upd\)/);
  assert.ok(!/F\.(setDoc|addDoc|deleteDoc)\(/.test(SRC));
});
