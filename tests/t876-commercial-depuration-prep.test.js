'use strict';
// T876 — Commercial Depuration & Official T587 Plan-Timestamp Normalization Prep Tests.
// Validates 25 ACTIVE / 4 INACTIVE / 38 UNCONFIRMED separation, T546 fail-closed contract
// (no silent runtime fallback to createdAt), official T587 policy='created' normalization
// preserving all authentic historical sets without mutating days/PIDs, cohort <= 10
// isolation, runtime authorization, idempotency, COACH_REVIEW_REQUIRED, and STOP safety.

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../api/_numericPilotContract.js');
const cohortOps = require('../scripts/pilot/numeric-cohort-ops.cjs');
const normLib = require('../scripts/plans/plan-normalization-lib.cjs');
const shadow = require('../assets/progression-auto-apply-shadow.js');
const policy = require('../assets/progression-magnitude-policy.js');
const consumer = require('../assets/progression-application-consumer.js');

const SHA = 'b6c4b86d48e473950a7ad19486c380b7b52ddc9f';
const COACH_ID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const STARTS = '2026-11-24T12:30:00Z';
const EXPIRES = '2026-12-22T12:30:00Z';

function makeSyntheticRoster67(reg) {
  const clients = [];
  const plans = {};
  const activeUids = [...reg.activeSet].sort();
  const inactiveUids = [...reg.inactiveSet].sort();
  const pending3 = new Set([
    '6yRKI7cymTTUPEtyB32AKx3OYOZ2', // América Balladares (255 sets)
    'c51AshFv1mObncwwLP9PV0wihMN2', // Laura HV (89 sets)
    'fwD2lX25IiO8MCobyoispPMZEws2', // Denisse GA (515 sets)
  ]);

  activeUids.forEach((uid, i) => {
    const planId = 'planAct' + String(i).padStart(13, '0');
    clients.push({ _id: uid, coachId: COACH_ID, activePlanId: planId });
    plans[planId] = {
      clientId: uid,
      status: 'active',
      weeks: 6,
      createdAt: '2026-09-23T04:01:28.953Z',
      updatedAt: pending3.has(uid) ? null : '2026-11-10T10:00:00.000Z',
      days: [{
        dayIndex: 0,
        exercises: [
          { prescriptionExerciseId: 'pid-act-' + i + '-a', sets: [{ setIndex: 0, repsTarget: 12, rirTarget: 3, restSeconds: 75 }] },
          { prescriptionExerciseId: 'pid-act-' + i + '-b', sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 2, restSeconds: 90 }] },
        ],
      }],
    };
  });

  inactiveUids.forEach((uid, i) => {
    const planId = 'planIna' + String(i).padStart(13, '0');
    clients.push({ _id: uid, coachId: COACH_ID, activePlanId: planId });
    plans[planId] = {
      clientId: uid,
      status: 'active',
      weeks: 6,
      createdAt: '2026-09-10T04:00:00.000Z',
      updatedAt: i === 0 ? '2026-11-16T13:17:36.176Z' : null,
      days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: 'pid-ina-' + i }] }],
    };
  });

  for (let i = 0; i < 38; i++) {
    const uid = 'unconfirmedClientUid' + String(i).padStart(8, '0');
    if (i < 25) {
      clients.push({ _id: uid, coachId: COACH_ID, activePlanId: null });
    } else {
      const planId = 'planLeg' + String(i).padStart(13, '0');
      clients.push({ _id: uid, coachId: COACH_ID, activePlanId: planId });
      plans[planId] = { clientId: uid, status: 'active', createdAt: '2026-08-01T00:00:00.000Z', days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Legacy no PID' }] }] };
    }
  }
  return { clients, plans };
}

test('T876.1 Commercial manifest & 67-client separation: 25 ACTIVE (22 VALID + 3 PENDING_FINALIZATION), 4 INACTIVE excluded, 38 UNCONFIRMED preserved', () => {
  const reg = cohortOps.loadCommercialRoster();
  assert.ok(reg, 'commercial roster manifest must load');
  assert.equal(reg.activeSet.size, 25);
  assert.equal(reg.inactiveSet.size, 4);

  const { clients, plans } = makeSyntheticRoster67(reg);
  assert.equal(clients.length, 67);

  const m = cohortOps.buildCohortsFromRoster(clients, plans, {
    runtimeSha: SHA,
    operationId: 'T876-COMMERCIAL-PREP',
    startsAt: STARTS,
    expiresAt: EXPIRES,
    commercialRegistry: reg,
  });

  assert.equal(m.totalClients, 67);
  assert.equal(m.eligibleCount, 25);
  assert.equal(m.eligibleWithUpdatedAt, 22);
  assert.equal(m.eligibleMissingUpdatedAt, 3);
  assert.equal(m.excludedCount, 42);
  assert.equal(m.excludedByReason.COMMERCIAL_INACTIVE, 4);
  assert.equal(m.excludedByReason.COMMERCIAL_UNCONFIRMED, 38);
  assert.equal(m.cohortCount, 3);
  assert.deepEqual(m.cohorts.map(c => c.clientCount), [10, 10, 5]);

  const seen = new Set();
  for (const co of m.cohorts) {
    assert.ok(co.clientCount <= 10);
    for (const sh of co.envShards) assert.ok(sh.bytes < 4000);
    for (const uid of co.clientIds) {
      assert.ok(!seen.has(uid), 'no duplicate client across cohorts');
      seen.add(uid);
      assert.ok(reg.activeSet.has(uid), 'only confirmed ACTIVE clients enter cohorts');
      assert.ok(!reg.inactiveSet.has(uid), 'no INACTIVE client enters any cohort');
    }
  }
  assert.equal(seen.size, 25);

  const byUid = Object.fromEntries(m.classifications.map(x => [x.uid, x]));
  // América Balladares: ACTIVE commercially, PENDING_FINALIZATION technically until T587 policy='created'
  assert.equal(byUid['6yRKI7cymTTUPEtyB32AKx3OYOZ2'].commercialStatus, 'ACTIVE');
  assert.equal(byUid['6yRKI7cymTTUPEtyB32AKx3OYOZ2'].planStatus, 'PENDING_FINALIZATION');
  assert.equal(byUid['6yRKI7cymTTUPEtyB32AKx3OYOZ2'].numericStatus, 'AUTHORIZED_PENDING');
  // Operational active client
  assert.equal(byUid['z82EDPvsCaabfMN3eGAP3rpxeMt1'].commercialStatus, 'ACTIVE');
  assert.equal(byUid['z82EDPvsCaabfMN3eGAP3rpxeMt1'].planStatus, 'VALID');
  assert.equal(byUid['z82EDPvsCaabfMN3eGAP3rpxeMt1'].numericStatus, 'ACTIVE');
  // Confirmed inactive client
  assert.equal(byUid['a17vaFJhoLSbZR5CMksPfIWdokR2'].commercialStatus, 'INACTIVE');
  assert.equal(byUid['a17vaFJhoLSbZR5CMksPfIWdokR2'].numericStatus, 'EXCLUDED');
  assert.equal(byUid['a17vaFJhoLSbZR5CMksPfIWdokR2'].cohortId, null);
  // Unconfirmed client is NOT mislabeled as INACTIVE
  assert.equal(byUid['unconfirmedClientUid00000000'].commercialStatus, 'UNCONFIRMED');
  assert.equal(byUid['unconfirmedClientUid00000000'].numericStatus, 'EXCLUDED');
});

test('T876.2 T546 fail-closed contract preserved & T587 policy=created normalization protects historical sets without mutating days/PIDs', () => {
  const pid = 'pid-america-1';
  const createdAt = '2026-09-23T04:01:28.953Z';
  const S = (s) => ({ stringValue: s });
  const I = (n) => ({ integerValue: String(n) });
  const M = (f) => ({ mapValue: { fields: f } });
  const A = (v) => ({ arrayValue: { values: v } });

  // 1. T546.Q fail-closed contract: runtime MUST NOT silently fall back to createdAt when updatedAt is null
  const uneditedRuntimePlan = {
    clientId: '6yRKI7cymTTUPEtyB32AKx3OYOZ2',
    status: 'active',
    weeks: 6,
    createdAt,
    updatedAt: null,
    days: [{
      dayIndex: 0,
      exercises: [{
        prescriptionExerciseId: pid,
        exerciseName: 'Extensión de cuádriceps',
        repsRange: { min: 10, max: 12 },
        sets: [{ setIndex: 0, repsTarget: 12, rirTarget: 3, restSeconds: 75 }],
      }],
    }],
  };
  const shadowBefore = shadow.assess({
    clientId: uneditedRuntimePlan.clientId,
    planId: 'awXtoOlxYE9oT1Emuuj9',
    activePlanId: 'awXtoOlxYE9oT1Emuuj9',
    plan: uneditedRuntimePlan,
    week: 2,
    dayIndex: 0,
    calculatedAt: '2026-09-29T16:00:00.000Z',
    recommendation: { prescriptionExerciseId: pid, action: 'increase_load', newLoad: 52.5, newReps: 10 },
    sourceMatches: true,
    sourcePidCount: 1,
  });
  assert.equal(shadowBefore.state, 'REJECTED');
  assert.equal(shadowBefore.reasonCode, 'PLAN_TIMESTAMP_MISSING');

  // 2. Official T587 normalization (policy: 'created') sets ONLY mask=['updatedAt'] = createdAt
  const fsDocBefore = {
    fields: {
      coachId: S(COACH_ID),
      clientId: S(uneditedRuntimePlan.clientId),
      status: S('active'),
      weeks: I(6),
      createdAt: S(createdAt),
      days: A([M({ dayIndex: I(0), label: S('D1'), exercises: A([M({ exerciseName: S('Extensión de cuádriceps'), prescriptionExerciseId: S(pid), sets: A([M({ setIndex: I(0), repsTarget: I(12), rirTarget: I(3), restSeconds: I(75) })]) })]) })]),
    },
    updateTime: '2026-09-23T04:01:28.953000Z',
  };
  const entries = {
    log_1_0_0_s0: { done: true, prescriptionExerciseId: pid, ts: Date.parse('2026-09-29T15:52:17.810Z') },
    log_2_0_0_s0: { done: true, prescriptionExerciseId: pid, ts: Date.parse('2026-10-06T15:52:17.810Z') },
    log_3_0_0_s0: { done: true, prescriptionExerciseId: pid, ts: Date.parse('2026-10-21T23:21:51.098Z') },
  };
  const impact = normLib.updatedAtImpact(fsDocBefore, entries, '2026-11-24T22:00:00.000Z');
  assert.equal(impact.comparableIfNow, 0, 'stamping now would discard all 3 authentic exposures');
  assert.equal(impact.comparableIfCreated, 3, 'policy=created preserves all 3 authentic exposures');

  const patch = normLib.planPatch(fsDocBefore, { nowIso: '2026-11-24T22:00:00.000Z', policy: 'created' });
  assert.deepEqual(patch.mask, ['updatedAt'], 'only updatedAt field is written');
  assert.ok(!('days' in patch.fields), 'days/PIDs are untouched');
  assert.equal(patch.updatedAt, createdAt, 'uses authentic createdAt, zero fabricated timestamp');
  const fsDocAfter = { fields: Object.assign({}, fsDocBefore.fields, patch.fields) };
  assert.equal(normLib.verifyAfter(fsDocBefore, fsDocAfter).ok, true);

  // 3. After T587 normalization (updatedAt = createdAt): authentic sets after createdAt are kept,
  //    pre-createdAt & foreign-plan sets are excluded, and real later edits invalidate pre-edit sets
  const normalizedPlan = Object.assign({}, uneditedRuntimePlan, { updatedAt: createdAt });
  const prePlanTs = Date.parse('2026-09-20T10:00:00.000Z');
  const validTs = Date.parse('2026-09-29T15:52:17.810Z');
  const evalRes = policy.evaluate({
    clientId: normalizedPlan.clientId,
    planId: 'awXtoOlxYE9oT1Emuuj9',
    prescriptionExerciseId: pid,
    plan: normalizedPlan,
    prescription: normalizedPlan.days[0].exercises[0],
    exposures: [
      { week: 1, dayIndex: 0, clientId: normalizedPlan.clientId, planId: 'awXtoOlxYE9oT1Emuuj9', prescriptionExerciseId: pid, sets: [{ done: true, reps: 10, rir: 3, carga: 50, unit: 'KG', ts: prePlanTs }] },
      { week: 2, dayIndex: 0, clientId: normalizedPlan.clientId, planId: 'awXtoOlxYE9oT1Emuuj9', prescriptionExerciseId: pid, sets: [{ done: true, reps: 10, rir: 3, carga: 50, unit: 'KG', ts: validTs }] },
      { week: 2, dayIndex: 0, clientId: normalizedPlan.clientId, planId: 'foreign-plan', prescriptionExerciseId: pid, sets: [{ done: true, reps: 12, rir: 2, carga: 60, unit: 'KG', ts: validTs }] },
    ],
  });
  assert.equal(evalRes.comparableExposureCount, 1);
  assert.ok(evalRes.excludedExposures.some(e => e.reason === 'PRESCRIPTION_CHANGED'));
  assert.ok(evalRes.excludedExposures.some(e => e.reason === 'PLAN_MISMATCH'));

  // Real later Coach edit invalidates pre-edit exposure
  const editedLater = Object.assign({}, normalizedPlan, { updatedAt: '2026-10-15T00:00:00.000Z' });
  const afterEdit = policy.evaluate({
    clientId: editedLater.clientId,
    planId: 'awXtoOlxYE9oT1Emuuj9',
    prescriptionExerciseId: pid,
    plan: editedLater,
    prescription: editedLater.days[0].exercises[0],
    exposures: [
      { week: 2, dayIndex: 0, clientId: editedLater.clientId, planId: 'awXtoOlxYE9oT1Emuuj9', prescriptionExerciseId: pid, sets: [{ done: true, reps: 10, rir: 3, carga: 50, unit: 'KG', ts: validTs }] },
    ],
  });
  assert.equal(afterEdit.comparableExposureCount, 0);
  assert.ok(afterEdit.excludedExposures.some(e => e.reason === 'PRESCRIPTION_CHANGED'));

  // COACH_REVIEW_REQUIRED preserved when RIR is harder than prescribed
  const hardEval = policy.evaluate({
    clientId: normalizedPlan.clientId,
    planId: 'awXtoOlxYE9oT1Emuuj9',
    prescriptionExerciseId: pid,
    plan: normalizedPlan,
    prescription: normalizedPlan.days[0].exercises[0],
    exposures: [
      { week: 2, dayIndex: 0, clientId: normalizedPlan.clientId, planId: 'awXtoOlxYE9oT1Emuuj9', prescriptionExerciseId: pid, sets: [{ done: true, reps: 8, rir: 0, carga: 50, unit: 'KG', ts: validTs }] },
    ],
  });
  assert.equal(hardEval.coachReviewRequired && hardEval.coachReviewRequired.code, 'COACH_REVIEW_REQUIRED');
  assert.equal(hardEval.candidates.length, 0);
});

test('T876.3 Runtime authorization strictly rejects the 4 INACTIVE and 38 UNCONFIRMED clients, enforces idempotency & STOP revocation', () => {
  const reg = cohortOps.loadCommercialRoster();
  const { clients, plans } = makeSyntheticRoster67(reg);
  const m = cohortOps.buildCohortsFromRoster(clients, plans, {
    runtimeSha: SHA,
    operationId: 'T876-COMMERCIAL-PREP',
    startsAt: STARTS,
    expiresAt: EXPIRES,
    commercialRegistry: reg,
  });

  const env = {
    AUTONOMOUS_PROGRESSION_ENABLED: 'true',
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: SHA,
  };
  for (const co of m.cohorts) {
    for (const sh of co.envShards) env[sh.name] = JSON.stringify(sh.windows);
  }
  const nowMs = Date.parse('2026-11-25T12:00:00Z');

  for (const uid of reg.activeSet) {
    const auth = C.runtimeAuthorization(env, nowMs, uid);
    assert.ok(auth, 'ACTIVE client must be authorized: ' + uid);
    assert.equal(auth.uid, uid);
  }
  for (const uid of reg.inactiveSet) {
    assert.equal(C.runtimeAuthorization(env, nowMs, uid), null, 'INACTIVE client must be rejected: ' + uid);
  }
  assert.equal(C.runtimeAuthorization(env, nowMs, 'unconfirmedClientUid00000000'), null);

  // STOP fence revocation blocks transactionAllowed immediately; idempotency blocks already-applied recordKey
  const c0 = m.cohorts[0].clients[0];
  const pid = c0.pids[0];
  const planObj = plans[c0.planId];
  const auth = C.runtimeAuthorization(env, nowMs, c0.uid);
  const rec = { key: 'rec-t876-1', state: 'PENDING', prescriptionExerciseId: pid };
  const release = { enabled: true, clientIds: m.cohorts[0].clientIds, expiresAt: EXPIRES };
  const scope = { enabled: true, cohort: true, cohorts: { [m.cohorts[0].cohortId]: { enabled: true, clientIds: m.cohorts[0].clientIds, prescriptionExerciseIds: m.cohorts[0].allPids } } };
  const activeFence = Object.assign({}, auth, { enabled: true, pids: c0.pids });
  const stoppedFence = Object.assign({}, auth, { enabled: false, pids: c0.pids });
  const ledgerNew = { schema: 'vdsen-numeric-operations-ledger-v1', status: 'RESERVED', operationId: auth.operationId, runtimeSha: SHA, windows: { [c0.uid]: auth }, scope: { enabled: true, clientIds: m.cohorts[0].clientIds, prescriptionExerciseIds: m.cohorts[0].allPids }, appliedRecordKeys: [] };
  const ledgerApplied = Object.assign({}, ledgerNew, { appliedRecordKeys: [rec.key] });

  assert.equal(C.transactionAllowed(auth, auth, activeFence, release, scope, c0.uid, rec, planObj, ledgerNew, rec.key), true);
  assert.equal(C.transactionAllowed(auth, auth, activeFence, release, scope, c0.uid, rec, planObj, ledgerApplied, rec.key), false, 'idempotency blocks duplicate application');
  assert.equal(C.transactionAllowed(auth, auth, stoppedFence, release, scope, c0.uid, rec, planObj, ledgerNew, rec.key), false, 'STOP immediately blocks transaction');

  // Consumer rejects unedited plan with updatedAt=null (T546 fail-closed) and passes after T587 updatedAt=createdAt
  const dryRec = shadow.buildRecord({
    clientId: c0.uid, planId: c0.planId, activePlanId: c0.planId, plan: planObj,
    week: 2, dayIndex: 0, calculatedAt: '2026-11-20T12:00:00.000Z',
    recommendation: { prescriptionExerciseId: pid, action: 'increase_load', newLoad: 52.5, newReps: 10 },
    sourceMatches: true, sourcePidCount: 1,
    magnitude: { eligible: true, comparableExposureCount: 1, minExposures: 1, directionConsistency: 'NOT_APPLICABLE', coachReviewRequired: false, candidates: [{ dimension: 'REST', ruleId: 'C', previousValue: 75, nextValue: 105, delta: 30, unit: 's' }], reasonCodes: [] },
  }, { at: '2026-11-20T12:00:00.000Z' });
  const blocked = consumer.planApplication({ record: dryRec, context: { clientId: c0.uid, planId: c0.planId, activePlanId: c0.planId, plan: Object.assign({}, planObj, { updatedAt: null }), entries: {}, interventions: [] } });
  assert.ok(blocked.blockers.includes('PLAN_CHANGED'));
  const unblocked = consumer.planApplication({ record: dryRec, context: { clientId: c0.uid, planId: c0.planId, activePlanId: c0.planId, plan: Object.assign({}, planObj, { updatedAt: planObj.createdAt }), entries: {}, interventions: [] } });
  assert.ok(!unblocked.blockers.includes('PLAN_CHANGED'));
});
