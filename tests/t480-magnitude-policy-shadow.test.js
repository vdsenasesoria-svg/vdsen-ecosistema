// T480 (Auto-Apply Phase 2A): Ehrenstein/APEKS-derived magnitude policy in SHADOW mode.
// Pure policy tests + integration through the Phase 1 shadow record. No network, no Firestore.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const client = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const policySource = fs.readFileSync(path.join(root, 'assets/progression-magnitude-policy.js'), 'utf8');

const PID = 'pid-A';
const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const plan = { clientId: 'client-A', weeks: 6, updatedAt: '2026-09-26T00:00:00.000Z', days: [
  { dayIndex: 0, exercises: [{ prescriptionExerciseId: PID, exerciseId: 'ex-A', exerciseName: 'Remo',
    sets: [1, 2, 3].map(i => ({ setIndex: i - 1, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 100 })) }] },
  { dayIndex: 2, exercises: [{ prescriptionExerciseId: PID, exerciseId: 'ex-A', exerciseName: 'Remo',
    sets: [1, 2, 3].map(i => ({ setIndex: i - 1, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 100 })) }] }
] };
const prescription = { prescriptionExerciseId: PID, repsRange: { min: 8, max: 12 }, sets: plan.days[0].exercises[0].sets };

// One exposure = 3 sets. `last` overrides the last set; `first` the first two.
function exposure(week, dayIndex, last, first, opts = {}) {
  const base = { prescriptionExerciseId: PID, planId: 'plan-A', clientId: 'client-A', week, dayIndex, exerciseIndex: 0 };
  const mk = (i, o) => Object.assign({ setIndex: i, load: 100, reps: 10, unit: 'KG', done: true, rirPrescribed: 2,
    rirReal: 2, autoFilled: false, express: false, ts: T0 + week * 86400000 + dayIndex * 3600000 + i }, o);
  return Object.assign(base, { sets: [mk(0, first), mk(1, first), mk(2, last)] }, opts);
}
function run(exposures, extra = {}) {
  return policy.evaluate(Object.assign({ clientId: 'client-A', planId: 'plan-A', prescriptionExerciseId: PID,
    plan, prescription, exposures, context: {} }, extra));
}
const two = (last, first) => [exposure(1, 0, { rirReal: 2 }), exposure(1, 2, last, first)];
const raw = (d, dim) => d.candidates.find(c => c.dimension === dim);

test('1. RIR +1 with target RIR 1 -> +1 rep inside the range (shadow)', () => {
  const d = run(two({ rirPrescribed: 1, rirReal: 2, reps: 10 }, { rirPrescribed: 1 }));
  assert.equal(d.ruleId, 'A'); assert.equal(d.dimension, 'REPS');
  assert.equal(raw(d, 'REPS').rawCandidate, 11); assert.equal(raw(d, 'REPS').finalCandidate, 11);
  assert.equal(d.eligible, true); assert.equal(d.actionable, false);
});

test('2. RIR +1 with target RIR >= 2 -> +2.5% raw load; +2 RIR -> +5%', () => {
  const d = run(two({ rirPrescribed: 2, rirReal: 3 }));
  assert.equal(d.ruleId, 'A'); assert.equal(d.dimension, 'LOAD');
  assert.equal(raw(d, 'LOAD').rawCandidate, 102.5);
  assert.equal(run(two({ rirPrescribed: 2, rirReal: 4 })).candidates[0].rawCandidate, 105);
  assert.equal(run(two({ rirPrescribed: 3, rirReal: 4 })).candidates[0].rawCandidate, 102.5);
});

test('3. RIR harder than prescribed -> both source alternatives, no arbitrary choice', () => {
  const d = run(two({ rirPrescribed: 2, rirReal: 1 }));
  assert.equal(d.ruleId, 'D'); assert.equal(d.eligible, false);
  assert.equal(d.unresolved.code, 'POLICY_BRANCH_REQUIRES_RESOLUTION');
  assert.equal(raw(d, 'REPS').rawCandidate, 9); assert.equal(raw(d, 'LOAD').rawCandidate, 97.5);
  assert.equal(run(two({ rirPrescribed: 2, rirReal: 0 })).candidates.find(c => c.dimension === 'LOAD').rawCandidate, 95);
  assert.equal(d.dimension, null, 'no dimension chosen for an alternative');
});

test('4. incomplete reps (RIR evidence absent) -> -2 reps OR -5% per missing rep, unresolved', () => {
  const d = run(two({ reps: 9, rirReal: '' }));
  assert.equal(d.ruleId, 'E'); assert.equal(d.eligible, false);
  assert.equal(raw(d, 'REPS').rawCandidate, 8); assert.equal(raw(d, 'LOAD').rawCandidate, 95);
  assert.equal(d.unresolved.code, 'POLICY_BRANCH_REQUIRES_RESOLUTION');
  const two2 = run(two({ reps: 8, rirReal: '' }));
  assert.equal(raw(two2, 'LOAD').rawCandidate, 90);
  assert.equal(raw(two2, 'REPS').rawCandidate, 6);
  assert.equal(raw(two2, 'REPS').boundState, 'REP_RANGE_LOWER_BOUND');
});

test('5. correct RIR + incomplete reps -> +30 s rest first; E not combined', () => {
  const d = run(two({ reps: 9, rirReal: 2 }));
  assert.equal(d.ruleId, 'C'); assert.equal(d.dimension, 'REST');
  assert.equal(d.candidates[0].deltaSeconds, 30); assert.equal(d.candidates[0].rawCandidate, 120);
  assert.equal(d.collision.classification, 'AMBIGUOUS');
  assert.deepEqual(d.collision.rules, ['C', 'E']); assert.equal(d.collision.runtimeOrder, 'E_BEFORE_C');
  assert.ok(!d.candidates.some(c => c.ruleId === 'E'));
  assert.equal(d.eligible, true);
});

test('6. Rule B evidence -> Coach review only; never a volume candidate', () => {
  const d = run(two({ reps: 12 }, { reps: 12 }));
  assert.deepEqual(d.coachReview.map(r => r.code), ['COACH_REVIEW_VOLUME_INCREASE']);
  assert.equal(d.coachReview[0].autoApplyAllowed, false);
  assert.ok(!d.candidates.some(c => /VOLUME|SETS/.test(c.dimension)));
  const one = run(two({ reps: 12 }, { reps: 10 }));
  assert.deepEqual(one.coachReview, [], 'both of the last 2 sets must exceed target by 2');
});

test('7. one comparable exposure -> not eligible', () => {
  const d = run([exposure(1, 0, { rirPrescribed: 2, rirReal: 3 })]);
  assert.equal(d.comparableExposureCount, 1); assert.equal(d.eligible, false);
  assert.ok(d.reasonCodes.includes('INSUFFICIENT_COMPARABLE_EXPOSURES'));
  assert.equal(raw(d, 'LOAD').rawCandidate, 102.5, 'raw candidate is still computed in shadow');
  assert.equal(run([]).comparableExposureCount, 0);
});

test('8. two comparable exposures -> evidence threshold satisfied', () => {
  const d = run(two({ rirReal: 3 }));
  assert.equal(d.comparableExposureCount, 2); assert.equal(d.eligible, true);
  assert.ok(!d.reasonCodes.includes('INSUFFICIENT_COMPARABLE_EXPOSURES'));
});

test('9. PID mismatch is rejected', () => {
  const alien = two({ rirReal: 3 }).map(x => Object.assign({}, x, { prescriptionExerciseId: 'pid-B' }));
  const d = run(alien);
  assert.equal(d.comparableExposureCount, 0);
  assert.ok(d.excludedExposures.every(x => x.reason === 'PID_MISMATCH'));
  assert.equal(policy.evaluate({ prescriptionExerciseId: PID, plan, exposures: [],
    prescription: { prescriptionExerciseId: 'pid-B', sets: [] } }).reasonCodes[0], 'IDENTITY_CONFLICT');
  assert.equal(run(two({ rirReal: 3 }), { context: { identityConflict: true } }).reasonCodes[0], 'IDENTITY_CONFLICT');
  const cross = two({ rirReal: 3 }).map(x => Object.assign({}, x, { planId: 'plan-B' }));
  assert.equal(run(cross).excludedExposures[0].reason, 'PLAN_MISMATCH');
  const otherClient = two({ rirReal: 3 }).map(x => Object.assign({}, x, { clientId: 'client-B' }));
  assert.equal(run(otherClient).excludedExposures[0].reason, 'CLIENT_MISMATCH');
  // position is not identity: same slot, different PID snapshot
  const entries = {};
  ['log_1_0_0_s0', 'log_1_0_0_s1'].forEach(k => { entries[k] = { carga: '100', reps: '10', done: true, prescriptionExerciseId: 'pid-B' }; });
  assert.equal(policy.extractExposures(entries, PID).length, 0);
});

test('10. stale recommendation is rejected (context and Phase 1 record)', () => {
  assert.equal(run(two({ rirReal: 3 }), { context: { stale: true } }).reasonCodes[0], 'STALE');
  const rec = { prescriptionExerciseId: PID, exerciseId: 'ex-A', exerciseName: 'Remo', action: 'increase_load', newLoad: 102.5 };
  const base = { clientId: 'client-A', planId: 'plan-A', activePlanId: 'plan-A', week: 1, dayIndex: 0,
    calculatedAt: '2026-09-27T12:00:00.000Z', recommendation: rec, plan, sourceMatches: true, sourcePidCount: 1 };
  const stale = shadow.buildRecord(Object.assign({}, base, { plan: Object.assign({}, plan, { updatedAt: '2026-09-28T00:00:00.000Z' }) }), '2026-09-27T13:00:00.000Z');
  assert.equal(stale.state, 'STALE');
  assert.deepEqual(stale.magnitude.reasonCodes, ['PLAN_CHANGED']); assert.equal(stale.magnitude.eligible, false);
  assert.equal(stale.magnitude.candidates.length, 0);
});

test('11. Coach override is rejected (context and Phase 1 record)', () => {
  assert.equal(run(two({ rirReal: 3 }), { context: { coachOverride: true } }).reasonCodes[0], 'COACH_OVERRIDE');
  const rec = { prescriptionExerciseId: PID, exerciseId: 'ex-A', action: 'increase_load', newLoad: 102.5 };
  const r = shadow.buildRecord({ clientId: 'client-A', planId: 'plan-A', activePlanId: 'plan-A', week: 1, dayIndex: 0,
    calculatedAt: '2026-09-27T12:00:00.000Z', recommendation: rec, plan, sourceMatches: true, sourcePidCount: 1,
    interventions: [{ targetType: 'EXERCISE', targetId: PID, planId: 'plan-A', action: 'KEEP', decidedAt: '2026-09-27T12:01:00.000Z' }] },
  '2026-09-27T13:00:00.000Z');
  assert.equal(r.state, 'STALE'); assert.equal(r.magnitude.reasonCodes[0], 'COACH_OVERRIDE');
});

test('12. autoFilled (and express) evidence is ignored', () => {
  const auto = [exposure(1, 0, { autoFilled: true, rirReal: 3 }, { autoFilled: true }),
    exposure(1, 2, { autoFilled: true, rirReal: 3 }, { autoFilled: true })];
  const d = run(auto);
  assert.equal(d.comparableExposureCount, 0); assert.ok(d.excludedExposures.every(x => x.reason === 'AUTOFILLED_EVIDENCE'));
  const mixed = run([exposure(1, 0, { rirReal: 2 }), exposure(1, 2, { autoFilled: true, rirReal: 3 }, { autoFilled: true })]);
  assert.equal(mixed.comparableExposureCount, 1);
  const express = run([exposure(1, 0, { express: true }, { express: true })]);
  assert.equal(express.excludedExposures[0].reason, 'EXPRESS_EVIDENCE');
  assert.equal(run([exposure(1, 0, { reps: 'x' }, { reps: '' })]).excludedExposures[0].reason, 'INVALID_EVIDENCE');
  assert.equal(run([exposure(1, 0, { done: false }, { done: false })]).comparableExposureCount, 0);
});

test('13. rep bounds never expand the prescribed range', () => {
  const up = run(two({ rirPrescribed: 1, rirReal: 2, reps: 12 }, { rirPrescribed: 1, reps: 12 }),
    { prescription: Object.assign({}, prescription, { sets: prescription.sets.map(s => Object.assign({}, s, { repsTarget: 12 })) }) });
  const c = raw(up, 'REPS');
  assert.equal(c.rawCandidate, 13); assert.equal(c.finalCandidate, null); assert.equal(c.boundState, 'REP_RANGE_UPPER_BOUND');
  assert.equal(up.eligible, false); assert.ok(up.reasonCodes.includes('REP_RANGE_UPPER_BOUND'));
  assert.deepEqual(prescription.repsRange, { min: 8, max: 12 }, 'range untouched');
  // No explicit range: derived from the prescribed sets; a single repsTarget means no headroom.
  const noRange = run(two({ rirPrescribed: 1, rirReal: 2 }, { rirPrescribed: 1 }),
    { prescription: { prescriptionExerciseId: PID, sets: prescription.sets } });
  assert.equal(raw(noRange, 'REPS').boundState, 'REP_RANGE_UPPER_BOUND');
  const derived = run(two({ rirPrescribed: 1, rirReal: 2 }, { rirPrescribed: 1 }),
    { prescription: { prescriptionExerciseId: PID, sets: [8, 10, 12].map((r, i) => ({ setIndex: i, repsTarget: r, rirTarget: 1 })) } });
  assert.equal(derived.evidence.repsTarget, 12);
});

test('14. missing equipment increment -> raw load exists, final actionable load blocked', () => {
  const d = run(two({ rirReal: 3 }));
  const c = raw(d, 'LOAD');
  assert.equal(c.rawCandidate, 102.5); assert.equal(c.finalCandidate, null);
  assert.deepEqual(c.blockers, ['EQUIPMENT_INCREMENT_POLICY_MISSING']);
  assert.ok(d.reasonCodes.includes('EQUIPMENT_INCREMENT_POLICY_MISSING'));
  assert.equal(d.actionable, false); assert.equal(d.eligible, true);
  assert.equal(run(two({ rirReal: 3 }), { context: { equipmentIncrement: 2.5 } }).candidates[0].finalCandidate, null,
    'no increment contract exists: a supplied value is not invented into a policy');
  const noLoad = run(two({ rirReal: 3, load: 0 }));
  assert.deepEqual(raw(noLoad, 'LOAD').blockers, ['NO_LOAD_BASE']); assert.equal(noLoad.eligible, false);
  assert.ok(!/Math\.round\(.*\/ *(step|inc)/.test(policySource), 'no equipment rounding in the policy');
});

test('15/16. competitive, enhanced and PED labels do not change the base microdecision', () => {
  const evidence = two({ rirReal: 3 });
  const base = run(evidence);
  for (const context of [{ competitive: true }, { enhanced: true }, { ped: true }, { competitive: true, enhanced: true, ped: true }])
    assert.deepEqual(run(evidence, { context }), base);
  assert.equal(base.candidates[0].rawCandidate, 102.5, 'magnitude never amplified');
  const veto = run(evidence, { context: { competitive: true, readinessVeto: true } });
  assert.equal(veto.eligible, false); assert.ok(veto.reasonCodes.includes('READINESS_VETO'));
  assert.equal(veto.candidates[0].rawCandidate, 102.5, 'a veto may reduce eligibility, never magnitude');
  assert.ok(!/ctx\.(competitive|enhanced|ped)/i.test(policySource), 'policy never reads those labels');
});

test('17. numeric apply stays disabled everywhere', () => {
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false); assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
  assert.deepEqual(shadow.attemptNumericApply(), { ok: false, reasonCode: 'MAGNITUDE_POLICY_MISSING', applied: false });
  for (const d of [run(two({ rirReal: 3 })), run(two({ reps: 9 })), run(two({ rirReal: 1 })), run([])]) {
    assert.equal(d.numericApplyAllowed, false); assert.equal(d.applied, false); assert.equal(d.actionable, false);
    assert.equal(d.mode, 'SHADOW'); assert.ok(d.activationBlockers.includes('NUMERIC_ACTIVATION_DISABLED'));
  }
  assert.ok(!('APPLIED' in shadow.STATES));
});

test('18/19. policy is pure: no plan mutation, no I/O, plan document unchanged', () => {
  const frozen = JSON.parse(JSON.stringify({ plan, prescription, exposures: two({ rirReal: 3 }) }));
  const deepFreeze = o => { Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
  deepFreeze(frozen);
  assert.doesNotThrow(() => policy.evaluate({ clientId: 'client-A', planId: 'plan-A', prescriptionExerciseId: PID,
    plan: frozen.plan, prescription: frozen.prescription, exposures: frozen.exposures, context: {} }));
  assert.ok(!/plans|firestore|firebase|fetch\(|XMLHttpRequest|localStorage|Date\.now|new Date\(/i.test(policySource.replace(/\/\*[\s\S]*?\*\//, '')),
    'no I/O, storage or clock in the policy');
  assert.ok(!/vdsen-plan-v2/.test(policySource.replace(/\/\*[\s\S]*?\*\//, '')));
  assert.deepEqual(plan.days[0].exercises[0].sets[0], { setIndex: 0, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 100 });
});

test('20. shadow record carries explicit provenance and is labelled not-applied in Coach', () => {
  const d = run(two({ rirReal: 3 }));
  assert.equal(d.methodologyFamily, 'EHRENSTEIN_APEKS_DERIVED');
  assert.equal(d.ruleAuthority, 'VDSEN_HEURISTIC'); assert.equal(d.evidenceLevel, 'C');
  assert.deepEqual(policy.PROVENANCE, { methodologyFamily: 'EHRENSTEIN_APEKS_DERIVED', ruleAuthority: 'VDSEN_HEURISTIC', evidenceLevel: 'C' });
  assert.ok(coach.includes('CANDIDATO SHADOW · NO APLICADO') && coach.includes('prescripción original intacta'));
  assert.ok(coach.includes("item.state === 'PENDING' ? item.magnitude : null"), 'only live PENDING candidates are shown');
  for (const field of ['rirPrescribed', 'rirObserved', 'repsTarget', 'repsExecuted', 'basis'])
    assert.ok(field in d.evidence, field);
  assert.ok('comparableExposureCount' in d && 'unresolved' in d && 'collision' in d);
});

test('exposure extraction: identity by snapshotted PID, sorted, per session', () => {
  const entries = {};
  [[1, 0], [1, 2]].forEach(([w, di]) => [0, 1, 2].forEach(s => {
    entries['log_' + w + '_' + di + '_0_s' + s] = { carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2,
      prescriptionExerciseId: PID, ts: T0 + s };
  }));
  entries.log_1_0_1_s0 = { carga: '50', reps: '10', done: true, prescriptionExerciseId: 'pid-B' };
  entries.done_1_0 = { ts: 1 };
  const ex = policy.extractExposures(entries, PID, { planId: 'plan-A', clientId: 'client-A' });
  assert.deepEqual(ex.map(x => [x.week, x.dayIndex, x.sets.length]), [[1, 0, 3], [1, 2, 3]]);
  assert.equal(run(ex).comparableExposureCount, 2);
});

test('comparability: unit mismatch and executions older than a plan edit are excluded', () => {
  const lb = [exposure(1, 0, { unit: 'LB' }, { unit: 'LB' }), exposure(1, 2, { rirReal: 3 })];
  const d = run(lb);
  assert.equal(d.comparableExposureCount, 1); assert.equal(d.excludedExposures[0].reason, 'UNIT_MISMATCH');
  const edited = run(two({ rirReal: 3 }), { plan: Object.assign({}, plan, { updatedAt: new Date(T0 + 5 * 86400000).toISOString() }) });
  assert.equal(edited.comparableExposureCount, 0);
  assert.ok(edited.excludedExposures.every(x => x.reason === 'PRESCRIPTION_CHANGED'));
});

test('remaining branches: maintain, RIR missing, target RIR 0, collisions D+E and A+E', () => {
  const maintain = run(two({ rirReal: 2 }));
  assert.equal(maintain.ruleId, 'MAINTAIN'); assert.equal(maintain.candidates.length, 0);
  assert.equal(maintain.eligible, false, 'nothing to adjust');
  assert.ok(run(two({ rirReal: '' })).reasonCodes.includes('RIR_EVIDENCE_MISSING'));
  const zero = run(two({ rirPrescribed: 0, rirReal: 1 }));
  assert.ok(zero.reasonCodes.includes('RULE_A_TARGET_RIR_UNDEFINED')); assert.equal(zero.eligible, false);
  const de = run(two({ reps: 9, rirReal: 1 }));
  assert.equal(de.ruleId, 'D+E'); assert.equal(de.collision.classification, 'CURRENT_RUNTIME_HEURISTIC');
  assert.equal(de.collision.runtimeOrder, 'E_BEFORE_D'); assert.equal(de.eligible, false);
  assert.equal(de.candidates.length, 4);
  const ae = run(two({ reps: 9, rirReal: 3 }));
  assert.equal(ae.ruleId, 'A+E'); assert.equal(ae.collision.classification, 'AMBIGUOUS'); assert.equal(ae.eligible, false);
  const sst = run(two({ rirReal: 3 }), { prescription: { prescriptionExerciseId: PID, sets: [{ setIndex: 0, repsTarget: 'SST-PROTOCOL' }] } });
  assert.ok(sst.reasonCodes.includes('TARGET_NOT_NUMERIC')); assert.equal(sst.eligible, false);
});

test('reactive only: identical evidence gives identical output regardless of calendar', () => {
  const evidence = two({ rirReal: 3 });
  const later = evidence.map(x => Object.assign({}, x, { week: x.week + 3 }));
  const a = run(evidence), b = run(later, { plan });
  assert.deepEqual(Object.assign({}, a, { comparableExposures: null, evidence: null, previousExposure: null }),
    Object.assign({}, b, { comparableExposures: null, evidence: null, previousExposure: null }));
  assert.equal(run([exposure(1, 0, { rirReal: 2 }), exposure(4, 0, { rirReal: 2 })]).ruleId, 'MAINTAIN');
  assert.ok(!/weeks?\s*[<>=]|CURRENT_WEEK|REAL_WEEK|deload/i.test(policySource.replace(/\/\*[\s\S]*?\*\//, '')));
});

// ── Integration through the real Phase 1 shadow transaction ───────────────────
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

test('client transaction stores the shadow magnitude decision; plans/ is never written', async () => {
  const at = '2026-09-27T12:00:00.000Z';
  const rec = { prescriptionExerciseId: PID, exerciseId: 'ex-A', exerciseName: 'Remo', action: 'increase_load', newLoad: 102.5, newReps: 10 };
  const parent = { calculatedAt: at, recommendations: [rec] };
  const entries = { progrec_1_2: parent };
  [[1, 0], [1, 2]].forEach(([w, di]) => [0, 1, 2].forEach(s => {
    entries['log_' + w + '_' + di + '_0_s' + s] = { carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 3,
      prescriptionExerciseId: PID, ts: Date.parse('2026-09-26T12:00:00.000Z') + w * 1000 + di + s };
  }));
  const planDoc = structuredClone(plan);
  const docs = new Map([
    ['clients/client-A', { activePlanId: 'plan-A', coachId: 'coach-A', coachInterventions: [] }],
    ['plans/plan-A', structuredClone(planDoc)],
    ['logs/client-A/mesos/plan-A', { planId: 'plan-A', updatedAt: 5, entries: structuredClone(entries) }],
    ['logs/client-A', { planId: 'plan-A', updatedAt: 5, entries: structuredClone(entries) }]
  ]);
  const writes = [];
  const tx = { get: async ref => ({ exists: () => docs.has(ref), data: () => structuredClone(docs.get(ref)) }),
    set: (ref, value) => { writes.push(ref); docs.set(ref, { ...docs.get(ref), ...structuredClone(value) }); },
    update: ref => writes.push(ref) };
  const context = { window: { VDSEN_AUTO_APPLY_SHADOW: shadow }, USER: { uid: 'client-A' }, ACTIVE_PLAN_ID: 'plan-A',
    FB: { db: {}, doc: (_db, ...parts) => parts.join('/'), runTransaction: async (_db, fn) => fn(tx) } };
  vm.createContext(context);
  ['_getSessionCompletionState', '_sessionHasRealLoggedSets', '_getSessionLifecycleState', '_selectLogAuthority',
    '_recordShadowProgression'].forEach(n => vm.runInContext(functionSource(client, n), context));
  assert.equal(await context._recordShadowProgression('client-A', 'plan-A', 1, 2, parent), true);
  const meso = docs.get('logs/client-A/mesos/plan-A');
  const record = Object.values(meso.progressionApplications)[0];
  assert.equal(record.state, 'PENDING'); assert.equal(record.reasonCode, 'MAGNITUDE_POLICY_MISSING');
  assert.equal(record.magnitude.mode, 'SHADOW'); assert.equal(record.magnitude.comparableExposureCount, 2);
  assert.equal(record.magnitude.ruleId, 'A'); assert.equal(record.magnitude.candidates[0].rawCandidate, 102.5);
  assert.equal(record.magnitude.candidates[0].finalCandidate, null);
  assert.equal(record.magnitude.numericApplyAllowed, false);
  const item = meso.progressionApplicationSummary.items[0];
  assert.equal(item.magnitude.primaryRaw, 102.5); assert.equal(item.magnitude.applied, false);
  assert.equal(item.magnitude.methodologyFamily, 'EHRENSTEIN_APEKS_DERIVED');
  assert.ok(writes.every(ref => !ref.startsWith('plans/')), 'no write to plans/');
  assert.deepEqual(docs.get('plans/plan-A'), planDoc, 'vdsen-plan-v2 document unchanged');
  assert.equal(JSON.stringify(docs.get('logs/client-A').entries), JSON.stringify(entries), 'executed LOGS untouched');
});

test('Phase 1 contracts intact: strict PID identity, wiring and blocker names', () => {
  assert.ok(client.includes('assets/progression-magnitude-policy.js') && coach.includes('assets/progression-magnitude-policy.js'));
  assert.ok(fs.readFileSync(path.join(root, 'sw.js'), 'utf8').includes('/assets/progression-magnitude-policy.js'));
  assert.ok(coach.includes('return pidCount === 1 ? foundByPid : null;'), 'deep link stays strict PID-first');
  const rec = { prescriptionExerciseId: 'pid-B', exerciseId: 'ex-A', action: 'increase_load', newLoad: 102.5 };
  const r = shadow.buildRecord({ clientId: 'client-A', planId: 'plan-A', activePlanId: 'plan-A', week: 1, dayIndex: 0,
    calculatedAt: '2026-09-27T12:00:00.000Z', recommendation: rec, plan, sourceMatches: true, sourcePidCount: 1 }, '2026-09-27T13:00:00.000Z');
  assert.equal(r.reasonCode, 'IDENTITY_CONFLICT'); assert.equal(r.magnitude.eligible, false);
  assert.equal(policy.REASONS.NUMERIC_ACTIVATION_DISABLED, 'NUMERIC_ACTIVATION_DISABLED');
});

test('Modulo D still duplicates A/D/E and is not migrated: delta documented', () => {
  const block = coach.slice(coach.indexOf('Módulo D — Micro-ajuste Ehrenstein'), coach.indexOf('Módulo D — Micro-ajuste Ehrenstein') + 6000);
  assert.ok(block.includes('rirDiff*2.5') && block.includes('falt * 5'), 'independent A/D/E arithmetic still lives in Modulo D');
  assert.ok(!block.includes('VDSEN_MAGNITUDE_POLICY'), 'Modulo D does not consume the policy yet (no broad refactor in 2A)');
  assert.ok(/window\._moduloDPending/.test(block), 'its display state is untouched');
});

test('extraction keeps autoFilled/express flags so they are ignored from real LOG entries', () => {
  const entries = {};
  [[1, 0], [1, 2]].forEach(([w, di]) => [0, 1, 2].forEach(s => {
    entries['log_' + w + '_' + di + '_0_s' + s] = { carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 3,
      prescriptionExerciseId: PID, ts: T0 + s, autoFilled: di === 2, express: false };
  }));
  const d = run(policy.extractExposures(entries, PID, { planId: 'plan-A', clientId: 'client-A' }));
  assert.equal(d.comparableExposureCount, 1);
  assert.equal(d.excludedExposures[0].reason, 'AUTOFILLED_EVIDENCE');
  [0, 1, 2].forEach(i => { entries['log_1_0_0_s' + i].express = true; });
  assert.equal(run(policy.extractExposures(entries, PID, { planId: 'plan-A', clientId: 'client-A' })).comparableExposureCount, 0);
});
