'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const planSync = require('../api/_planActivationSync.js');

const { parseAndEvaluatePilotScope, makeHandler } = planSync;

const NOW = Date.parse('2026-11-26T12:00:00Z');
const SHA = 'b57e8291bc1b258beec9cbd55824b7c87b80e4d1';

function makeValidScope(overrides = {}) {
  return Object.assign({
    schema: 'vdsen-auto-renewal-pilot-scope-v1',
    uid: 'client-pilot-01',
    planId: 'plan-new-json',
    cohortId: 'cohort-01',
    operationId: 'T881-PILOT-20261126',
    startsAt: '2026-11-26T10:00:00Z',
    expiresAt: '2026-11-27T10:00:00Z',
  }, overrides);
}

function makeFakeDb(docs) {
  const store = new Map(Object.entries(docs));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const mkRef = (p) => ({
    path: p,
    id: p.split('/').pop(),
    get: async () => ({ exists: store.has(p), id: p.split('/').pop(), data: () => (store.has(p) ? clone(store.get(p)) : undefined) }),
    set: async (data, opts) => {
      if (opts && opts.merge && store.has(p)) store.set(p, Object.assign({}, store.get(p), clone(data)));
      else store.set(p, clone(data));
    },
    update: async (data) => { store.set(p, Object.assign({}, store.get(p) || {}, clone(data))); },
    collection: (sub) => mkCol(p + '/' + sub),
  });
  const mkCol = (base) => ({
    doc: (id) => mkRef(base + '/' + id),
  });
  return {
    store,
    doc: (p) => mkRef(p),
    collection: (name) => mkCol(name),
    runTransaction: async (fn) => {
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => {
          if (opts && opts.merge && store.has(ref.path)) store.set(ref.path, Object.assign({}, store.get(ref.path), clone(data)));
          else store.set(ref.path, clone(data));
        },
        update: (ref, data) => { store.set(ref.path, Object.assign({}, store.get(ref.path) || {}, clone(data))); },
      };
      return fn(tx);
    },
  };
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function makeBaseDocs() {
  return {
    'clients/client-pilot-01': { uid: 'client-pilot-01', status: 'active', coachId: 'coach-1', activePlanId: 'plan-new-json' },
    'clients/client-other-02': { uid: 'client-other-02', status: 'active', coachId: 'coach-1', activePlanId: 'plan-other-new' },
    'plans/plan-new-json': {
      clientId: 'client-pilot-01',
      coachId: 'coach-1',
      status: 'active',
      updatedAt: '2026-11-26T11:55:00Z',
      days: [{ exercises: [{ name: 'Press', prescriptionExerciseId: '11111111-1111-4111-8111-111111111111' }] }],
    },
    'plans/plan-other-new': {
      clientId: 'client-other-02',
      coachId: 'coach-1',
      status: 'active',
      updatedAt: '2026-11-26T11:55:00Z',
      days: [{ exercises: [{ name: 'Squat', prescriptionExerciseId: '22222222-2222-4222-8222-222222222222' }] }],
    },
    'releaseControl/autonomousProgression_cohort_cohort-01': {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      cohortId: 'cohort-01',
      operationId: 'op-c1-old',
      startsAt: '2026-11-26T05:15:00Z',
      expiresAt: '2026-12-24T05:15:00Z',
      clientIds: ['client-pilot-01', 'client-other-02'],
    },
    'releaseControl/numericPilot_cohort_cohort-01': {
      schema: 'vdsen-numeric-cohort-v1',
      mode: 'NUMERIC_APPLY',
      enabled: true,
      cohortId: 'cohort-01',
      operationId: 'op-c1-old',
      runtimeSha: SHA,
      startsAt: '2026-11-26T05:15:00Z',
      expiresAt: '2026-12-24T05:15:00Z',
      windows: {
        'client-pilot-01': { schema: 'vdsen-numeric-cohort-v1', mode: 'NUMERIC_APPLY', cohortId: 'cohort-01', enabled: true, uid: 'client-pilot-01', planId: 'plan-old-01', pids: ['old-pid'], pidCount: 1, pidsHash: 'a'.repeat(64), runtimeSha: SHA, operationId: 'op-c1-old', startsAt: '2026-11-26T05:15:00Z', expiresAt: '2026-12-24T05:15:00Z' },
        'client-other-02': { schema: 'vdsen-numeric-cohort-v1', mode: 'NUMERIC_APPLY', cohortId: 'cohort-01', enabled: true, uid: 'client-other-02', planId: 'plan-old-02', pids: ['old-pid-2'], pidCount: 1, pidsHash: 'b'.repeat(64), runtimeSha: SHA, operationId: 'op-c1-old', startsAt: '2026-11-26T05:15:00Z', expiresAt: '2026-12-24T05:15:00Z' },
      },
    },
    'coaches/coach-1': {
      uid: 'coach-1',
      autoApplyCanary: {
        enabled: true,
        cohorts: {
          'cohort-01': {
            enabled: true,
            cohortId: 'cohort-01',
            operationId: 'op-c1-old',
            startsAt: '2026-11-26T05:15:00Z',
            expiresAt: '2026-12-24T05:15:00Z',
            clientIds: ['client-pilot-01', 'client-other-02'],
            prescriptionExerciseIds: ['old-pid', 'old-pid-2'],
          },
        },
      },
    },
  };
}

test('T881-B.1: parseAndEvaluatePilotScope allows pass-through when unconfigured', () => {
  for (const empty of [undefined, null, '', '   ']) {
    const r = parseAndEvaluatePilotScope(empty, { clientId: 'client-pilot-01', planId: 'plan-1', nowMs: NOW });
    assert.deepEqual(r, { active: false, allowed: true, reason: null, scope: null });
  }
});

test('T881-B.2: parseAndEvaluatePilotScope enforces single UID, mandatory planId, cohortId, operationId, and bounded window fail-closed', () => {
  const validJson = JSON.stringify(makeValidScope());
  const ok = parseAndEvaluatePilotScope(validJson, { clientId: 'client-pilot-01', planId: 'plan-new-json', cohortId: 'cohort-01', requestedOperationId: 'T881-PILOT-20261126', nowMs: NOW });
  assert.equal(ok.active, true);
  assert.equal(ok.allowed, true);
  assert.equal(ok.reason, null);

  const missingPlan = parseAndEvaluatePilotScope(JSON.stringify(makeValidScope({ planId: '' })), { clientId: 'client-pilot-01', planId: 'plan-new-json', cohortId: 'cohort-01', nowMs: NOW });
  assert.equal(missingPlan.allowed, false);
  assert.equal(missingPlan.reason, 'PILOT_SCOPE_PLAN_ID_REQUIRED');

  const otherUid = parseAndEvaluatePilotScope(validJson, { clientId: 'client-other-02', planId: 'plan-new-json', cohortId: 'cohort-01', nowMs: NOW });
  assert.equal(otherUid.active, true);
  assert.equal(otherUid.allowed, false);
  assert.equal(otherUid.reason, 'PILOT_SCOPE_UID_MISMATCH');

  const wrongPlan = parseAndEvaluatePilotScope(validJson, { clientId: 'client-pilot-01', planId: 'plan-different', cohortId: 'cohort-01', nowMs: NOW });
  assert.equal(wrongPlan.allowed, false);
  assert.equal(wrongPlan.reason, 'PILOT_SCOPE_PLAN_MISMATCH');

  const wrongCohort = parseAndEvaluatePilotScope(validJson, { clientId: 'client-pilot-01', planId: 'plan-new-json', cohortId: 'cohort-02', nowMs: NOW });
  assert.equal(wrongCohort.allowed, false);
  assert.equal(wrongCohort.reason, 'PILOT_SCOPE_COHORT_MISMATCH');

  const wrongOp = parseAndEvaluatePilotScope(validJson, { clientId: 'client-pilot-01', planId: 'plan-new-json', cohortId: 'cohort-01', requestedOperationId: 'OTHER-OP-9999', nowMs: NOW });
  assert.equal(wrongOp.allowed, false);
  assert.equal(wrongOp.reason, 'PILOT_SCOPE_OPERATION_ID_MISMATCH');

  const consumed = parseAndEvaluatePilotScope(validJson, { clientId: 'client-pilot-01', planId: 'plan-new-json', cohortId: 'cohort-01', consumedAuth: { uid: 'client-pilot-01', planId: 'plan-new-json', cohortId: 'cohort-01', consumed: true }, nowMs: NOW });
  assert.equal(consumed.allowed, false);
  assert.equal(consumed.reason, 'PILOT_SCOPE_ALREADY_CONSUMED');

  assert.equal(parseAndEvaluatePilotScope('', { requireScope: true, clientId: 'client-pilot-01', nowMs: NOW }).reason, 'PILOT_SCOPE_MISSING');
  assert.equal(parseAndEvaluatePilotScope('{broken', { clientId: 'client-pilot-01', nowMs: NOW }).reason, 'PILOT_SCOPE_INVALID_JSON');
  assert.equal(parseAndEvaluatePilotScope(JSON.stringify(makeValidScope({ schema: 'wrong' })), { clientId: 'client-pilot-01', nowMs: NOW }).reason, 'PILOT_SCOPE_INVALID_SCHEMA');
  assert.equal(parseAndEvaluatePilotScope(JSON.stringify(makeValidScope({ startsAt: '2026-11-26T13:00:00Z' })), { clientId: 'client-pilot-01', nowMs: NOW }).reason, 'PILOT_SCOPE_NOT_STARTED');
  assert.equal(parseAndEvaluatePilotScope(JSON.stringify(makeValidScope({ expiresAt: '2026-11-26T11:00:00Z' })), { clientId: 'client-pilot-01', nowMs: NOW }).reason, 'PILOT_SCOPE_EXPIRED');
  assert.equal(parseAndEvaluatePilotScope(JSON.stringify(makeValidScope({ expiresAt: '2026-12-10T10:00:00Z' })), { clientId: 'client-pilot-01', nowMs: NOW }).reason, 'PILOT_SCOPE_WINDOW_BOUNDS_INVALID');
});

test('T881-B.3: makeHandler blocks non-pilot active client even when autoRenewalEnabled=true without touching fences or shard sync', async () => {
  const db = makeFakeDb(makeBaseDocs());
  let syncCalls = 0;
  const handler = makeHandler({
    db,
    verifyIdToken: async () => ({ uid: 'coach-1' }),
    commercialRoster: () => ({ schema: 'vdsen-commercial-roster-v1', firebaseProject: 'vdsen-ecosistema', activeUids: ['client-pilot-01', 'client-other-02'], inactiveUids: [] }),
    autoRenewalEnabled: true,
    pilotScope: JSON.stringify(makeValidScope()),
    runtimeSha: SHA,
    clock: () => '2026-11-26T12:00:00Z',
    syncCohortRuntimeEnv: async () => { syncCalls++; return { ok: true, verified: true, servedDeploymentVerified: true }; },
  });

  const res = makeRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: { clientId: 'client-other-02', planId: 'plan-other-new' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'AUTHORIZATION_PENDING');
  assert.equal(res.body.renewed, false);
  assert.equal(res.body.pilotScopeBlocked, true);
  assert.equal(res.body.pilotScopeReason, 'PILOT_SCOPE_UID_MISMATCH');
  assert.equal(syncCalls, 0);
  // Existing fences stay untouched
  assert.equal(db.store.get('releaseControl/numericPilot_cohort_cohort-01').windows['client-other-02'].planId, 'plan-old-02');
});

test('T881-B.4: makeHandler permits ONLY the scoped pilot UID and rejects malformed pilotScope fail-closed', async () => {
  const db = makeFakeDb(makeBaseDocs());
  let syncCalls = 0;
  const badHandler = makeHandler({
    db,
    verifyIdToken: async () => ({ uid: 'coach-1' }),
    commercialRoster: () => ({ schema: 'vdsen-commercial-roster-v1', firebaseProject: 'vdsen-ecosistema', activeUids: ['client-pilot-01', 'client-other-02'], inactiveUids: [] }),
    autoRenewalEnabled: true,
    pilotScope: '{not-valid-json',
    runtimeSha: SHA,
    clock: () => '2026-11-26T12:00:00Z',
    syncCohortRuntimeEnv: async () => { syncCalls++; return { ok: true, verified: true, servedDeploymentVerified: true }; },
  });

  const badRes = makeRes();
  await badHandler({
    method: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: { clientId: 'client-pilot-01', planId: 'plan-new-json' },
  }, badRes);
  assert.equal(badRes.statusCode, 200);
  assert.equal(badRes.body.status, 'AUTHORIZATION_PENDING');
  assert.equal(badRes.body.pilotScopeBlocked, true);
  assert.equal(badRes.body.pilotScopeReason, 'PILOT_SCOPE_INVALID_JSON');
  assert.equal(syncCalls, 0);

  const okHandler = makeHandler({
    db,
    verifyIdToken: async () => ({ uid: 'coach-1' }),
    commercialRoster: () => ({ schema: 'vdsen-commercial-roster-v1', firebaseProject: 'vdsen-ecosistema', activeUids: ['client-pilot-01', 'client-other-02'], inactiveUids: [] }),
    autoRenewalEnabled: true,
    pilotScope: JSON.stringify(makeValidScope()),
    runtimeSha: SHA,
    clock: () => '2026-11-26T12:00:00Z',
    syncCohortRuntimeEnv: async () => { syncCalls++; return { ok: true, verified: true, servedDeploymentVerified: true }; },
  });
  const okRes = makeRes();
  await okHandler({
    method: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: { clientId: 'client-pilot-01', planId: 'plan-new-json' },
  }, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.status, 'RENEWED_VERIFIED');
  assert.equal(okRes.body.renewed, true);
  assert.equal(syncCalls, 1);
  // Other client in the same cohort kept its original planId untouched
  assert.equal(db.store.get('releaseControl/numericPilot_cohort_cohort-01').windows['client-other-02'].planId, 'plan-old-02');
});

test('T881-B.5: api/autonomous-progression-trigger.js wires VDSEN_AUTO_COHORT_RENEWAL_PILOT_SCOPE into planSyncLib', () => {
  const src = fs.readFileSync('api/autonomous-progression-trigger.js', 'utf8');
  assert.ok(src.includes('VDSEN_AUTO_COHORT_RENEWAL_PILOT_SCOPE'), 'defaultHandler must wire VDSEN_AUTO_COHORT_RENEWAL_PILOT_SCOPE');
  assert.ok(src.includes('pilotScope: deps.pilotScope'), 'makeHandler must forward pilotScope to planSyncLib');
});
