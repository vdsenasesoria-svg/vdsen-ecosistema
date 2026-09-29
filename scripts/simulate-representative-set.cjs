#!/usr/bin/env node
// T521: ANALYSIS-ONLY simulator. Compares how the canonical magnitude policy's outcome changes under plausible
// representative-set strategies for an exposure. It selects NO policy and is NOT connected to any runtime path:
//   LAST_SET  - the set the current runtime heuristic uses (last executed set of the latest exposure)
//   WORST_SET - the set with the largest rep shortfall, then the lowest RIR headroom (hardest)
//   BEST_SET  - the set with the smallest rep shortfall, then the highest RIR headroom (easiest)
//   MEAN      - integer-rounded mean of reps / observed RIR / load across the sets (the frozen legacy v3.1 engine averages sets)
// Fixtures are synthetic and deterministic.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const shadow = require(path.join(repo, 'assets/progression-auto-apply-shadow.js'));

const STRATEGIES = ['LAST_SET', 'WORST_SET', 'BEST_SET', 'MEAN'];
const PID = 'pid-sim', T0 = Date.parse('2026-09-27T12:00:00.000Z'), TARGET_REPS = 10, TARGET_RIR = 2;
const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [
  { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Sim', sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: TARGET_REPS, rirTarget: TARGET_RIR, restSeconds: 90 })) }] })) };
const round = n => Math.floor(n + 0.5);

// sets: [{reps, rir}] of the LATEST exposure -> the same sets re-ordered / replaced so the representative is the LAST one.
function applyStrategy(sets, strategy) {
  const score = s => [Math.max(0, TARGET_REPS - s.reps), -(s.rir - TARGET_RIR)]; // higher = harder
  const cmp = (a, b) => { const x = score(a), y = score(b); return x[0] - y[0] || x[1] - y[1]; };
  if (strategy === 'LAST_SET') return sets.slice();
  if (strategy === 'MEAN') {
    const m = k => round(sets.reduce((n, s) => n + s[k], 0) / sets.length);
    return sets.slice(0, -1).concat([{ reps: m('reps'), rir: m('rir') }]);
  }
  const idx = sets.map((s, i) => [s, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]);
  const pick = (strategy === 'WORST_SET' ? idx[idx.length - 1] : idx[0]);
  return sets.filter((_, i) => i !== pick[1]).concat([pick[0]]);
}

function decide(prior, latest, strategy) {
  const entries = {};
  const put = (w, d, sets) => sets.forEach((s, i) => { entries['log_' + w + '_' + d + '_0_s' + i] = { carga: '100', reps: String(s.reps), unit: 'KG', done: true, rir: TARGET_RIR, rir_real: s.rir,
    prescriptionExerciseId: PID, ts: T0 + d * 1000 + i }; });
  put(1, 0, applyStrategy(prior, strategy)); put(1, 2, applyStrategy(latest, strategy));
  const rec = shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries, week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
    recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Sim', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
  const m = rec.magnitude, c = (m.candidates || [])[0] || null;
  return { eligible: m.eligible === true, direction: m.direction || 'NONE', rule: m.ruleId || null, dimension: m.dimension || null, unresolved: !!m.unresolved,
    raw: c ? c.rawCandidate : null };
}

// Deterministic fixtures: per-set (reps, rir) patterns of the latest exposure; the prior exposure is either the same pattern
// (consistent history) or a neutral one (no confirmation).
const REPS = { steady: [10, 10, 10], fading: [10, 9, 8], lastMiss: [10, 10, 8], short: [8, 8, 8] };
const RIRS = { easy: [3, 3, 3], drifting: [3, 2, 1], onTarget: [2, 2, 2], grinding: [2, 1, 0], lateEasy: [1, 1, 3] };
function fixtures() {
  const out = [];
  Object.entries(REPS).forEach(([rn, reps]) => Object.entries(RIRS).forEach(([xn, rirs]) => {
    const latest = reps.map((r, i) => ({ reps: r, rir: rirs[i] }));
    out.push({ name: rn + ' reps / ' + xn + ' RIR', prior: 'same', prev: latest, latest });
    out.push({ name: rn + ' reps / ' + xn + ' RIR', prior: 'neutral', prev: [0, 1, 2].map(() => ({ reps: TARGET_REPS, rir: TARGET_RIR })), latest });
  }));
  return out;
}

function simulate() {
  const rows = fixtures().map(f => Object.assign({}, f, { results: Object.fromEntries(STRATEGIES.map(s => [s, decide(f.prev, f.latest, s)])) }));
  const pairs = [];
  for (let i = 0; i < STRATEGIES.length; i++) for (let j = i + 1; j < STRATEGIES.length; j++) {
    const a = STRATEGIES[i], b = STRATEGIES[j];
    let dir = 0, dim = 0, mag = 0, elig = 0, any = 0;
    rows.forEach(r => {
      const x = r.results[a], y = r.results[b];
      const d = x.direction !== y.direction, m = x.dimension !== y.dimension, g = x.raw !== y.raw, e = x.eligible !== y.eligible;
      if (d) dir++; if (m) dim++; if (g) mag++; if (e) elig++; if (d || m || g || e) any++;
    });
    pairs.push({ a, b, total: rows.length, directionChanges: dir, dimensionChanges: dim, magnitudeChanges: mag, eligibilityChanges: elig, anyChange: any });
  }
  const perStrategy = STRATEGIES.map(s => ({ strategy: s, eligible: rows.filter(r => r.results[s].eligible).length, unresolved: rows.filter(r => r.results[s].unresolved).length,
    up: rows.filter(r => r.results[s].direction === 'UP').length, down: rows.filter(r => r.results[s].direction === 'DOWN').length,
    rest: rows.filter(r => r.results[s].direction === 'REST').length }));
  return { total: rows.length, rows, pairs, perStrategy };
}

function render(sim) {
  const pct = (n, t) => (100 * n / t).toFixed(0) + '%';
  const L = ['# Simulación de serie representativa (solo análisis)', '',
    'Generado por `node scripts/simulate-representative-set.cjs` con fixtures sintéticos deterministas. **No selecciona ninguna política y no está conectado al runtime.**',
    'Objetivo de la fixture: 10 reps @ RIR 2. Estrategias: LAST_SET (heurística actual), WORST_SET (mayor falta de reps y menor margen RIR), BEST_SET (lo contrario),',
    'MEAN (promedio redondeado de reps y RIR observado; el motor legado v3.1 promedia las series).', '',
    '- Exposiciones sintéticas: **' + sim.total + '** (20 patrones × historial previo igual / neutro)', '',
    '## Resultado por estrategia', '', '| Estrategia | Elegibles | Sin resolver | Dirección UP | DOWN | REST |', '|---|---|---|---|---|---|'];
  sim.perStrategy.forEach(s => L.push('| ' + [s.strategy, s.eligible, s.unresolved, s.up, s.down, s.rest].join(' | ') + ' |'));
  L.push('', '## Cuánto cambia la elección de estrategia el resultado', '', '| Par | Cambia dirección | Cambia dimensión | Cambia magnitud | Cambia elegibilidad | Cualquier cambio |', '|---|---|---|---|---|---|');
  sim.pairs.forEach(p => L.push('| ' + [p.a + ' vs ' + p.b, p.directionChanges + ' (' + pct(p.directionChanges, p.total) + ')', p.dimensionChanges + ' (' + pct(p.dimensionChanges, p.total) + ')',
    p.magnitudeChanges + ' (' + pct(p.magnitudeChanges, p.total) + ')', p.eligibilityChanges + ' (' + pct(p.eligibilityChanges, p.total) + ')', p.anyChange + ' (' + pct(p.anyChange, p.total) + ')'].join(' | ') + ' |'));
  L.push('', '## Detalle (historial previo igual)', '', '| Patrón | LAST | WORST | BEST | MEAN |', '|---|---|---|---|---|');
  const cell = r => (r.eligible ? '' : 'no-elegible · ') + r.direction + (r.rule ? ' ' + r.rule : '') + (r.raw !== null ? ' → ' + r.raw : '');
  sim.rows.filter(r => r.prior === 'same').forEach(r => L.push('| ' + [r.name].concat(STRATEGIES.map(s => cell(r.results[s]))).join(' | ') + ' |'));
  L.push('');
  return L.join('\n');
}

module.exports = { STRATEGIES, applyStrategy, decide, fixtures, simulate, render };
if (require.main === module) {
  const target = path.join(repo, 'docs', 'REPRESENTATIVE_SET_SIMULATION.md'), out = render(simulate());
  if (process.argv.includes('--check')) process.exit(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === out ? 0 : 1);
  fs.writeFileSync(target, out); console.log('wrote docs/REPRESENTATIVE_SET_SIMULATION.md');
}
