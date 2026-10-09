// T492: canonical evidence eligibility -- >=2 comparable exposures AND a direction confirmed (not
// conflicting) across them, no safety/pain conflict. One unusually good/bad session is never authority.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = require(path.join(__dirname, '..', 'assets/progression-magnitude-policy.js'));
const shadow = require(path.join(__dirname, '..', 'assets/progression-auto-apply-shadow.js'));

const PID = 'pid-A', T0 = Date.parse('2026-09-27T12:00:00.000Z');
const plan = { updatedAt: '2026-09-26T00:00:00.000Z', days: [] };
const prescription = { prescriptionExerciseId: PID, repsRange: { min: 8, max: 12 },
  sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 })) };
// signal shapes for the LAST set of an exposure
const UP = { rirReal: 3 }, HOLD = { rirReal: 2 }, DOWN_D = { rirReal: 1 }, REST_C = { reps: 9, rirReal: 2 };
function exposure(n, last, over = {}) {
  const mk = (i, o) => Object.assign({ setIndex: i, load: 100, reps: 10, unit: 'KG', done: true, rirPrescribed: 2, rirReal: 2, ts: T0 + n * 86400000 + i }, o);
  return Object.assign({ prescriptionExerciseId: PID, planId: 'p', clientId: 'c', week: 1 + Math.floor(n / 2), dayIndex: (n % 2) * 2,
    sets: [mk(0), mk(1), mk(2, last)] }, over);
}
const run = (signals, extra = {}) => policy.evaluate(Object.assign({ clientId: 'c', planId: 'p', prescriptionExerciseId: PID, plan, prescription,
  exposures: signals.map((s, i) => exposure(i, s)), context: {} }, extra));

test('T492.1 the same directional signal on two consecutive comparable exposures is eligible', () => {
  const up = run([UP, UP]);
  assert.equal(up.directionConsistency, 'CONSISTENT'); assert.equal(up.direction, 'UP'); assert.equal(up.eligible, true);
  assert.equal(up.candidates[0].rawCandidate, 102.5);
  // T523: REST (Rule C) is a FIRST-occurrence intervention: it needs no directional confirmation; a repeat goes to Coach review.
  const rest = run([HOLD, REST_C]);
  assert.equal(rest.direction, 'REST'); assert.equal(rest.directionConsistency, 'NOT_APPLICABLE'); assert.equal(rest.eligible, true);
  const persists = run([REST_C, REST_C]);
  assert.equal(persists.eligible, false); assert.equal(persists.coachReviewRequired.branch, 'C+E'); assert.deepEqual(persists.candidates, []);
});

test('T492.2 one unusually good/bad session after neutral history is not authority', () => {
  for (const [signals, dir] of [[[HOLD, UP], 'UP'], [[HOLD, HOLD, UP], 'UP'], [[UP, HOLD, UP], 'UP'], [[REST_C, UP], 'UP']]) {
    const r = run(signals);
    assert.equal(r.direction, dir); assert.equal(r.directionConsistency, 'UNCONFIRMED'); assert.equal(r.eligible, false, JSON.stringify(signals));
    assert.ok(r.reasonCodes.includes('DIRECTION_NOT_CONFIRMED_BY_PRIOR_EXPOSURE'));
    assert.equal(r.candidates[0].rawCandidate, 102.5, 'the shadow candidate itself is unchanged');
  }
  assert.equal(run([UP]).directionConsistency, 'UNCONFIRMED');
  assert.equal(run([UP]).eligible, false);
});

test('T492.3 conflicting direction across exposures goes to explicit review and is never eligible', () => {
  const r = run([DOWN_D, UP]);
  assert.equal(r.directionConsistency, 'CONFLICTING'); assert.equal(r.eligible, false);
  assert.ok(r.reasonCodes.includes('CONFLICTING_DIRECTION_ACROSS_EXPOSURES'));
  assert.equal(r.review.code, 'CONFLICTING_DIRECTION_ACROSS_EXPOSURES'); assert.equal(r.review.exposures.length, 2);
  // T523: a latest D is itself a Coach-review state (no confirmation logic, no numeric candidate)
  const d = run([UP, DOWN_D]);
  assert.equal(d.coachReviewRequired.branch, 'D'); assert.equal(d.eligible, false); assert.deepEqual(d.candidates, []);
});

test('T492.4 (T523) D stays Coach review (never numeric) even when the direction repeats', () => {
  const r = run([DOWN_D, DOWN_D]);
  assert.equal(r.direction, 'DOWN'); assert.equal(r.directionConsistency, 'NOT_APPLICABLE');
  assert.equal(r.coachReviewRequired.code, 'COACH_REVIEW_REQUIRED'); assert.equal(r.unresolved, null); assert.equal(r.eligible, false); assert.deepEqual(r.candidates, []);
});

test('T492.5 maintain has nothing to apply; no direction requirement', () => {
  const r = run([HOLD, HOLD]);
  assert.equal(r.ruleId, 'MAINTAIN'); assert.equal(r.directionConsistency, 'NOT_APPLICABLE'); assert.equal(r.eligible, false);
});

test('T492.6 pain/injury/safety conflict blocks eligibility and asks for review', () => {
  assert.equal(run([UP, UP], { context: { safetyConflict: true } }).eligible, false);
  assert.ok(run([UP, UP], { context: { safetyConflict: true } }).reasonCodes.includes('SAFETY_CONFLICT'));
  const entries = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => {
    entries['log_' + w + '_' + d + '_0_s' + s] = { carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 3,
      prescriptionExerciseId: PID, ts: T0 + d * 1000 + s };
  }));
  const clean = policy.extractExposures(entries, PID, { planId: 'p', clientId: 'c' });
  assert.deepEqual(clean.map(x => x.painFlag), [false, false]);
  const ev = (exps) => policy.evaluate({ clientId: 'c', planId: 'p', prescriptionExerciseId: PID, plan, prescription, exposures: exps, context: {} });
  assert.equal(ev(clean).eligible, true);
  for (const post of [{ articularPain: { present: true } }, { articular: 'si' }]) {
    const painful = policy.extractExposures(Object.assign({ postsession_1_2: post }, entries), PID, { planId: 'p', clientId: 'c' });
    assert.deepEqual(painful.map(x => x.painFlag), [false, true]);
    const r = ev(painful);
    assert.equal(r.eligible, false); assert.ok(r.reasonCodes.includes('SAFETY_CONFLICT'));
  }
});

test('T492.7 competitive/enhanced/PED labels neither create nor remove eligibility', () => {
  const base = run([UP, UP]);
  for (const context of [{ competitive: true }, { enhanced: true }, { ped: true }]) assert.deepEqual(run([UP, UP], { context }), base);
});

test('T492.8 the source-rule branching lives in one classifier reused for the previous exposure', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/progression-magnitude-policy.js'), 'utf8');
  assert.equal((src.match(/function _classify\(/g) || []).length, 1);
  assert.ok(src.includes('var cls = _classify(reps, repsTarget, rirReal, rirTarget);') && src.includes('_classify(ps.reps, ps.repsTarget, ps.rirReal, ps.rirTarget)'));
  assert.ok(!/if \(incomplete\)/.test(src));
});

test('T492.9 the decision travels in the Phase 1 shadow record (compact form included) and nothing applies', () => {
  const entries = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => {
    entries['log_' + w + '_' + d + '_0_s' + s] = { carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 3, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s };
  }));
  const p2 = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [{ prescriptionExerciseId: PID, exerciseId: 'e', sets: prescription.sets }] })) };
  const r = shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan: p2, entries, week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z',
    sourceMatches: true, sourcePidCount: 1, recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', action: 'increase_load', newLoad: 5 } }, 'x');
  assert.equal(r.magnitude.directionConsistency, 'CONSISTENT');
  const compact = policy.compact(r.magnitude);
  assert.equal(compact.directionConsistency, 'CONSISTENT'); assert.equal(compact.direction, 'UP'); assert.equal(compact.numericApplyAllowed, false);
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false); assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
});

test('T492.10 the Coach sees why a candidate is blocked (direction, conflict, safety)', () => {
  const vm = require('node:vm');
  const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
  const fn = (name) => { const st = coach.indexOf('  function ' + name + '('); let d = 0, q = null, e = false;
    for (let i = coach.indexOf('{', st); i < coach.length; i++) { const c = coach[i];
      if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; } if (c === '{') d++; if (c === '}' && --d === 0) return coach.slice(st, i + 1); } };
  const ctx = {}; vm.createContext(ctx);
  const esc = coach.indexOf('  function _escH(s) {'); vm.runInContext(coach.slice(esc, coach.indexOf('\n  }\n', esc) + 4), ctx);
  vm.runInContext(coach.slice(coach.indexOf('  var _REVIEW_BRANCH = {'), coach.indexOf('  function _moduloDCanonicalView(')), ctx); // T523 review helpers
  vm.runInContext(fn('_shadowAuditLines'), ctx);
  const item = (m) => ({ state: 'PENDING', source: { week: 1, dayIndex: 2 }, nextExposure: { week: 2, dayIndex: 0 }, prescriptionExerciseId: PID, action: 'increase_load', magnitude: m });
  const line = (m) => ctx._shadowAuditLines(item(m));
  assert.ok(line({ eligible: false, unresolved: null, directionConsistency: 'UNCONFIRMED', review: null, reasonCodes: [] }).includes('Bloqueado: dirección no confirmada por la exposición previa'));
  assert.ok(line({ eligible: false, unresolved: null, directionConsistency: 'CONFLICTING', review: 'CONFLICTING_DIRECTION_ACROSS_EXPOSURES', reasonCodes: [] }).includes('En revisión: dirección conflictiva entre exposiciones'));
  assert.ok(line({ eligible: false, unresolved: null, directionConsistency: 'CONSISTENT', review: null, reasonCodes: ['SAFETY_CONFLICT'] }).includes('Bloqueado: conflicto de seguridad'));
  assert.ok(line({ eligible: true, unresolved: null, directionConsistency: 'CONSISTENT', review: null, reasonCodes: [] }).includes('Candidato resuelto en shadow — no se aplica'));
});
