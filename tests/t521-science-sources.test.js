// T521: (a) every citation in the science source search exists in the cited file; (b) the representative-set simulator is
// deterministic, analysis-only and not connected to runtime; (c) no unsupported rule was implemented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const sim = require(path.join(root, 'scripts/simulate-representative-set.cjs'));

const CITES = [
  ['docs/CONTEXTO_GENERADOR.md', '## 8. DOUBLE PROGRESSION'], ['docs/CONTEXTO_GENERADOR.md', 'La Client App progresa reps primero, luego carga.'],
  ['docs/VDSEN_DEV_STATE.md', 'rir_error = avgRIR - rirObj'], ['docs/VDSEN_DEV_STATE.md', '< 0  → TOO_HARD  → no subir'], ['docs/VDSEN_DEV_STATE.md', 'Una exposición mala ≠ regresión (requiere 3 consecutivas)'],
  ['references/prompt-maestro-vdsen-coach.md', '## A.11 Descansos'], ['references/prompt-maestro-vdsen-coach.md', 'Compuesto hipertrofia | 6–12 | 120–180'],
  ['references/prompt-maestro-vdsen-coach.md', 'Señal derivada en la app cliente'], ['references/prompt-maestro-vdsen-coach.md', 'TODAS las series'],
  ['vdsen-cliente.html', 'var avgReps = _avgArr(sets.map(function(s){ return parseFloat(s.reps) || 0; }));'], ['vdsen-cliente.html', 'var _rirError = (avgRIR !== null) ? (avgRIR - rirObj) : 0;'],
  ['vdsen-cliente.html', 'candidato a bajar carga ~5%']
];
test('T521.1 every cited source snippet exists in the cited file (no invented citations)', () => {
  for (const [f, needle] of CITES) assert.ok(read(f).includes(needle), f + ' :: ' + needle);
  const doc = read('docs/PROGRESSION_SCIENCE_SOURCE_SEARCH.md');
  for (const t of ['RULE_D_E_ALTERNATIVE', 'RULE_C_E_PRECEDENCE', 'REPRESENTATIVE_SET', 'FUENTE ENCONTRADA', 'Qué respalda', 'Qué NO respalda', 'competitive_physique_update/']) assert.ok(doc.includes(t), t);
  assert.ok(!fs.existsSync(path.join(root, 'competitive_physique_update')), 'the referenced knowledge pack is not versioned in this repository');
});

test('T521.2 (T523) no scientific claim was invented: the three decisions are closed as VDSEN PRODUCT POLICY, never as science', () => {
  const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));
  assert.ok(policy.PRODUCT_POLICIES.every(p => p.source === 'VDSEN_PRODUCT_POLICY' && p.scientificClaim === false));
  assert.deepEqual(policy.PRODUCT_POLICIES.map(p => p.resolves), ['RULE_D_E_ALTERNATIVE_NOT_DEFINED', 'RULE_C_E_PRECEDENCE_NOT_DEFINED', 'REPRESENTATIVE_SET_NOT_DEFINED']);
  assert.equal(policy.EVIDENCE_BASIS, 'VDSEN_PRODUCT_POLICY_LAST_WORKING_SET');
  assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
});

test('T521.3 the product decision package covers all three decisions with 3 options each and consequences', () => {
  const d = read('docs/PROGRESSION_PRODUCT_DECISIONS_PENDING.md');
  for (const t of ['## 1. RULE_D_E_ALTERNATIVE', '## 2. RULE_C_E_PRECEDENCE', '## 3. REPRESENTATIVE_SET', 'no son hechos científicos', 'Conservadurismo', 'Sobre-ajuste', 'Sub-ajuste', 'aplicación automática', 'Compatibilidad', 'Tests'])
    assert.ok(d.includes(t), t);
  for (const o of ['1A.', '1B.', '1C.', '2A.', '2B.', '2C.', '3A.', '3B.', '3C.']) assert.ok(d.includes('**' + o), o);
});

test('T521.4 simulator: deterministic, covers the four strategies, reports how often the choice changes direction/magnitude', () => {
  assert.equal(JSON.stringify(sim.simulate()), JSON.stringify(sim.simulate()));
  const s = sim.simulate();
  assert.deepEqual(sim.STRATEGIES, ['LAST_SET', 'WORST_SET', 'BEST_SET', 'MEAN']);
  assert.equal(s.total, 40); assert.equal(s.pairs.length, 6);
  const p = Object.fromEntries(s.pairs.map(x => [x.a + '/' + x.b, x]));
  assert.ok(p['LAST_SET/BEST_SET'].directionChanges > 0 && p['LAST_SET/BEST_SET'].magnitudeChanges > 0, 'the strategy choice matters');
  assert.ok(s.pairs.every(x => x.anyChange >= Math.max(x.directionChanges, x.dimensionChanges, x.magnitudeChanges, x.eligibilityChanges)));
});

test('T521.5 strategy selection is pure and puts the representative set last', () => {
  const sets = [{ reps: 10, rir: 3 }, { reps: 9, rir: 2 }, { reps: 7, rir: 0 }], frozen = JSON.stringify(sets);
  assert.deepEqual(sim.applyStrategy(sets, 'LAST_SET'), sets);
  assert.deepEqual(sim.applyStrategy(sets, 'WORST_SET').slice(-1)[0], { reps: 7, rir: 0 });
  assert.deepEqual(sim.applyStrategy(sets, 'BEST_SET').slice(-1)[0], { reps: 10, rir: 3 });
  assert.deepEqual(sim.applyStrategy(sets, 'MEAN').slice(-1)[0], { reps: 9, rir: 2 });
  assert.equal(JSON.stringify(sets), frozen);
});

test('T521.6 analysis only: nothing in the app or canonical modules references the simulator; the report is current', () => {
  for (const f of ['vdsen-cliente.html', 'vdsen-coach.html', 'assets/progression-magnitude-policy.js', 'assets/progression-auto-apply-shadow.js', 'assets/progression-application-consumer.js', 'sw.js'])
    assert.ok(!/simulate-representative-set|applyStrategy/.test(read(f)), f);
  assert.equal(spawnSync(process.execPath, [path.join(root, 'scripts/simulate-representative-set.cjs'), '--check']).status, 0, 'regenerate with: node scripts/simulate-representative-set.cjs');
});
