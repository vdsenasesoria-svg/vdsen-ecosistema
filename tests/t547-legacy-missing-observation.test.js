// T547: legacy calculateProgression must not fabricate read-side defaults for missing evidence (RIR=target, ICS=8, Pump=2) and stays NON-authoritative.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const CLIENT = fs.readFileSync('vdsen-cliente.html', 'utf8');
const a = CLIENT.indexOf('function calculateProgression(');
const calc = CLIENT.slice(a, CLIENT.indexOf('// ── FASE 27 — Missing Data Workflow', a));

test('T547.L1 missing ICS / Pump / RIR are null, never 8 / 2 / rirObj', () => {
  assert.ok(/var avgICS\s*=\s*_icsRaw\.length\s*\?\s*_avgArr\(_icsRaw\)\s*:\s*null;/.test(calc));
  assert.ok(/var avgPump\s*=\s*_pumpRaw\.length\s*\?\s*_avgArr\(_pumpRaw\)\s*:\s*null;/.test(calc));
  assert.ok(/var avgRIR\s*=\s*_rirRaw\.length\s*\?\s*_avgArr\(_rirRaw\)\s*:\s*null;/.test(calc));
  assert.ok(!/\|\|\s*2;\s*\}\)\);/.test(calc.slice(calc.indexOf('var avgPump'), calc.indexOf('var avgPump') + 300)), 'no `|| 2` pump coercion');
  assert.ok(!/:\s*8;\s*\/\/ fallback/.test(calc) && !/: rirObj;\s*\/\/ fallback/.test(calc));
});
test('T547.L2 every threshold is guarded: a missing observation can neither pass nor trigger a gate', () => {
  assert.ok(calc.includes('avgICS !== null && avgICS < 6') && calc.includes('avgICS !== null && avgICS < 7'));
  assert.ok(calc.includes('performedWell && avgICS !== null && avgICS >= 8'));
  assert.ok(calc.includes('avgPump !== null && avgPump === 3') && calc.includes('avgPump !== null && avgPump >= 2.5'));
  assert.ok(calc.includes('avgRIR !== null && (avgRIR <= rirObj + 0.5)') || calc.includes('avgRIR !== null && (avgRIR <= rirObj + 0.5)'.replace(' (', ' (')));
  assert.ok(calc.includes('var _prescriptionMatch = avgRIR !== null && '), 'no RIR => no "on target" claim => no load progression');
  assert.ok(calc.includes('} else if (avgRIR === null) {'), 'explicit no-RIR branch before any RIR-driven load decision');
});
test('T547.L3 no-observation reasons are explicit ("Sin ... registrado") and observed fields persist null', () => {
  assert.ok(calc.includes('Sin ICS registrado') && calc.includes('Sin RIR registrado'));
  assert.ok(calc.includes('observedICS: avgICS !== null') && calc.includes('observedPump: avgPump !== null'));
});
test('T547.L4 history/trend readers keep missing ICS as null and render a dash', () => {
  assert.ok(CLIENT.includes('avgICS: icsVals.length ? _avgArr(icsVals) : null,'));
  assert.ok(CLIENT.includes("last.avgICS === null ? '—'"));
  assert.ok(CLIENT.includes('return v.length?_avgArr(v):null; })(),'));
  assert.ok(fs.readFileSync('vdsen-coach.html', 'utf8').includes("r.trend.prevICS == null ? '—'"));
});
test('T547.L5 LEGACY AUTHORITY: calculateProgression performs no prescription write, no overlay, no canonical state', () => {
  for (const bad of ['setDoc(', 'updateDoc(', 'addDoc(', 'plans/', 'prescriptionOverlay', 'effectivePrescription', 'autoApply', 'progression_shadow', 'APPLIED'])
    assert.ok(!calc.includes(bad), 'calculateProgression must not contain ' + bad);
});
