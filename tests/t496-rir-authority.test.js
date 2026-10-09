// T496: Coach-authored RIR is the operational prescribed RIR. Calendar week, the reactive deload heuristic and
// the free-barbell heuristic never rewrite it; observed RIR (rir_real) stays separate; RIR 0 is a real value.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const slice = (a, b) => { const i = client.indexOf(a); assert.ok(i >= 0, a); const j = client.indexOf(b, i + 1); assert.ok(j > i, b); return client.slice(i, j); };

function engine({ total = 6, deload = false } = {}) {
  const src = slice('function getAdjustedRIR(', 'function _coachRIR(') + slice('function _coachRIR(', '\n}\n') + '\n}\n';
  const ctx = { getTotalWeeks: () => total, _computeDeloadTriggers: () => ({ isDeload: deload }) };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.getAdjustedRIR = getAdjustedRIR; this._coachRIR = _coachRIR;', ctx);
  return ctx;
}

test('T496.1 calendar week never alters the Coach RIR (peak, intensification, last week)', () => {
  const e = engine({ total: 6 });
  for (let w = 1; w <= 6; w++) assert.equal(e.getAdjustedRIR(2, w), 2, 'week ' + w);
  assert.equal(e.getAdjustedRIR(3, 4), 3);
  assert.equal(e.getAdjustedRIR(1, 5), 1);
});

test('T496.2 reactive deload heuristic does not rewrite the prescribed RIR', () => {
  const e = engine({ total: 6, deload: true });
  for (let w = 1; w <= 6; w++) assert.equal(e.getAdjustedRIR(2, w), 2, 'week ' + w);
});

test('T496.3 free-barbell heuristic does not floor the Coach RIR (0 stays 0)', () => {
  const e = engine();
  assert.equal(e.getAdjustedRIR(0, 3, 'Sentadilla libre'), 0);
  assert.equal(e.getAdjustedRIR(0, 3, 'Press banca'), 0);
  assert.equal(e.getAdjustedRIR(0, 3, 'Curl'), 0);
});

test('T496.4 _coachRIR preserves RIR 0 from ej.rir and set rirTarget; falls back to 2 only when absent', () => {
  const e = engine();
  assert.equal(e._coachRIR({ rir: '0', sets: [{ rirTarget: 3 }] }), 0);
  assert.equal(e._coachRIR({ sets: [{ rirTarget: 0 }] }), 0);
  assert.equal(e._coachRIR({ rir: '3' }), 3);
  assert.equal(e._coachRIR({}), 2);
  assert.equal(e._coachRIR({ sets: [{}] }), 2);
  assert.equal(e._coachRIR({ rir: '1' }, { rirTarget: 4 }), 1, 'ej.rir before the effective set');
  assert.equal(e._coachRIR({}, { rirTarget: 4 }), 4, 'explicit effective set fallback');
});

test('T496.5 plan converter preserves a Coach RIR of 0 (no `|| 2` coercion)', () => {
  assert.ok(!client.includes('(e.sets[0].rirTarget  || 2)'));
  assert.ok(client.includes('var rirTarget  = (e.sets && e.sets[0] && e.sets[0].rirTarget !== undefined && e.sets[0].rirTarget !== null) ? e.sets[0].rirTarget : 2;'));
});

test('T496.7 the free-barbell heuristic helper is gone', () => { assert.ok(!client.includes('_isFreeBarbell')); });

test('T496.6 every prescribed-RIR read goes through _coachRIR; observed RIR stays separate', () => {
  assert.ok(!/getAdjustedRIR\(parseInt\(ej\.rir\)\|\|/.test(client), 'no `parseInt(ej.rir)||` chains');
  assert.ok(!client.includes('parseInt(_ejMeta.rir) ||'));
  assert.ok(client.includes('rir_real: rirReal'), 'executed/observed RIR still logged separately');
  const log = slice('LOGS[key] = { carga, reps, unit, done, rir:', 'ts: Date.now()');
  assert.ok(log.includes('rir_real: rirReal'));
});
