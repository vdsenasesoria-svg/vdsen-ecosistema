// T528: VDSEN PRODUCT POLICY -- representative set = LAST VALID STANDARD WORKING SET. Warm-ups, planned drop sets and other
// EXPLICITLY tagged intensification sets are excluded from representative selection only (they remain training work in LOGS).
// Only explicit tags/structure classify a set: a load decrease or a name never does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));

const PID = 'pid-A', T0 = Date.parse('2026-09-27T12:00:00.000Z');
const mk = n => Array.from({ length: n }, (_, i) => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 100 }));
const plan = { clientId: 'c', weeks: 6, updatedAt: '2026-09-26T00:00:00.000Z', days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: PID, sets: mk(4) }] }] };
const prescription = sets => ({ prescriptionExerciseId: PID, repsRange: { min: 8, max: 12 }, sets: sets || mk(4) });
const S = (i, o) => Object.assign({ setIndex: i, load: 100, reps: 10, unit: 'KG', done: true, rirPrescribed: 2, rirReal: 3, autoFilled: false, express: false, warmup: false, ts: 0 }, o);
const expo = (week, day, sets) => ({ prescriptionExerciseId: PID, planId: 'p', clientId: 'c', week, dayIndex: day, exerciseIndex: 0,
  sets: sets.map((o, i) => S(o.setIndex === undefined ? i : o.setIndex, Object.assign({ ts: T0 + week * 86400000 + day * 3600000 + i }, o))) });
const run = (a, b, presSets) => policy.evaluate({ clientId: 'c', planId: 'p', prescriptionExerciseId: PID, plan, prescription: prescription(presSets), exposures: [expo(1, 0, a), expo(1, 2, b)], context: {} });
const tag = (sets, idx, tagObj) => sets.map((s, i) => idx.includes(i) ? Object.assign({}, s, tagObj) : s);
const HARD = { rirReal: 0, reps: 6, load: 70 };

test('T528.1 provenance is the standard-working-set policy (product policy, not science)', () => {
  assert.equal(policy.EVIDENCE_BASIS, 'VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET');
  const p = policy.PRODUCT_POLICIES.find(x => /REPRESENTATIVE_SET/.test(x.id));
  assert.equal(p.provenance, 'VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET'); assert.equal(p.source, 'VDSEN_PRODUCT_POLICY'); assert.equal(p.scientificClaim, false);
});

test('T528.2 straight sets: the last set is representative, order preserved', () => {
  const d = run([{}, {}, {}, {}], [{}, {}, {}, {}]);
  assert.equal(d.evidence.setIndex, 3); assert.equal(d.evidence.workingSetCount, 4); assert.equal(d.evidence.basis, policy.EVIDENCE_BASIS);
});

test('T528.3 explicit planned drop set (prescription tag) at the end is excluded; the last STANDARD set represents', () => {
  const ps = tag(mk(4), [3], { drop: true });
  const a = [{}, {}, {}, HARD];
  const d = run(a, a, ps);
  assert.equal(d.evidence.setIndex, 2); assert.equal(d.evidence.load, 100); assert.equal(d.ruleId, 'A'); assert.equal(d.evidence.workingSetCount, 3);
});

test('T528.4 multiple drop sets, tagged by setType / log tag, are all excluded', () => {
  const ps = mk(5).map((s, i) => i >= 3 ? Object.assign({}, s, { setType: 'drop' }) : s);
  const a = [{}, {}, {}, HARD, HARD];
  assert.equal(run(a, a, ps).evidence.setIndex, 2);
  const logTag = [{}, {}, {}, Object.assign({ isDropSet: true }, HARD), Object.assign({ intensification: true }, HARD)];
  assert.equal(run(logTag, logTag, mk(5)).evidence.setIndex, 2, 'explicit tags carried by the log entry');
});

test('T528.5 a load decrease alone never classifies a drop set (no inference)', () => {
  const a = [{}, {}, {}, { load: 70, reps: 12, rirReal: 3 }];
  const d = run(a, a);
  assert.equal(d.evidence.setIndex, 3); assert.equal(d.evidence.load, 70);
});

test('T528.6 no name heuristics: type/label text that merely resembles a drop set is not a tag', () => {
  const ps = mk(4).map((s, i) => i === 3 ? Object.assign({}, s, { label: 'drop set', name: 'Drop set final', note: 'dropset' }) : s);
  const a = [{}, {}, {}, { load: 70 }];
  assert.equal(run(a, a, ps).evidence.setIndex, 3);
  assert.equal(run(a, a, mk(4).map((s, i) => i === 3 ? Object.assign({}, s, { setType: 'dropping-ish' }) : s)).evidence.setIndex, 3);
});

test('T528.7 warm-ups + drop sets together: only the standard working sets remain, order preserved', () => {
  const ps = mk(5).map((s, i) => i === 0 ? Object.assign({}, s, { warmup: true }) : i === 4 ? Object.assign({}, s, { drop: true }) : s);
  const a = [{ warmup: true, rirReal: 5 }, {}, {}, {}, HARD];
  const d = run(a, a, ps);
  assert.equal(d.evidence.setIndex, 3); assert.equal(d.evidence.workingSetCount, 3);
});

test('T528.8 missing final working set: the last EXECUTED standard set is used; nothing is substituted', () => {
  const a = [{}, {}, { done: false }, HARD];
  const d = run(a, a, tag(mk(4), [3], { drop: true }));
  assert.equal(d.evidence.setIndex, 1); assert.equal(d.evidence.workingSetCount, 2);
});

test('T528.9 exposure with only drop sets has no standard working set (excluded, not invented)', () => {
  const a = [HARD, HARD];
  const d = run(a, a, tag(mk(4), [0, 1], { drop: true }));
  assert.equal(d.comparableExposureCount, 0); assert.ok(d.excludedExposures.every(x => x.reason === 'NO_WORKING_SET'));
});

test('T528.10 same exact PID and stable order regardless of arrival order', () => {
  const ps = tag(mk(4), [3], { drop: true });
  const shuffled = [S(2, { ts: T0 + 2 }), S(3, Object.assign({ ts: T0 + 3 }, HARD)), S(0, { ts: T0 }), S(1, { ts: T0 + 1 })];
  const sel = policy.selectRepresentativeSet({ sets: shuffled }, prescription(ps));
  assert.deepEqual(sel.workingSets.map(s => s.setIndex), [0, 1, 2]); assert.equal(sel.set.setIndex, 2);
});

test('T528.11 drop sets remain training work: LOGS extraction keeps them (with their explicit tags); only selection excludes them', () => {
  const e = {};
  [0, 1, 2].forEach(i => { e['log_1_0_0_s' + i] = { carga: '100', reps: '10', unit: 'KG', done: true, prescriptionExerciseId: PID, rir_real: 3, ts: T0 + i }; });
  e['log_1_0_0_s3'] = { carga: '70', reps: '6', unit: 'KG', done: true, prescriptionExerciseId: PID, rir_real: 0, drop: true, ts: T0 + 3 };
  const x = policy.extractExposures(e, PID, { planId: 'p', clientId: 'c' })[0];
  assert.equal(x.sets.length, 4); assert.equal(x.sets[3].drop, true); assert.equal(x.sets[3].load, '70');
  assert.equal(policy.selectRepresentativeSet(x, prescription()).set.setIndex, 2);
});
