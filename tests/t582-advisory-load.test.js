'use strict';
// T582: unit contract of the ADVISORY load resolution and of the consumer's handling of it. Equipment data is optional: the policy's raw candidate (evidence-based) is
// only tidied to a generic grain; the consumer's activation guard accepts it without any equipment identity/increment, and still re-verifies everything else.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../assets/progression-equipment-resolver.js');
const C = require('../assets/progression-application-consumer.js');

const mag = (o) => Object.assign({ direction: 'UP', evidence: { unit: 'KG' }, candidates: [{ dimension: 'LOAD', ruleId: 'A', previousValue: 100, rawCandidate: 105, finalCandidate: null, blockers: ['EQUIPMENT_INCREMENT_POLICY_MISSING'] }] }, o || {});
const cand = (previousValue, rawCandidate) => ({ candidates: [{ dimension: 'LOAD', ruleId: 'A', previousValue, rawCandidate, finalCandidate: null, blockers: [] }] });

test('T582-U1 advisory target: raw candidate tidied to 0.5 KG / 1 LB; direction always preserved; never an equipment claim', () => {
  const r = R.resolveAdvisoryLoad({ magnitude: mag() });
  assert.deepEqual([r.resolutionState, r.realizableLoad, r.requestedLoad, r.delta, r.unit, r.equipmentId, r.incrementSource, r.roundingReason], ['ADVISORY', 105, 105, 5, 'KG', null, 'ADVISORY_GENERIC', 'ADVISORY_GRAIN_0.5']);
  assert.equal(R.resolveAdvisoryLoad({ magnitude: mag(cand(47, 49.35)) }).realizableLoad, 49.5);
  assert.equal(R.resolveAdvisoryLoad({ magnitude: mag(Object.assign(cand(220, 231), { evidence: { unit: 'lb' } })) }).unit, 'LB');
  assert.equal(R.resolveAdvisoryLoad({ magnitude: mag(Object.assign(cand(220, 226.6), { evidence: { unit: 'LB' } })) }).realizableLoad, 227, 'LB grain is 1');
  const down = R.resolveAdvisoryLoad({ magnitude: mag(Object.assign({ direction: 'DOWN' }, cand(100, 95))) }); assert.equal(down.realizableLoad, 95); assert.equal(down.delta, -5);
});

test('T582-U2 a tiny rule step is never rounded away into "no change": the unrounded candidate is used instead', () => {
  const r = R.resolveAdvisoryLoad({ magnitude: mag(cand(5, 5.125)) });
  assert.equal(r.resolutionState, 'ADVISORY'); assert.equal(r.realizableLoad, 5.125); assert.equal(r.roundingReason, 'ADVISORY_RAW');
});

test('T582-U3 unavailable (not invented) when the unit is unknown, the executed load is not positive, or the direction is unknown', () => {
  const unavailable = (m) => { const r = R.resolveAdvisoryLoad({ magnitude: m }); assert.equal(r.resolutionState, 'ADVISORY_UNAVAILABLE'); assert.equal(r.realizableLoad, null); return r.reasons[0]; };
  assert.equal(unavailable(mag({ evidence: { unit: 'stone' } })), 'LOAD_UNIT_UNKNOWN'); assert.equal(unavailable(mag({ evidence: {} })), 'LOAD_UNIT_UNKNOWN');
  assert.equal(unavailable(mag(cand(0, 5))), 'LOAD_BASE_INVALID'); assert.equal(unavailable(mag(cand(null, 105))), 'LOAD_BASE_INVALID'); assert.equal(unavailable(mag(cand(100, -3))), 'LOAD_BASE_INVALID');
  assert.equal(unavailable(mag({ direction: null })), 'DIRECTION_UNKNOWN'); assert.equal(unavailable(mag({ direction: 'SIDEWAYS' })), 'DIRECTION_UNKNOWN');
  assert.equal(R.resolveAdvisoryLoad({ magnitude: { candidates: [{ dimension: 'REPS' }] } }), null, 'not a LOAD candidate');
  assert.equal(R.resolveAdvisoryLoad({}), null);
});

test('T582-U4 the verified-equipment resolver is untouched: with no equipment it still reports the unresolved states (the executor, not the resolver, chooses the advisory fallback)', () => {
  const r = R.resolveForCandidate({ magnitude: mag(), equipment: { equipmentId: null } });
  assert.notEqual(r.resolutionState, 'RESOLVED'); assert.notEqual(r.resolutionState, 'ADVISORY');
});

// ---- consumer: the activation guard (verifyActivationPreconditions) ----
function record() {
  const m = { mode: 'SHADOW', eligible: true, ruleId: 'A', dimension: 'LOAD', direction: 'UP', directionConsistency: 'CONSISTENT', comparableExposureCount: 2, numericApplyAllowed: false,
    methodologyFamily: 'EHRENSTEIN_APEKS_DERIVED', ruleAuthority: 'VDSEN_HEURISTIC', evidenceLevel: 'C', reasonCodes: [], unresolved: null, coachReviewRequired: null, evidence: { unit: 'KG', load: 100 },
    candidates: [{ dimension: 'LOAD', ruleId: 'A', previousValue: 100, rawCandidate: 105, finalCandidate: null, blockers: [] }] };
  return { key: 'v1_0123456789abcdef', clientId: 'c1', planId: 'p1', prescriptionExerciseId: 'pid-1', state: 'PENDING', revision: 1, source: { week: 1, dayIndex: 0, calculatedAt: '2026-09-27T12:00:00.000Z' }, nextExposure: { week: 2, dayIndex: 0 }, magnitude: m };
}
const overlayFor = (rec, er, o) => Object.assign({ key: 'ovl_' + rec.key, sourceRecordKey: rec.key, clientId: rec.clientId, planId: rec.planId, prescriptionExerciseId: rec.prescriptionExerciseId, source: { week: 1, dayIndex: 0 }, target: { week: 2, dayIndex: 0 },
  dimension: 'LOAD', previousValue: 100, requestedValue: 105, appliedValue: er.realizableLoad, unit: er.unit, equipmentId: null }, o || {});
const ctx = (er, o) => Object.assign({ clientId: 'c1', planId: 'p1', activePlanId: 'p1', plan: { updatedAt: '2026-09-26T00:00:00.000Z' }, entries: {}, interventions: [], equipmentResolution: er }, o || {});
const guard = (er, mutate) => { const rec = record(), c = ctx(er); let ov = overlayFor(rec, er); if (mutate) { const r = mutate(c, ov, rec); if (r) ov = r; } return C.verifyActivationPreconditions({ record: rec, overlay: ov, context: c }); };
const ER = R.resolveAdvisoryLoad({ magnitude: record().magnitude });

test('T582-U5 guard: an ADVISORY load passes WITHOUT any equipment identity / increment (and the 19 checks still exist)', () => {
  assert.equal(C.GUARD_CHECKS.length, 19); const g = guard(ER);
  assert.deepEqual(g.failed, [], JSON.stringify(g.failed)); assert.ok(g.ok);
});

test('T582-U6 guard: everything else is still re-verified for an advisory load (stale plan, Coach decision, started exposure, safety, other client, wrong direction, wrong unit)', () => {
  assert.deepEqual(guard(ER, (c) => { c.plan.updatedAt = '2026-09-28T00:00:00.000Z'; }).failed, ['planNotChanged']);
  assert.deepEqual(guard(ER, (c) => { c.interventions = [{ targetType: 'EXERCISE', targetId: 'pid-1', action: 'REDUCE_SETS', decidedAt: '2026-09-27T14:00:00.000Z' }]; }).failed, ['noCoachOverride']);
  assert.deepEqual(guard(ER, (c) => { c.entries = { log_2_0_0_s0: { done: true, prescriptionExerciseId: 'pid-1' } }; }).failed, ['targetNotStarted']);
  assert.deepEqual(guard(ER, (c) => { c.safetyConflict = true; }).failed, ['noSafetyConflict']);
  assert.ok(guard(ER, (c) => { c.clientId = 'other'; }).failed.includes('exactClient'));
  assert.ok(guard(ER, (c, ov) => Object.assign({}, ov, { appliedValue: 95 })).failed.includes('physicallyRealizable'));
  assert.ok(guard(ER, (c, ov) => Object.assign({}, ov, { unit: 'LB' })).failed.includes('unitCompatible'));
});

test('T582-U7 guard: a resolution that merely CALLS itself advisory cannot smuggle an equipment claim or a configured source', () => {
  assert.ok(guard(ER, (c, ov) => Object.assign({}, ov, { equipmentId: 'fake-machine' })).failed.includes('equipmentIdentityResolved'), 'overlay claims equipment but the resolution has none');
  const withId = Object.assign({}, ER, { equipmentId: 'fake-machine' });
  assert.ok(guard(withId, (c, ov) => Object.assign({}, ov, { equipmentId: 'fake-machine' })).failed.length > 0, 'an ADVISORY resolution that names a machine is not advisory and fails the verified path');
  const forged = Object.assign({}, ER, { incrementSource: 'COACH_CONFIGURED' });
  assert.ok(guard(forged).failed.includes('equipmentIncrementResolved') || guard(forged).failed.includes('equipmentIdentityResolved'), 'ADVISORY state with a configured source is rejected');
  const rec = record(), none = C.verifyActivationPreconditions({ record: rec, overlay: overlayFor(rec, ER), context: ctx(null) });
  assert.ok(none.failed.includes('equipmentIdentityResolved'), 'the consumer itself never invents a resolution: the trusted executor supplies it');
});

test('T582-U8 the new blocker belongs to exactly one readiness gate and one preview class', () => {
  assert.equal(C.BLOCKERS.ADVISORY_LOAD_UNAVAILABLE, 'ADVISORY_LOAD_UNAVAILABLE');
  assert.equal(Object.values(C.GATES).filter((list) => list.includes('ADVISORY_LOAD_UNAVAILABLE')).length, 1);
  assert.equal(Object.values(C.PREVIEW_CLASSES).filter((list) => list.includes('ADVISORY_LOAD_UNAVAILABLE')).length, 1);
});
