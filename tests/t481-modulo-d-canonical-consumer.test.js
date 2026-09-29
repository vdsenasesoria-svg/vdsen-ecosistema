// T481 (Auto-Apply Phase 2B): Modulo D becomes a consumer/view of canonical shadow decisions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));

function functionSource(source, name) {
  let start = source.indexOf('async function ' + name + '(');
  if (start < 0) start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let depth = 0, quote = null, escaped = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Cannot extract ' + name);
}
const ctx = {};
vm.createContext(ctx);
const escStart = coach.indexOf('  function _escH(s) {');
vm.runInContext(coach.slice(escStart, coach.indexOf('\n  }\n', escStart) + 4), ctx); // exact production _escH
['_moduloDCanonicalView', '_renderModuloDShadow'].forEach(n => vm.runInContext(functionSource(coach, n), ctx));
const viewSource = functionSource(coach, '_moduloDCanonicalView') + functionSource(coach, '_renderModuloDShadow');
const blockStart = coach.indexOf('// ── Módulo D — vista de decisiones shadow canónicas (T481).');
const block = coach.slice(blockStart, coach.indexOf('// ── Tendencias de carga por ejercicio'));

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const plan = { clientId: 'client-A', weeks: 6, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(di => ({
  dayIndex: di, exercises: ['pid-A', 'pid-B'].map(pid => ({ prescriptionExerciseId: pid, exerciseId: 'ex-' + pid, exerciseName: 'Remo',
    sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 100 })) })) })) };

// Build a canonical record through the real Phase 1 + 2A path (executed LOG entries -> buildRecord).
function record(pid, last, opts = {}) {
  const entries = {};
  [[1, 0], [1, 2]].forEach(([w, di]) => [0, 1, 2].forEach(s => {
    const isLast = s === 2 && di === 2;
    entries['log_' + w + '_' + di + '_0_s' + s] = Object.assign({ carga: '100', reps: '10', unit: 'KG', done: true, rir: 2,
      rir_real: 2, prescriptionExerciseId: pid, ts: T0 + di * 1000 + s }, isLast ? last : {});
  }));
  const rec = { prescriptionExerciseId: pid, exerciseId: 'ex-' + pid, exerciseName: opts.name || 'Remo',
    action: opts.action || 'increase_load', newLoad: opts.newLoad || 102.5, newReps: 10 };
  const r = shadow.buildRecord({ clientId: 'client-A', planId: 'plan-A', activePlanId: 'plan-A', plan, entries,
    week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z', recommendation: rec, sourceMatches: true,
    sourcePidCount: 1 }, opts.at || '2026-09-27T13:00:00.000Z');
  return r;
}
const view = (records, exercises, extra = {}) => ctx._moduloDCanonicalView(records,
  Object.assign({ clientId: 'client-A', planId: 'plan-A', week: 1, dayIndex: 2, exercises }, extra));
const ex = (pid, name = 'Remo', ei = 0) => ({ ei, name, pid, pidConflict: false });
const html = rows => ctx._renderModuloDShadow(rows, 1, 2);
const A_LOAD = { rir: 2, rir_real: 3 };

test('1-5. Modulo D block and view hold no numerical policy of their own', () => {
  for (const banned of [/rirDiff/, /nuevaCarga/, /nuevasReps/, /puedeAgregarSerie/, /\bfalt\b/, /carga\s*\*\s*\(/, /pctU|pctD/,
    /\*\s*2\.5/, /\*\s*5\b/, /\/\s*100/, /toFixed|Math\.round|Math\.max|Math\.min/, /tipo\s*===|'progresa'|'reduce'/])
    assert.ok(!banned.test(block) && !banned.test(viewSource), String(banned));
  assert.ok(!/regla\s*E[^']*-\s*2/i.test(block), 'no E-before-D arithmetic');
  assert.ok(!/rirObjetivo|repsTarget\s*[+-]|window\._moduloD/.test(block));
});

test('6. Rule C canonical magnitude shows +30 s rest first', () => {
  const r = record('pid-A', { reps: '9', rir_real: 2 });
  const out = html(view([r], [ex('pid-A')]));
  assert.ok(out.includes('+30 s descanso (primera intervención)'));
  assert.ok(!out.includes('Regla E ·'), 'E deferred');
  assert.ok(out.includes('CANDIDATO SHADOW · NO APLICADO'));
});

test('7. Rule D shows both unresolved alternatives', () => {
  const out = html(view([record('pid-A', { rir_real: 1 })], [ex('pid-A')]));
  assert.ok(out.includes('Rama sin resolver') && out.includes('no se elige entre reps y carga'));
  assert.ok(out.includes('reps 9') && out.includes('carga cruda 97.5'));
});

test('8. Rule E shows both unresolved alternatives', () => {
  const out = html(view([record('pid-A', { reps: '9', rir_real: '' })], [ex('pid-A')]));
  assert.ok(out.includes('Rama sin resolver'));
  assert.ok(out.includes('reps 8') && out.includes('carga cruda 95'));
});

test('9. Rule B shows Coach review only', () => {
  const r = record('pid-A', { reps: '12' });
  r.magnitude.coachReview = [{ code: 'COACH_REVIEW_VOLUME_INCREASE' }];
  const compact = Object.assign({}, r, { magnitude: policy.compact(r.magnitude) });
  const out = html(view([compact], [ex('pid-A')]));
  assert.ok(out.includes('COACH_REVIEW_VOLUME_INCREASE') && out.includes('no se agregan series automáticamente'));
  assert.ok(!/\+ ?SER|agregar serie/i.test(out));
});

test('10. missing canonical magnitude: no fallback arithmetic', () => {
  for (const records of [[], null, undefined, {}]) {
    const rows = view(records, [ex('pid-A')]);
    assert.equal(rows[0].status, 'NO_CANONICAL');
    const out = html(rows);
    assert.ok(out.includes('NO SHADOW CANDIDATE / INSUFFICIENT CANONICAL EVIDENCE'));
    assert.ok(!out.includes('CANDIDATO SHADOW') && !/carga cruda|reps \d/.test(out));
  }
  const legacy = record('pid-A', A_LOAD); delete legacy.magnitude;
  assert.equal(view([legacy], [ex('pid-A')])[0].status, 'NO_CANONICAL', 'pre-2A record without magnitude');
});

test('11. same visible name, different PID: exact canonical record per PID', () => {
  const a = record('pid-A', A_LOAD, { name: 'Remo' }), b = record('pid-B', { rir_real: 1 }, { name: 'Remo' });
  const rows = view([a, b], [ex('pid-A', 'Remo', 0), ex('pid-B', 'Remo', 1)]);
  assert.equal(rows[0].record.prescriptionExerciseId, 'pid-A'); assert.equal(rows[1].record.prescriptionExerciseId, 'pid-B');
  assert.equal(rows[0].record.magnitude.ruleId, 'A'); assert.equal(rows[1].record.magnitude.ruleId, 'D');
  const stranger = view([record('pid-C', A_LOAD, { name: 'Remo' })], [ex('pid-A')]);
  assert.equal(stranger[0].status, 'NO_CANONICAL', 'a same-name record of another PID is never attached');
});

test('12. duplicate/conflicting PID: safe rejection, no candidate', () => {
  const r = record('pid-A', A_LOAD);
  const dup = view([r], [ex('pid-A', 'Remo', 0), ex('pid-A', 'Remo', 1)]);
  assert.deepEqual(dup.map(x => x.status), ['DUPLICATE_PID', 'DUPLICATE_PID']);
  assert.ok(!html(dup).includes('CANDIDATO SHADOW'));
  const conflict = view([r], [{ ei: 0, name: 'Remo', pid: '', pidConflict: true }]);
  assert.equal(conflict[0].status, 'PID_CONFLICT');
  assert.ok(html(conflict).includes('CONFLICTO DE PID') && !html(conflict).includes('CANDIDATO SHADOW'));
});

test('13. STALE record is not a usable candidate', () => {
  const stale = shadow.markStale(record('pid-A', A_LOAD), 'PLAN_CHANGED', '2026-09-27T14:00:00.000Z');
  const rows = view([stale], [ex('pid-A')]);
  assert.equal(rows[0].status, 'STALE');
  const out = html(rows);
  assert.ok(out.includes('OBSOLETA') && out.includes('no es un candidato utilizable'));
  assert.ok(!out.includes('CANDIDATO SHADOW') && !out.includes('carga cruda'));
});

test('14. REJECTED record is not a usable candidate', () => {
  const pending = record('pid-A', A_LOAD);
  const kept = shadow.transition(pending, 'KEEP_ORIGINAL', 1, 'op-1', '2026-09-27T14:00:00.000Z', 'coach-A').record;
  const rows = view([kept], [ex('pid-A')]);
  assert.equal(rows[0].status, 'REJECTED');
  const out = html(rows);
  assert.ok(out.includes('RECHAZADA') && out.includes('no es un candidato utilizable') && !out.includes('carga cruda'));
  const bad = record('pid-B', A_LOAD); // wrong PID in a PID-A slot
  assert.equal(shadow.buildRecord({ clientId: 'client-A', planId: 'plan-A', activePlanId: 'plan-A', plan, week: 1, dayIndex: 2,
    calculatedAt: '2026-09-27T12:00:00.000Z', recommendation: { prescriptionExerciseId: 'pid-Z', action: 'increase_load', newLoad: 1 },
    sourceMatches: true, sourcePidCount: 1 }, 'x').state, 'REJECTED');
  assert.ok(bad);
});

test('15. PENDING shadow is clearly labelled NOT APPLIED with full provenance', () => {
  const out = html(view([record('pid-A', A_LOAD)], [ex('pid-A')]));
  for (const text of ['CANDIDATO SHADOW · NO APLICADO', 'EHRENSTEIN_APEKS_DERIVED', 'nivel C', 'RIR prescrito 2 · observado 3',
    'reps objetivo 10 · ejecutadas 10', 'Exposiciones comparables: 2', 'Regla A', 'carga cruda 102.5 (final: —)',
    'EQUIPMENT_INCREMENT_POLICY_MISSING', 'Bloqueos de activación: NUMERIC_ACTIVATION_DISABLED', 'próxima exposición: Sem 2 · Día 1',
    'PID pid-A'])
    assert.ok(out.includes(text), text);
  assert.ok(out.includes('Shadow / no aplicado') && !/Aplicar ajustes/.test(out));
});

test('16. legacy action/newLoad disagreeing with magnitude: Modulo D follows record.magnitude', () => {
  const r = record('pid-A', A_LOAD, { action: 'reduce_load', newLoad: 50 });
  assert.equal(r.action, 'reduce_load');
  const out = html(view([r], [ex('pid-A')]));
  assert.ok(out.includes('carga cruda 102.5'));
  assert.ok(!out.includes('reduce_load') && !/\b50\b/.test(out), 'legacy signal is not rendered');
  assert.ok(!/\.action|newLoad|newReps/.test(viewSource + block));
});

test('17. numeric apply stays disabled', () => {
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false); assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
  assert.equal(record('pid-A', A_LOAD).magnitude.numericApplyAllowed, false);
});

test('18. Modulo D cannot write to plans/', () => {
  const apply = functionSource(coach, '_applyAllModuloD');
  assert.ok(!/updateDoc|setDoc|addDoc|getDoc|runTransaction|tx\.|batch|plans/.test(apply), 'apply path is inert');
  assert.ok(!/updateDoc|setDoc|addDoc|runTransaction|'plans'|"plans"|onclick=/.test(block + viewSource));
  assert.ok(!coach.includes('onclick="_applyAllModuloD()"') && !coach.includes('Aplicar ajustes al plan</button>'));
  assert.ok(coach.includes('Shadow / no aplicado'));
});

test('19. views are pure: frozen plan and records are never mutated (vdsen-plan-v2 untouched)', () => {
  const deepFreeze = o => { Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
  const r = deepFreeze(record('pid-A', A_LOAD)), frozenPlan = deepFreeze(structuredClone(plan));
  assert.doesNotThrow(() => html(view([r], [ex('pid-A')])));
  assert.deepEqual(frozenPlan, plan);
});

test('20/21. Coach KEEP and REVERT keep their canonical transaction authority (not duplicated in Modulo D)', () => {
  const action = functionSource(coach, '_onShadowAutoAction');
  assert.ok(action.includes('runTransaction') && action.includes('shadow.transition(record, action, expectedRevision, operationKey, at, actorId)'));
  assert.ok(action.includes("action === 'KEEP_ORIGINAL' ? 'KEEP' : 'NO_CHANGE'"));
  assert.ok(!/data-shadow-action|shadow\.transition|runTransaction/.test(block + viewSource), 'no second implementation');
  const pending = record('pid-A', A_LOAD);
  const kept = shadow.transition(pending, 'KEEP_ORIGINAL', 1, 'k1', '2026-09-27T14:00:00.000Z', 'coach').record;
  assert.equal(kept.state, 'REJECTED'); assert.equal(kept.reasonCode, 'COACH_KEEP_ORIGINAL');
  const back = shadow.transition(kept, 'REVERT_DECISION', kept.revision, 'r1', '2026-09-27T15:00:00.000Z', 'coach').record;
  assert.equal(back.state, 'PENDING'); assert.equal(back.reasonCode, 'MAGNITUDE_POLICY_MISSING');
  assert.equal(shadow.transition(pending, 'KEEP_ORIGINAL', 99, 'k2', 'x', 'c').reasonCode, 'REVISION_CONFLICT');
});

test('22/23. no name fallback and no position-only identity authority', () => {
  assert.ok(!/exerciseName|toLowerCase|\.name\s*===|nombre/i.test(functionSource(coach, '_moduloDCanonicalView')));
  assert.ok(!/p\.days\[lastDoneD\]/.test(block), 'positional day fallback removed');
  const r = record('pid-A', A_LOAD);
  const unlogged = view([r], [{ ei: 0, name: 'Remo', pid: '', pidConflict: false }]);
  assert.equal(unlogged[0].status, 'NO_PID', 'the slot index alone never resolves a canonical record');
  assert.ok(html(unlogged).includes('SIN PID VERIFICABLE'));
  assert.ok(block.includes('s.prescriptionExerciseId'), 'identity comes from the PID snapshotted in the executed sets');
  const moved = view([r], [ex('pid-A', 'Otro nombre', 7)]);
  assert.equal(moved[0].status, 'PENDING', 'PID matches regardless of name and position');
  const otherSource = view([r], [ex('pid-A')], { week: 1, dayIndex: 0 });
  assert.equal(otherSource[0].status, 'NO_CANONICAL', 'only the session being shown');
  assert.equal(view([r], [ex('pid-A')], { planId: 'plan-B' })[0].status, 'NO_CANONICAL');
  assert.equal(view([r], [ex('pid-A')], { clientId: 'client-B' })[0].status, 'NO_CANONICAL');
});

test('24/25. competitive, enhanced and PED labels do not change the displayed magnitude', () => {
  const base = html(view([record('pid-A', A_LOAD)], [ex('pid-A')]));
  for (const extra of [{ competitive: true }, { enhanced: true }, { ped: true }]) {
    const entries = {};
    const r = shadow.buildRecord(Object.assign({ clientId: 'client-A', planId: 'plan-A', activePlanId: 'plan-A', plan, entries,
      week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
      recommendation: { prescriptionExerciseId: 'pid-A', exerciseId: 'ex-pid-A', action: 'increase_load', newLoad: 102.5 } }, extra), 'x');
    assert.ok(r.magnitude.numericApplyAllowed === false);
  }
  const twice = html(view([record('pid-A', A_LOAD)], [ex('pid-A')]));
  assert.equal(twice, base);
  assert.ok(!/competitive|enhanced|\bped\b|competitiv/i.test(viewSource + block));
});

test('wiring: Monitor loads the full canonical records and falls back to the compact summary only', () => {
  assert.ok(coach.includes("getDoc(doc(db, 'logs', clientId, 'mesos', c.activePlanId))"));
  assert.ok(coach.includes('_canonicalRecords || (autoSummary && autoSummary.items) || []'));
  const compactRec = record('pid-A', A_LOAD);
  const asSummary = shadow.summarize({ [compactRec.key]: compactRec }, 'plan-A').items;
  const rows = view(asSummary, [ex('pid-A')]);
  assert.equal(rows[0].status, 'PENDING');
  const out = html(rows);
  assert.ok(out.includes('RIR prescrito 2 · observado 3') && out.includes('Bloqueos de activación: NUMERIC_ACTIVATION_DISABLED'));
});
