// T485: warm-up loads never derive from a progression recommendation. Base load = previous execution >
// history > Coach-authored plan load; with no base the warm-up is qualitative.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
function fnSource(name) {
  let start = client.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  let depth = 0, quote = null, escaped = false;
  for (let i = client.indexOf('{', start); i < client.length; i++) {
    const c = client[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error(name);
}
const ctx = {};
vm.createContext(ctx);
['_roundUnit', '_warmupReferenceLoad', '_warmupRowsHtml'].forEach(n => vm.runInContext(fnSource(n), ctx));
const region = (a, b) => { const i = client.indexOf(a); assert.ok(i >= 0, a); const j = client.indexOf(b, i); assert.ok(j > i, b); return client.slice(i, j); };

test('T485.1 base load order: previous execution > history > Coach plan load', () => {
  const plan = { load: 100 }, hist = { load: 90 }, prev = { avgLoad: 80 };
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._warmupReferenceLoad(prev, hist, plan))), { load: 80, source: 'PREVIOUS_EXECUTION' });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._warmupReferenceLoad(null, hist, plan))), { load: 90, source: 'HISTORY' });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._warmupReferenceLoad(null, null, plan))), { load: 100, source: 'COACH_PLAN' });
});

test('T485.2 no legitimate base -> no invented number', () => {
  for (const args of [[null, null, null], [{ avgLoad: NaN }, { load: '' }, { load: 0 }], [{ avgLoad: 0 }, {}, { load: 'x' }], [undefined, undefined, undefined]])
    assert.deepEqual(JSON.parse(JSON.stringify(ctx._warmupReferenceLoad(...args))), { load: 0, source: 'NONE' });
});

test('T485.3 the helper cannot receive or read a recommendation', () => {
  const src = fnSource('_warmupReferenceLoad');
  assert.ok(!/progrec|progRec|newLoad|recommend|headerRec/i.test(src));
  assert.equal(ctx._warmupReferenceLoad.length, 3);
});

test('T485.4 both warm-up builders no longer consult legacy newLoad/progrec', () => {
  const card = region('var _wuPatternKey = (catData && catData.motorPattern)', '// ── E. Series');
  const boost = region('// T485: warm-up base load = previous execution', 'var repsTarget = ej.repsRange || (ej.sets && ej.sets[0]');
  for (const r of [card, boost]) {
    assert.ok(!/progrec|progRec|newLoad|progRecForWu/.test(r));
    assert.ok(/_warmupReferenceLoad\(/.test(r) && /_warmupRowsHtml\(/.test(r));
  }
  assert.ok(!client.includes('progRecForWu'));
});

test('T485.5 with a base the numeric warm-up is unchanged (50/70/85%)', () => {
  const html = ctx._warmupRowsHtml(100, 'KG');
  for (const t of ['50 KG × 8 reps', '70 KG × 5 reps', '85 KG × 2 reps']) assert.ok(html.includes(t), t);
});

test('T485.6 without a base the warm-up is qualitative, not numeric', () => {
  const html = ctx._warmupRowsHtml(0, 'KG');
  assert.ok(html.includes('50% de tu carga de trabajo × 8 reps') && html.includes('70% de tu carga de trabajo × 5 reps') && html.includes('85% de tu carga de trabajo × 2 reps'));
  assert.ok(!/\d+(\.\d+)?\s*KG\s*×/.test(html), 'no absolute load appears');
});

test('T485.7 the warm-up block is kept for eligible exercises even without a base; Core/Cardio still excluded', () => {
  const card = region('var _wuPatternKey = (catData && catData.motorPattern)', '// ── E. Series');
  assert.ok(/var _isFirstOfPattern = \(ei === 0\) && \(_wuPatternKey !== 'Core'\) && \(_wuPatternKey !== 'Cardio'\);/.test(card));
  assert.ok(!/wuRefLoad\s*>\s*0\s*\)\s*\{/.test(card), 'the warm-up is no longer gated on a numeric base');
  assert.ok(client.includes("(wuHtml?'<button class=\"tap-target\" onclick=\"toggleNota(\\'wu_'"), 'boostcamp toggle follows the warm-up block');
});
