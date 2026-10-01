// T547 Director decision: EXPRESS IS NOT CANONICAL PROGRESSION EVIDENCE.
// `express:true` (S1..S(n-1)) AND `expressFinal:true` (the final Express set, T546) are legitimate EXECUTION / HISTORY data, but neither may be
// the LAST VALID STANDARD WORKING SET, count as a comparable exposure, or start a target exposure. The T546 behaviour (explicit observed RIR,
// ICS/Pump absent unless entered) is unchanged: it only means the final Express set carries honest values, not that it is canonical evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const POLICY = require('../assets/progression-magnitude-policy.js');
const EFF = require('../assets/progression-effective-prescription.js');

const PID = 'pid-1';
const PRES = { prescriptionExerciseId: PID, sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 8, rirTarget: 2, restSeconds: 120 })) };
const ent = (flags, extra) => Object.assign({ carga: '60', reps: '8', unit: 'KG', done: true, rir: 2, ts: 1790000000000, prescriptionExerciseId: PID }, flags, extra);
const expo = entries => POLICY.extractExposures(entries, PID, { planId: 'p', clientId: 'c' });
const evalOf = (entries, extra) => POLICY.evaluate(Object.assign({ prescriptionExerciseId: PID, planId: 'p', clientId: 'c', exposures: expo(entries), context: {}, plan: {}, prescription: PRES }, extra));

test('T547.1 a normal standard final working set is the representative set', () => {
  const e = { log_1_0_0_s0: ent({}, { rir_real: 3 }), log_1_0_0_s1: ent({}, { rir_real: 2 }), log_1_0_0_s2: ent({}, { rir_real: 1, reps: '7' }) };
  const r = evalOf(e);
  assert.equal(r.comparableExposureCount, 1);
  assert.equal(r.evidence.setIndex, 2); assert.equal(r.evidence.workingSetCount, 3);
  assert.equal(r.evidence.rirObserved, 1); assert.equal(r.evidence.repsExecuted, 7);
});

test('T547.2 warm-up and drop / intensification sets are excluded from representative selection (unchanged policy)', () => {
  const e = { log_1_0_0_s0: ent({}, { rir_real: 2 }), log_1_0_0_s1: ent({}, { rir_real: 2 }), log_1_0_0_s2: ent({ warmup: true }, { rir_real: 5 }), log_1_0_0_s3: ent({ drop: true }, { rir_real: 0 }) };
  const r = evalOf(e);
  assert.equal(r.evidence.setIndex, 1, 'last STANDARD working set, not the trailing warm-up / drop');
  assert.equal(r.evidence.workingSetCount, 2);
});

test('T547.3 express:true sets are excluded from representative selection', () => {
  const sets = [{ setIndex: 0, done: true, reps: '8', rirReal: 2 }, { setIndex: 1, done: true, reps: '8', express: true }, { setIndex: 2, done: true, reps: '8', express: true, rirReal: 0 }];
  assert.equal(POLICY.selectRepresentativeSet({ sets }, PRES).set.setIndex, 0);
});

test('T547.4 expressFinal:true sets are ALSO excluded from representative selection', () => {
  const sets = [{ setIndex: 0, done: true, reps: '8', rirReal: 2 }, { setIndex: 1, done: true, reps: '8', express: true }, { setIndex: 2, done: true, reps: '8', rirReal: 1, expressFinal: true }];
  const rep = POLICY.selectRepresentativeSet({ sets }, PRES);
  assert.equal(rep.set.setIndex, 0, 'the explicit final Express set is not the representative set');
  assert.deepEqual(rep.workingSets.map(s => s.setIndex), [0]);
  assert.equal(POLICY.selectRepresentativeSet({ sets: sets.slice(1) }, PRES), null, 'only Express sets => no representative set at all');
});

test('T547.5 an exposure containing ONLY Express sets yields no comparable progression evidence (extractExposures carries both flags)', () => {
  const e = { log_1_0_0_s0: ent({ express: true }), log_1_0_0_s1: ent({ express: true }), log_1_0_0_s2: ent({ expressFinal: true }, { rir_real: 1 }) };
  const x = expo(e);
  assert.equal(x.length, 1);
  assert.deepEqual(x[0].sets.map(s => [s.express, s.expressFinal]), [[true, false], [true, false], [false, true]]);
  const r = evalOf(e);
  assert.equal(r.comparableExposureCount, 0, 'no comparable exposure');
  assert.ok(r.excludedExposures.some(x => x.reason === POLICY.REASONS.EXPRESS_EVIDENCE), 'excluded because it is Express evidence');
  assert.equal(r.evidence, null, 'no decision set, no rule outcome, nothing substituted');
  assert.equal(r.applied, false); assert.equal(r.numericApplyAllowed, false);
});

test('T547.6 a standard exposure and an Express exposure of the same exercise: only the standard one is comparable', () => {
  const e = { log_1_0_0_s0: ent({}, { rir_real: 2 }), log_1_0_0_s1: ent({}, { rir_real: 2 }), log_1_0_0_s2: ent({}, { rir_real: 2 }),
    log_2_0_0_s0: ent({ express: true }), log_2_0_0_s1: ent({ express: true }), log_2_0_0_s2: ent({ expressFinal: true }, { rir_real: 0 }) };
  const r = evalOf(e);
  assert.equal(r.comparableExposureCount, 1);
  assert.deepEqual(r.comparableExposures, [{ week: 1, dayIndex: 0 }]);
  assert.ok(r.excludedExposures.some(x => x.week === 2 && x.reason === POLICY.REASONS.EXPRESS_EVIDENCE));
});

test('T547.7 an Express set (either flag) never starts a target exposure for the effective prescription', () => {
  const entries = f => ({ log_1_0_0_s2: ent(f) });
  assert.equal(EFF.pidExposureStarted(entries({}), PID, 1, 0), true, 'a standard set does');
  assert.equal(EFF.pidExposureStarted(entries({ express: true }), PID, 1, 0), false);
  assert.equal(EFF.pidExposureStarted(entries({ expressFinal: true }), PID, 1, 0), false);
});

test('T547.8 the T546 Express writers still tag the final set as expressFinal (history keeps it; canonical ignores it)', () => {
  const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
  assert.ok(client.includes('e.expressFinal = true;') && client.includes('} else e.express = true;'));
  assert.ok(client.includes("if (p.obs.rir !== null) e.rir_real = p.obs.rir;"), 'explicit observed RIR behaviour kept');
  const mag = fs.readFileSync('assets/progression-magnitude-policy.js', 'utf8');
  assert.ok(/Express is NOT canonical/i.test(mag) || /expressFinal/.test(mag), 'the policy documents the exclusion');
});

test('T547.9 STANDARD vs EXPRESS (same nominal session): per-set evidence yields canonical representative evidence; Express-only does not', () => {
  // the same nominal exposure: 3 sets of 60 kg x 8, final observed RIR 2
  const standard = { log_1_0_0_s0: ent({}, { rir_real: 2 }), log_1_0_0_s1: ent({}, { rir_real: 2 }), log_1_0_0_s2: ent({}, { rir_real: 2 }) };
  const express = { log_1_0_0_s0: ent({ express: true }), log_1_0_0_s1: ent({ express: true }), log_1_0_0_s2: ent({ expressFinal: true }, { rir_real: 2 }) };
  const a = evalOf(standard), b = evalOf(express);
  assert.equal(a.comparableExposureCount, 1); assert.equal(a.evidence.setIndex, 2); assert.equal(a.evidence.rirObserved, 2);
  assert.equal(b.comparableExposureCount, 0); assert.equal(b.evidence, null);
  assert.deepEqual(b.excludedExposures.map(x => x.reason), [POLICY.REASONS.EXPRESS_EVIDENCE]);
  // both are real execution history: the data is identical, only its canonical eligibility differs
  for (const k of Object.keys(standard)) { assert.equal(standard[k].done, true); assert.equal(express[k].done, true); assert.equal(express[k].carga, standard[k].carga); }
});
