// T486: legacy recommendation values that are NOT applied are never presented as the prescription
// (OBJETIVO/HOY/Sube.../Sugerido/PRÓXIMA SESIÓN). Coach-authored values keep OBJETIVO.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
function fnSource(name) {
  const start = client.indexOf('function ' + name + '(');
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
vm.runInContext("var _escHTml = function(s){return String(s)};" +
  ['_normName', '_roundUnit', '_convertCarga', '_buildSetReferenceHtml', '_buildProgreSummaryHtml'].map(fnSource).join('\n'), ctx);

test('T486.1 (T500) the next-exposure recommendation card no longer exists', () => {
  assert.ok(!client.includes('_buildNextExposureHtml'));
});

test('T486.2 (T500) per-set reference never shows a legacy recommended load', () => {
  const html = ctx._buildSetReferenceHtml({ carga: '80', unit: 'KG', reps: '8', rir_real: 1 }, null, 0, 'KG', 2, 2, undefined, 'k');
  assert.ok(!html.includes('RECOMENDACIÓN') && !/>OBJETIVO</.test(html));
});

test('T486.3 no invented numeric progression suggestion remains (fixed +2.5 / +5 step)', () => {
  const html = ctx._buildSetReferenceHtml({ carga: '80', unit: 'KG', reps: '8', rir_real: 1 }, null, 0, 'KG', 2, 2, undefined, 'k');
  assert.ok(html.includes('SEM 1'), 'previous execution reference remains');
  assert.ok(!/subir|mantener\)|→ /.test(html));
  assert.ok(!/step\s*=\s*unit === 'LB' \? 5 : 2\.5/.test(client));
});

test('T486.4 the OBJETIVO block shows only Coach-authored reps/RIR', () => {
  const i = client.indexOf('// T486: OBJETIVO = the Coach-authored prescription');
  assert.ok(i > 0);
  const block = client.slice(i, client.indexOf("})()+", i));
  assert.ok(!/progrec|newLoad|_exLoad/.test(block));
  assert.ok(/repsTarget\+' reps/.test(block) && /RIR '\+baseRIR/.test(block));
});

test('T486.5 (T500) no athlete-facing recommendation label remains; fatigue signals are informational', () => {
  assert.ok(!client.includes('Recomendación (no aplicada)') && !client.includes('ÚLTIMA RECOMENDACIÓN'));
  assert.ok(!client.includes('>ÚLTIMA PROGRESIÓN<') && !client.includes('>PRÓXIMA SESIÓN<'));
  const summary = ctx._buildProgreSummaryHtml({ recommendations: [{ action: 'increase_load', newLoad: 82.5, exerciseName: 'Remo' }], deloadTriggers: ['EIMD alto'] });
  assert.ok(/INFORMATIVO/.test(summary) && !summary.includes('82.5') && !summary.includes('PRÓXIMA SESIÓN'));
});

test('T486.6 no OBJETIVO label wraps a value that comes from a recommendation', () => {
  const lines = client.split('\n');
  lines.forEach((l, i) => {
    if (/>OBJETIVO<\/span>/.test(l)) {
      const near = lines.slice(i, i + 4).join('\n');
      assert.ok(!/progrec|progRec|newLoad|newReps|headerRec/.test(near), 'OBJETIVO near recommendation at line ' + (i + 1));
    }
  });
});
