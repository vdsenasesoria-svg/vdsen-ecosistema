'use strict';
// PERF-20261013: dos optimizaciones acotadas, sin contratos Firestore nuevos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function readCoachHelper(ctx) {
  const start = coach.indexOf('  let _coachClientsInFlight = null;');
  const end = coach.indexOf('  async function loadClientList() {', start);
  assert.ok(start >= 0 && end > start, 'helper must remain isolated before the client list');
  vm.runInNewContext(coach.slice(start, end) + '\nthis.read = _readCoachClientsInFlight;', ctx);
  return ctx.read;
}

test('Coach reuses the same in-flight query, then fetches fresh data after settlement', async () => {
  let resolveRead;
  let calls = 0;
  const ctx = {
    currentCoach: { uid: 'coach-a' },
    db: {},
    getDocs: () => { calls++; return new Promise(resolve => { resolveRead = resolve; }); },
    query: (...args) => args,
    collection: (_, name) => name,
    where: (...args) => args,
  };
  const read = readCoachHelper(ctx);
  const p1 = read(), p2 = read();
  assert.strictEqual(p1, p2, 'two concurrent callers share an identical Promise');
  assert.equal(calls, 1);
  resolveRead({ size: 1 });
  await p1;
  const p3 = read();
  assert.equal(calls, 2, 'settled snapshot is never cached');
  resolveRead({ size: 2 });
  assert.equal((await p3).size, 2);
});

test('Coach does not reuse an in-flight query from another UID', async () => {
  const pending = [];
  let calls = 0;
  const ctx = {
    currentCoach: { uid: 'coach-a' },
    db: {},
    getDocs: q => { calls++; return new Promise(resolve => pending.push({ q, resolve })); },
    query: (...args) => args,
    collection: (_, name) => name,
    where: (...args) => args,
  };
  const read = readCoachHelper(ctx);
  const a = read();
  ctx.currentCoach = { uid: 'coach-b' };
  const b = read();
  assert.notStrictEqual(a, b);
  assert.equal(calls, 2);
  pending[0].resolve({ uid: 'coach-a' });
  await a;
  assert.strictEqual(read(), b, 'settling A must not clear B in-flight');
  pending[1].resolve({ uid: 'coach-b' });
  assert.equal((await b).uid, 'coach-b');
});

test('Coach clears the in-flight query after rejection so retry works', async () => {
  const pending = [];
  let calls = 0;
  const ctx = {
    currentCoach: { uid: 'coach-a' }, db: {},
    getDocs: () => { calls++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    query: (...args) => args,
    collection: (_, name) => name,
    where: (...args) => args,
  };
  const read = readCoachHelper(ctx);
  const a = read();
  pending[0].reject(new Error('temporary'));
  await assert.rejects(a, /temporary/);
  const b = read();
  assert.equal(calls, 2);
  pending[1].resolve({});
  await b;
});

function clientSnapshotFragment() {
  const start = client.indexOf('        var _nutricionChanged = !!newData.nutritionPlan;');
  const end = client.indexOf('        if (newData.profileType &&', start);
  assert.ok(start >= 0 && end > start, 'client live snapshot fragment must exist');
  return new Function('newData', 'PLAN', 'document', 'renderNutricion', client.slice(start, end));
}

test('Client updates model but skips hidden nutrition DOM rebuild', () => {
  const apply = clientSnapshotFragment();
  const PLAN = { nutricion: { texto: 'anterior' }, suplementacion: { texto: 'anterior' } };
  let renders = 0;
  const doc = { getElementById: () => ({ style: { display: 'none' } }) };
  apply({ nutritionPlan: { texto: 'actual' }, supplementPlan: { texto: 'suplemento actualizado' } },
    PLAN, doc, () => { renders++; });
  assert.equal(renders, 0, 'hidden tab needs no DOM repaint');
  assert.equal(PLAN.nutricion.texto, 'actual');
  assert.equal(PLAN.suplementacion.texto, 'suplemento actualizado');
  assert.ok(client.includes('else if (i === 2) renderNutricion();'), 'goTab(2) must still repaint when opened');
});

test('Client repaints visible nutrition only after nutrition AND supplements update', () => {
  const apply = clientSnapshotFragment();
  const PLAN = { nutricion: null, suplementacion: null };
  const frames = [];
  const doc = { getElementById: () => ({ style: { display: 'block' } }) };
  apply({ nutritionPlan: { texto: 'comidas' }, supplementPlan: { texto: 'suplementos' } },
    PLAN, doc, () => frames.push({ nutrition: PLAN.nutricion.texto, supplements: PLAN.suplementacion.texto }));
  assert.deepEqual(frames, [{ nutrition: 'comidas', supplements: 'suplementos' }]);
});

test('No changes to firestore listener cardinality or numeric authority', () => {
  assert.equal((coach.match(/= onSnapshot\(/g) || []).length, 4);
  assert.equal((client.match(/FB\.onSnapshot\(/g) || []).length, 5);
  assert.ok(client.includes('NUMERIC_APPLY_ENABLED'));
  assert.ok(coach.includes('const [_logSnaps, _planSnaps] = await Promise.all([Promise.all(_logPromises), Promise.all(_planPromises)]);'));
});
