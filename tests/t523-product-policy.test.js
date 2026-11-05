// T523: VDSEN PRODUCT POLICY (director decisions; NOT scientific rules):
//   D/E -> Coach review only | C first then E if it persists (-> Coach review) | representative set = last valid WORKING set.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));
const policySrc = fs.readFileSync(path.join(root, 'assets/progression-magnitude-policy.js'), 'utf8');

const PID = 'pid-A', T0 = Date.parse('2026-09-27T12:00:00.000Z');
const presSets = [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 100 }));
const plan = { clientId: 'c', weeks: 6, updatedAt: '2026-09-26T00:00:00.000Z', days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: PID, sets: presSets }] }] };
const prescription = (sets = presSets) => ({ prescriptionExerciseId: PID, repsRange: { min: 8, max: 12 }, sets });
const set = (i, o) => Object.assign({ setIndex: i, load: 100, reps: 10, unit: 'KG', done: true, rirPrescribed: 2, rirReal: 2, autoFilled: false, express: false, warmup: false, ts: 0 }, o);
// exposure = list of set overrides (each becomes a set); ts increases with week/day/set
function expo(week, day, sets, extra = {}) {
  return Object.assign({ prescriptionExerciseId: PID, planId: 'p', clientId: 'c', week, dayIndex: day, exerciseIndex: 0,
    sets: sets.map((o, i) => set(o.setIndex === undefined ? i : o.setIndex, Object.assign({ ts: T0 + week * 86400000 + day * 3600000 + i }, o))) }, extra);
}
const ok = [{}, {}, {}];
const run = (exposures, extra = {}) => policy.evaluate(Object.assign({ clientId: 'c', planId: 'p', prescriptionExerciseId: PID, plan, prescription: prescription(), exposures, context: {} }, extra));
const lastReps9 = [{}, {}, { reps: 9, rirReal: 2 }];       // C condition: RIR correct, reps incomplete
const pair = (a, b) => [expo(1, 0, a), expo(1, 2, b)];

// ---------------- D / E
test('T523.1 D (effort harder), E (reps incomplete, no RIR) and D+E / A+E are Coach review only: no numeric candidate, ever', () => {
  const cases = { D: [{}, {}, { rirReal: 0 }], E: [{}, {}, { reps: 8, rirReal: '' }], 'D+E': [{}, {}, { reps: 8, rirReal: 0 }], 'A+E': [{}, {}, { reps: 8, rirReal: 4 }] };
  for (const [branch, last] of Object.entries(cases)) {
    const d = run(pair(ok, last));
    assert.equal(d.coachReviewRequired.branch, branch, branch); assert.equal(d.coachReviewRequired.code, 'COACH_REVIEW_REQUIRED');
    assert.equal(d.coachReviewRequired.policy, 'VDSEN_PRODUCT_POLICY_COACH_REVIEW_ONLY'); assert.equal(d.coachReviewRequired.scientificClaim, false);
    assert.deepEqual(d.candidates, [], branch); assert.equal(d.dimension, null); assert.equal(d.eligible, false); assert.equal(d.actionable, false); assert.equal(d.unresolved, null);
    assert.ok(!d.candidates.some(c => ['LOAD', 'REPS', 'SETS', 'RIR'].includes(c.dimension)));
  }
});

test('T523.2 review carries the fields the Coach needs: source exposure, observed vs prescribed, reason', () => {
  const r = run(pair(ok, [{}, {}, { reps: 8, rirReal: 0 }])).coachReviewRequired;
  assert.deepEqual(r.sourceExposure, { week: 1, dayIndex: 2 }); assert.deepEqual(r.previousExposure, { week: 1, dayIndex: 0 });
  assert.deepEqual(r.observed, { repsExecuted: 8, rirObserved: 0 }); assert.deepEqual(r.prescribed, { repsTarget: 10, rirTarget: 2 }); assert.ok(r.reason);
});

test('T523.3 Rule A and other supported branches are unaffected', () => {
  const a = run(pair([{}, {}, { rirReal: 3 }], [{}, {}, { rirReal: 3 }]));
  assert.equal(a.ruleId, 'A'); assert.equal(a.coachReviewRequired, null); assert.equal(a.eligible, true); assert.equal(a.candidates[0].rawCandidate, 102.5);
  const m = run(pair(ok, ok)); assert.equal(m.ruleId, 'MAINTAIN'); assert.equal(m.coachReviewRequired, null);
});

// ---------------- C -> E
test('T523.4 first comparable C -> REST +30 s ONLY (no simultaneous E)', () => {
  const d = run(pair(ok, lastReps9));
  assert.equal(d.ruleId, 'C'); assert.equal(d.dimension, 'REST'); assert.deepEqual(d.candidates.map(c => c.dimension), ['REST']);
  assert.deepEqual([d.candidates[0].previousValue, d.candidates[0].rawCandidate, d.candidates[0].deltaSeconds], [90, 120, 30]);
  assert.equal(d.coachReviewRequired, null); assert.equal(d.eligible, true); assert.equal(d.directionConsistency, 'NOT_APPLICABLE');
  assert.deepEqual([d.collision.classification, d.collision.order, d.collision.deferredRule], ['EXPLICIT_VDSEN_PRECEDENCE', 'C_FIRST_THEN_E_IF_PERSISTS', 'E']);
});

test('T523.5 the same condition at the NEXT comparable exposure reaches E -> Coach review (no double automatic intervention)', () => {
  const d = run(pair(lastReps9, lastReps9));
  assert.equal(d.coachReviewRequired.branch, 'C+E'); assert.equal(d.coachReviewRequired.reason, 'C_PERSISTS_AT_NEXT_COMPARABLE_EXPOSURE');
  assert.deepEqual(d.candidates, []); assert.equal(d.eligible, false);
  assert.deepEqual([d.collision.classification, d.collision.order], ['EXPLICIT_VDSEN_PRECEDENCE', 'C_THEN_E']);
});

test('T523.6 persistence needs the SAME condition: a different previous signal leaves C as a first occurrence', () => {
  for (const prev of [ok, [{}, {}, { rirReal: 3 }], [{}, {}, { rirReal: 0 }], [{}, {}, { reps: 9, rirReal: 3 }]]) {
    const d = run(pair(prev, lastReps9));
    assert.equal(d.ruleId, 'C'); assert.equal(d.coachReviewRequired, null); assert.equal(d.candidates[0].dimension, 'REST');
  }
});

test('T523.7 no E escalation from a stale / non-comparable exposure', () => {
  // previous exposure executed BEFORE the last plan edit -> excluded (PRESCRIPTION_CHANGED) -> it cannot make C "persist"
  const old = expo(0, 0, lastReps9.map(o => Object.assign({}, o, { ts: T0 - 10 * 86400000 })));
  const d = run([old, expo(1, 0, ok), expo(1, 2, lastReps9)]);
  assert.equal(d.coachReviewRequired, null);
  const stale = run([old, expo(1, 2, lastReps9)]);
  assert.ok(stale.excludedExposures.some(x => x.reason === 'PRESCRIPTION_CHANGED')); assert.equal(stale.comparableExposureCount, 1); assert.equal(stale.eligible, false);
  // autofilled / express / unit-mismatch previous exposures are not comparable either
  const auto = expo(1, 0, lastReps9.map(o => Object.assign({}, o, { autoFilled: true })));
  assert.equal(run([auto, expo(1, 2, lastReps9)]).comparableExposureCount, 1);
  const lb = expo(1, 0, lastReps9.map(o => Object.assign({}, o, { unit: 'LB' })));
  const mixed = run([lb, expo(1, 2, lastReps9)]);
  assert.ok(mixed.excludedExposures.some(x => x.reason === 'UNIT_MISMATCH')); assert.equal(mixed.coachReviewRequired, null);
  // another PID never counts
  const other = Object.assign(expo(1, 0, lastReps9), { prescriptionExerciseId: 'pid-B' });
  assert.equal(run([other, expo(1, 2, lastReps9)]).comparableExposureCount, 1);
});

// ---------------- representative set = LAST valid WORKING set
test('T523.8 the representative set is the LAST valid working set; provenance is product policy', () => {
  const d = run(pair([{ rirReal: 3 }, { rirReal: 0 }, { rirReal: 3 }], [{ rirReal: 3 }, { rirReal: 0 }, { rirReal: 3 }]));
  assert.equal(d.evidence.setIndex, 2); assert.equal(d.evidence.rirObserved, 3); assert.equal(d.evidence.basis, 'VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET');
  assert.equal(d.ruleId, 'A', 'the first sets do not control the policy');
  assert.equal(policy.PRODUCT_POLICIES.find(p => p.id === 'REPRESENTATIVE_SET_LAST_STANDARD_WORKING_SET').provenance, 'VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET');
});

test('T523.9 warm-up sets (flag on the log or on the prescribed set) never become the representative set', () => {
  const warm = { warmup: true, rirReal: 5, reps: 3, load: 40 };
  const d = run(pair([{ rirReal: 3 }, { rirReal: 3 }, warm], [{ rirReal: 3 }, { rirReal: 3 }, warm]));
  assert.equal(d.evidence.setIndex, 1, 'the last WORKING set'); assert.equal(d.evidence.load, 100); assert.equal(d.ruleId, 'A');
  const planned = presSets.map((s, i) => i === 2 ? Object.assign({}, s, { isWarmup: true }) : s);
  const p = run(pair([{ rirReal: 3 }, { rirReal: 3 }, { rirReal: 0, reps: 5 }], [{ rirReal: 3 }, { rirReal: 3 }, { rirReal: 0, reps: 5 }]), { prescription: prescription(planned) });
  assert.equal(p.evidence.setIndex, 1);
  const onlyWarm = run(pair([warm, warm, warm], [warm, warm, warm]));
  assert.equal(onlyWarm.comparableExposureCount, 0); assert.ok(onlyWarm.excludedExposures.every(x => x.reason === 'NO_WORKING_SET'));
});

test('T523.10 planned drop sets, autofilled and express sets are not working sets; nothing is substituted or imputed', () => {
  const dropped = presSets.map((s, i) => i === 2 ? Object.assign({}, s, { drop: true }) : s);
  const drop = { rirReal: 0, reps: 6, load: 70 };
  const d = run(pair([{ rirReal: 3 }, { rirReal: 3 }, drop], [{ rirReal: 3 }, { rirReal: 3 }, drop]), { prescription: prescription(dropped) });
  assert.equal(d.evidence.setIndex, 1); assert.equal(d.evidence.load, 100);
  const auto = run(pair([{ rirReal: 3 }, { rirReal: 3 }, { autoFilled: true }], [{ rirReal: 3 }, { rirReal: 3 }, { express: true }]));
  assert.equal(auto.evidence.setIndex, 1);
  // a later set that was never executed is NOT invented: the last EXECUTED working set is used, and the count is explicit
  const short = run(pair([{ rirReal: 3 }, { rirReal: 3 }, { done: false }], [{ rirReal: 3 }, { rirReal: 3 }, { done: false }]));
  assert.equal(short.evidence.setIndex, 1); assert.equal(short.evidence.workingSetCount, 2);
});

test('T523.11 missing observed RIR follows the current evidence rules (no imputation)', () => {
  const d = run(pair([{}, {}, { rirReal: '' }], [{}, {}, { rirReal: '' }]));
  assert.ok(d.reasonCodes.includes('RIR_EVIDENCE_MISSING')); assert.deepEqual(d.candidates, []); assert.equal(d.eligible, false);
  const e = run(pair([{}, {}, { reps: 9, rirReal: '' }], [{}, {}, { reps: 9, rirReal: '' }]));
  assert.equal(e.coachReviewRequired.branch, 'E');
});

test('T523.12 order is stable: sets are ordered by setIndex regardless of input order; same exact PID only, no name fallback', () => {
  const a = [{}, {}, { rirReal: 3 }], shuffled = expo(1, 2, a); shuffled.sets = [shuffled.sets[2], shuffled.sets[0], shuffled.sets[1]];
  const base = run([expo(1, 0, a), expo(1, 2, a)]), scrambled = run([expo(1, 0, a), Object.assign({}, shuffled)]);
  assert.equal(scrambled.evidence.setIndex, base.evidence.setIndex);
  const named = Object.assign(expo(1, 2, a), { prescriptionExerciseId: undefined, exerciseNameSnapshot: 'Remo' });
  assert.equal(run([expo(1, 0, a), named]).comparableExposureCount, 1, 'an exposure without the exact PID never matches by name');
});

test('T523.13 ONE authority: every canonical consumer selects the set through selectRepresentativeSet (no scattered last-element logic)', () => {
  const code = policySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const hits = code.split('\n').filter(l => /\.length\s*-\s*1\]/.test(l) && /sets|real/.test(l));
  assert.equal(hits.filter(l => !/function selectRepresentativeSet|var set = sets\[sets\.length - 1\]/.test(l)).length, 0, hits.join('\n'));
  assert.equal(code.split('selectRepresentativeSet(').length - 1 >= 4, true, 'used by comparable(), decision set, evaluate and the definition');
  for (const f of ['assets/progression-auto-apply-shadow.js', 'assets/progression-application-consumer.js'])
    assert.ok(!/sets\[[^\]]*length\s*-\s*1\]/.test(fs.readFileSync(path.join(root, f), 'utf8')), f + ' never picks a set itself');
});

test('T523.14 the simulator stays analysis-only: no runtime module references averaging / worst / best strategies', () => {
  for (const f of ['assets/progression-magnitude-policy.js', 'assets/progression-application-consumer.js', 'assets/progression-auto-apply-shadow.js', 'vdsen-coach.html', 'vdsen-cliente.html'])
    assert.ok(!/WORST_SET|BEST_SET|simulate-representative-set/.test(fs.readFileSync(path.join(root, f), 'utf8')), f);
});

test('T523.15 competitive / enhanced labels stay unread; provenance is product policy, not science', () => {
  assert.ok(!/\b(PED|enhanced|competitive|natural)\b/i.test(policySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  assert.ok(policy.PRODUCT_POLICIES.every(p => p.scientificClaim === false && p.source === 'VDSEN_PRODUCT_POLICY'));
  assert.ok(/NOT scientific claims/.test(policySrc));
});
