'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const planSync = require('../api/_planActivationSync.js');
const cohortOps = require('../scripts/pilot/numeric-cohort-ops.cjs');
const pilotOps = require('../scripts/pilot/numeric-pilot-ops.cjs');
const numericGuard = require('../scripts/release/numeric-guard.cjs');

function makeDisarmedGuardEvidence() {
  return numericGuard.evaluateProductionEnv([
    { id: 'e1', key: 'AUTONOMOUS_PROGRESSION_ENABLED', type: 'plain', target: ['production'], value: 'false', updatedAt: 1793494508147 },
    { id: 'e2', key: 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', type: 'plain', target: ['production'], value: 'false', updatedAt: 1793494240690 },
  ], { project: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN', team: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8' });
}

const {
  RENEWAL_STATES,
  resolveAutoRenewalMode,
  parseAndEvaluatePilotScope,
  createGitHubActionsRenewalDispatcher,
  makeHandler,
} = planSync;

const SHA = 'b57e8291bc1b258beec9cbd55824b7c87b80e4d1';
const NOW_ISO = '2026-11-26T12:00:00Z';
const EXP_ISO = '2026-12-24T05:15:00Z';

function makeFakeDb(docs = {}) {
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
    collection: (sub) => ({ doc: (id) => mkRef(p + '/' + sub + '/' + id) }),
  });
  return {
    store,
    doc: (p) => mkRef(p),
    collection: (name) => ({ doc: (id) => mkRef(name + '/' + id) }),
    runTransaction: async (fn) => {
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => {
          if (opts && opts.merge && store.has(ref.path)) store.set(ref.path, Object.assign({}, store.get(ref.path), clone(data)));
          else store.set(ref.path, clone(data));
        },
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

function makeMultiCohortDocs() {
  return {
    'clients/client-c1': { uid: 'client-c1', status: 'active', coachId: 'coach-1', activePlanId: 'plan-c1-new' },
    'clients/client-c2': { uid: 'client-c2', status: 'active', coachId: 'coach-1', activePlanId: 'plan-c2-new' },
    'clients/client-inact': { uid: 'client-inact', status: 'active', coachId: 'coach-1', activePlanId: 'plan-inact' },
    'plans/plan-c1-new': {
      clientId: 'client-c1', coachId: 'coach-1', status: 'active', updatedAt: '2026-11-26T11:50:00Z',
      days: [{ exercises: [{ name: 'Press', prescriptionExerciseId: '11111111-1111-4111-8111-111111111111' }] }],
    },
    'plans/plan-c2-new': {
      clientId: 'client-c2', coachId: 'coach-1', status: 'active', updatedAt: '2026-11-26T11:51:00Z',
      days: [{ exercises: [{ name: 'Squat', prescriptionExerciseId: '22222222-2222-4222-8222-222222222222' }] }],
    },
    'plans/plan-inact': {
      clientId: 'client-inact', coachId: 'coach-1', status: 'active', updatedAt: '2026-11-26T11:51:00Z',
      days: [{ exercises: [{ name: 'Curl', prescriptionExerciseId: '33333333-3333-4333-8333-333333333333' }] }],
    },
    'releaseControl/autonomousProgression_cohort_cohort-01': { enabled: true, cohortId: 'cohort-01', startsAt: '2026-11-26T05:15:00Z', expiresAt: EXP_ISO, clientIds: ['client-c1'] },
    'releaseControl/numericPilot_cohort_cohort-01': {
      schema: 'vdsen-numeric-cohort-v1', mode: 'NUMERIC_APPLY', enabled: true, cohortId: 'cohort-01', runtimeSha: SHA, startsAt: '2026-11-26T05:15:00Z', expiresAt: EXP_ISO,
      windows: { 'client-c1': { enabled: true, uid: 'client-c1', planId: 'plan-c1-old', pids: ['old-1'], pidCount: 1, pidsHash: 'a'.repeat(64) } },
    },
    'releaseControl/autonomousProgression_cohort_cohort-02': { enabled: true, cohortId: 'cohort-02', startsAt: '2026-11-26T05:15:00Z', expiresAt: EXP_ISO, clientIds: ['client-c2'] },
    'releaseControl/numericPilot_cohort_cohort-02': {
      schema: 'vdsen-numeric-cohort-v1', mode: 'NUMERIC_APPLY', enabled: true, cohortId: 'cohort-02', runtimeSha: SHA, startsAt: '2026-11-26T05:15:00Z', expiresAt: EXP_ISO,
      windows: { 'client-c2': { enabled: true, uid: 'client-c2', planId: 'plan-c2-old', pids: ['old-2'], pidCount: 1, pidsHash: 'b'.repeat(64) } },
    },
    'coaches/coach-1': {
      uid: 'coach-1',
      autoApplyCanary: {
        enabled: true,
        cohorts: {
          'cohort-01': { enabled: true, cohortId: 'cohort-01', operationId: 'op-c1-old', startsAt: '2026-11-26T05:15:00Z', expiresAt: EXP_ISO, clientIds: ['client-c1'], prescriptionExerciseIds: ['old-1'] },
          'cohort-02': { enabled: true, cohortId: 'cohort-02', operationId: 'op-c2-old', startsAt: '2026-11-26T05:15:00Z', expiresAt: EXP_ISO, clientIds: ['client-c2'], prescriptionExerciseIds: ['old-2'] },
        },
      },
    },
  };
}

function makeManifestWithFiveShards(clientId, planId, cohortId) {
  return {
    cohorts: [
      {
        cohortId: 'cohort-01',
        clientIds: ['client-c1'],
        allPids: ['11111111-1111-4111-8111-111111111111'],
        envVarNames: ['VDSEN_NUMERIC_COHORT_1', 'VDSEN_NUMERIC_COHORT_2'],
        envShards: [
          { name: 'VDSEN_NUMERIC_COHORT_1', windows: [{ cohortId: 'cohort-01', uid: 'client-c1', planId: cohortId === 'cohort-01' ? planId : 'plan-c1-old' }] },
          { name: 'VDSEN_NUMERIC_COHORT_2', windows: [] },
        ],
        clients: [{ uid: 'client-c1', planId: cohortId === 'cohort-01' ? planId : 'plan-c1-old', pids: ['11111111-1111-4111-8111-111111111111'], pidCount: 1, pidsHash: 'c'.repeat(64) }],
      },
      {
        cohortId: 'cohort-02',
        clientIds: ['client-c2'],
        allPids: ['22222222-2222-4222-8222-222222222222'],
        envVarNames: ['VDSEN_NUMERIC_COHORT_3', 'VDSEN_NUMERIC_COHORT_4'],
        envShards: [
          { name: 'VDSEN_NUMERIC_COHORT_3', windows: [{ cohortId: 'cohort-02', uid: 'client-c2', planId: 'plan-c2-old' }] },
          { name: 'VDSEN_NUMERIC_COHORT_4', windows: [] },
        ],
        clients: [{ uid: 'client-c2', planId: 'plan-c2-old', pids: ['22222222-2222-4222-8222-222222222222'], pidCount: 1, pidsHash: 'd'.repeat(64) }],
      },
      {
        cohortId: 'cohort-03',
        clientIds: ['client-c3'],
        allPids: ['33333333-3333-4333-8333-333333333333'],
        envVarNames: ['VDSEN_NUMERIC_COHORT_5'],
        envShards: [
          { name: 'VDSEN_NUMERIC_COHORT_5', windows: [{ cohortId: 'cohort-03', uid: 'client-c3', planId: 'plan-c3-old' }] },
        ],
        clients: [{ uid: 'client-c3', planId: 'plan-c3-old', pids: ['33333333-3333-4333-8333-333333333333'], pidCount: 1, pidsHash: 'e'.repeat(64) }],
      },
    ],
  };
}

test('T882.1: Explicit 3-mode resolution fails closed on incomplete or unknown configuration', () => {
  assert.equal(resolveAutoRenewalMode({}), 'DISABLED');
  assert.equal(resolveAutoRenewalMode({ VDSEN_AUTO_COHORT_RENEWAL_ENABLED: 'true' }), 'DISABLED');
  assert.equal(resolveAutoRenewalMode({ VDSEN_AUTO_COHORT_RENEWAL_ENABLED: 'true', VDSEN_AUTO_COHORT_RENEWAL_MODE: 'unknown' }), 'DISABLED');
  assert.equal(resolveAutoRenewalMode({ VDSEN_AUTO_COHORT_RENEWAL_ENABLED: 'true', VDSEN_AUTO_COHORT_RENEWAL_MODE: 'pilot' }), 'PILOT_RESTRICTED');
  assert.equal(resolveAutoRenewalMode({ VDSEN_AUTO_COHORT_RENEWAL_ENABLED: 'true', VDSEN_AUTO_COHORT_RENEWAL_MODE: 'general' }), 'GENERAL_AUTHORIZED');
  // Partial pilot scope + general mode stays restricted fail-closed
  assert.equal(resolveAutoRenewalMode({ VDSEN_AUTO_COHORT_RENEWAL_ENABLED: 'true', VDSEN_AUTO_COHORT_RENEWAL_MODE: 'general', VDSEN_AUTO_COHORT_RENEWAL_PILOT_SCOPE: '{}' }), 'PILOT_RESTRICTED');
});

test('T882.2: Credential isolation — Vercel API defaultHandler never reads VERCEL_TOKEN and GitHub App dispatcher uses short-lived scoped token', async () => {
  const triggerSrc = fs.readFileSync('api/autonomous-progression-trigger.js', 'utf8');
  assert.ok(!triggerSrc.includes('createVercelCohortShardSyncer'), 'trigger defaultHandler must not wire VERCEL_TOKEN syncer');
  assert.ok(!triggerSrc.includes('VERCEL_TOKEN'), 'trigger must never reference VERCEL_TOKEN');
  assert.ok(triggerSrc.includes('createGitHubActionsRenewalDispatcher'), 'trigger must wire GitHub Actions dispatcher');

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const calls = [];
  const dispatcher = createGitHubActionsRenewalDispatcher({
    VDSEN_GH_RENEWAL_APP_ID: '101',
    VDSEN_GH_RENEWAL_APP_INSTALLATION_ID: '202',
    VDSEN_GH_RENEWAL_APP_PRIVATE_KEY: privateKey,
  }, async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    if (url.includes('/access_tokens')) return { ok: true, status: 201, json: async () => ({ token: 'ghs_ephemeral' }) };
    return { ok: true, status: 204, json: async () => ({}) };
  });
  const r = await dispatcher({
    operationId: 'T882-OP-0001',
    cohortId: 'cohort-03',
    clientId: 'z82EDPvsCaabfMN3eGAP3rpxeMt1',
    planId: 'plan-test',
    coachUid: 'z82EDPvsCaabfMN3eGAP3rpxeMt1',
    runtimeSha: SHA,
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, { repositories: ['vdsen-ecosistema'], permissions: { actions: 'write' } });
  assert.ok(calls[1].url.endsWith('/repos/vdsenasesoria-svg/vdsen-ecosistema/actions/workflows/vdsen-numeric-pilot.yml/dispatches'));
  assert.equal(calls[1].body.ref, 'codex/client-app-next');
  assert.equal(calls[1].body.inputs.action, 'renew-cohort');
});

test('T882.3: Global concurrency serializes simultaneous requests across different cohorts without discarding pending requests + recovers expired lock', async () => {
  const db = makeFakeDb(makeMultiCohortDocs());
  const dispatched = [];
  const handler = makeHandler({
    db,
    verifyIdToken: async () => ({ uid: 'coach-1' }),
    commercialRoster: () => ({ schema: 'vdsen-commercial-roster-v1', firebaseProject: 'vdsen-ecosistema', activeUids: ['client-c1', 'client-c2'], inactiveUids: ['client-inact'] }),
    autoRenewalEnabled: true,
    autoRenewalMode: 'general',
    runtimeSha: SHA,
    clock: () => NOW_ISO,
    dispatchRenewalWorkflow: async (p) => { dispatched.push(p); return { ok: true, dispatched: true }; },
  });

  // Request 1 (cohort-01) acquires global lock and dispatches
  const res1 = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { clientId: 'client-c1', planId: 'plan-c1-new' } }, res1);
  assert.equal(res1.statusCode, 202);
  assert.equal(res1.body.status, RENEWAL_STATES.QUEUED);
  assert.equal(res1.body.workflowDispatched, true);
  assert.equal(dispatched.length, 1);

  // Request 2 (cohort-02) arrives while cohort-01 holds lock -> QUEUED in pendingQueue (NOT discarded!)
  const res2 = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { clientId: 'client-c2', planId: 'plan-c2-new' } }, res2);
  assert.equal(res2.statusCode, 202);
  assert.equal(res2.body.status, RENEWAL_STATES.QUEUED);
  assert.equal(res2.body.workflowDispatched, false);
  assert.equal(res2.body.queuedBehindOperationId, res1.body.operationId);
  assert.equal(dispatched.length, 1);
  assert.equal(db.store.get('releaseControl/numericPilotGlobalLock').pendingQueue.length, 1);

  // Duplicate of Request 1 while in-flight -> 202 alreadyInProgress, zero duplicate dispatch
  const res1Dup = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { clientId: 'client-c1', planId: 'plan-c1-new' } }, res1Dup);
  assert.equal(res1Dup.statusCode, 202);
  assert.equal(res1Dup.body.alreadyInProgress, true);
  assert.equal(dispatched.length, 1);

  // Excluded client is always rejected
  const resInact = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { clientId: 'client-inact', planId: 'plan-inact' } }, resInact);
  assert.equal(resInact.statusCode, 200);
  assert.equal(resInact.body.status, 'NOT_COMMERCIALLY_AUTHORIZED');

  // Expired/abandoned lock recovery: expire lock lease and re-invoke cohort-02 -> recovers lock & dispatches!
  const lock = db.store.get('releaseControl/numericPilotGlobalLock');
  lock.leaseExpiresAt = '2026-11-26T11:00:00Z';
  const op2 = db.store.get('releaseControl/numericPilot/operations/' + res2.body.operationId);
  op2.leaseExpiresAt = '2026-11-26T11:00:00Z';
  const res2Recover = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { clientId: 'client-c2', planId: 'plan-c2-new' } }, res2Recover);
  assert.equal(res2Recover.statusCode, 202);
  assert.equal(res2Recover.body.workflowDispatched, true);
  assert.equal(res2Recover.body.recoveredExpiredLock, true);
  assert.equal(dispatched.length, 2);
});

test('T882.4: Effective STOP fence in Firestore blocks renewals immediately without redeployment + pilot consumed authorization cannot be reused', async () => {
  const docs = makeMultiCohortDocs();
  docs['releaseControl/autoCohortRenewalControl'] = { stopped: true, reason: 'EMERGENCY_STOP_T882' };
  const db = makeFakeDb(docs);
  let dispatches = 0;
  const handler = makeHandler({
    db,
    verifyIdToken: async () => ({ uid: 'coach-1' }),
    commercialRoster: () => ({ schema: 'vdsen-commercial-roster-v1', firebaseProject: 'vdsen-ecosistema', activeUids: ['client-c1', 'client-c2'], inactiveUids: [] }),
    autoRenewalEnabled: true,
    autoRenewalMode: 'pilot',
    pilotScope: JSON.stringify({
      schema: 'vdsen-auto-renewal-pilot-scope-v1',
      uid: 'client-c1',
      planId: 'plan-c1-new',
      cohortId: 'cohort-01',
      operationId: 'T882-PILOT-SINGLE-1',
      startsAt: '2026-11-26T10:00:00Z',
      expiresAt: '2026-11-27T10:00:00Z',
    }),
    runtimeSha: SHA,
    clock: () => NOW_ISO,
    dispatchRenewalWorkflow: async () => { dispatches++; return { ok: true }; },
  });

  // 1. STOP active -> blocked immediately without touching anything
  const rStop = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { clientId: 'client-c1', planId: 'plan-c1-new', operationId: 'T882-PILOT-SINGLE-1' } }, rStop);
  assert.equal(rStop.statusCode, 200);
  assert.equal(rStop.body.status, 'RENEWAL_STOPPED');
  assert.equal(rStop.body.stoppedEffective, true);
  assert.equal(dispatches, 0);

  // 2. Lift STOP -> pilot succeeds once and marks pilotAuthorization consumed
  db.store.delete('releaseControl/autoCohortRenewalControl');
  const rPilot = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { clientId: 'client-c1', planId: 'plan-c1-new', operationId: 'T882-PILOT-SINGLE-1' } }, rPilot);
  assert.equal(rPilot.statusCode, 202);
  assert.equal(rPilot.body.operationId, 'T882-PILOT-SINGLE-1');
  assert.equal(dispatches, 1);
  assert.equal(db.store.get('releaseControl/numericPilot/pilotAuthorizations/T882-PILOT-SINGLE-1').consumed, true);

  // 3. Reusing consumed pilot authorization fails closed
  const rReuse = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { clientId: 'client-c1', planId: 'plan-c1-new', operationId: 'T882-PILOT-SINGLE-1' } }, rReuse);
  assert.equal(rReuse.statusCode, 200);
  assert.equal(rReuse.body.pilotScopeBlocked, true);
  assert.equal(rReuse.body.pilotScopeReason, 'PILOT_SCOPE_ALREADY_CONSUMED');
  assert.equal(dispatches, 1);
});

test('T882.5: executeRenewCohortOperation — happy path preserves 5 shard slots, unaffected cohorts, updates ledger & dispatches next queued op', async () => {
  const store = new Map(Object.entries(makeMultiCohortDocs()));
  store.set('releaseControl/numericPilot/operations/T882-OP-HAPPY', {
    operationId: 'T882-OP-HAPPY', cohortId: 'cohort-01', clientId: 'client-c1', coachUid: 'coach-1',
    planId: 'plan-c1-new', runtimeSha: SHA, startsAt: '2026-11-26T05:15:00Z', expiresAt: EXP_ISO, status: 'QUEUED', history: [],
  });
  store.set('releaseControl/numericPilotGlobalLock', {
    activeOperationId: 'T882-OP-HAPPY', version: 1,
    pendingQueue: [{ operationId: 'T882-OP-NEXT', cohortId: 'cohort-02', clientId: 'client-c2', planId: 'plan-c2-new' }],
  });
  let liveAlias = 'dpl_prev_live';
  let nextDispatched = null;
  const rep = await cohortOps.executeRenewCohortOperation({
    operationId: 'T882-OP-HAPPY',
    runId: '999001',
    io: {
      readDoc: async (p) => store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null,
      writeDoc: async (p, d) => { store.set(p, JSON.parse(JSON.stringify(d))); },
      loadLiveRoster: async () => makeManifestWithFiveShards('client-c1', 'plan-c1-new', 'cohort-01'),
      currentApp: async () => liveAlias,
      checkNumericGuardOff: async () => makeDisarmedGuardEvidence(),
      baselineState: { production_deployment: 'dpl_off_base' },
      buildDeployment: async ({ cohorts }) => {
        const shardNames = cohorts.flatMap(c => c.envVarNames);
        assert.deepEqual(shardNames, ['VDSEN_NUMERIC_COHORT_1', 'VDSEN_NUMERIC_COHORT_2', 'VDSEN_NUMERIC_COHORT_3', 'VDSEN_NUMERIC_COHORT_4', 'VDSEN_NUMERIC_COHORT_5']);
        return { deploymentId: 'dpl_new_cand', url: 'cand.vercel.app', readyState: 'READY' };
      },
      verifyCandidate: async () => ({ verified: true }),
      promoteDeployment: async ({ deploymentId }) => { liveAlias = deploymentId; return { promoted: true, deploymentId, verifiedPublicPaths: 46 }; },
      dispatchNextQueued: async (q) => { nextDispatched = q; },
    },
  });
  assert.equal(rep.status, 'RENEWED_VERIFIED');
  assert.equal(rep.deploymentId, 'dpl_new_cand');
  assert.equal(rep.effectiveDeploymentProvenance.baselineOffDeployment, 'dpl_off_base');
  assert.equal(rep.effectiveDeploymentProvenance.effectiveDeploymentId, 'dpl_new_cand');
  assert.equal(rep.effectiveDeploymentProvenance.productionAliasDeploymentId, 'dpl_new_cand');
  assert.equal(rep.effectiveDeploymentProvenance.promotionEvidence.verifiedPublicPaths, 46);
  assert.deepEqual(store.get('releaseControl/numericPilot/operations/T882-OP-HAPPY').effectiveDeploymentProvenance, rep.effectiveDeploymentProvenance);
  assert.equal(rep.shardNames.length, 5);
  assert.deepEqual(rep.unaffectedCohortIds, ['cohort-02', 'cohort-03']);
  assert.equal(store.get('releaseControl/numericPilot_cohort_cohort-02').windows['client-c2'].planId, 'plan-c2-old', 'cohort-02 untouched');
  assert.equal(store.get('releaseControl/numericPilotGlobalLock').activeOperationId, null);
  assert.equal(nextDispatched.operationId, 'T882-OP-NEXT');
});

test('T882.6: executeRenewCohortOperation — granular rollback on build fail, plan change during deploy, alias change, STOP during renewal, and re-arm fail (never reverts newer promotion)', async () => {
  const runScenario = async (overrides = {}) => {
    const store = new Map(Object.entries(makeMultiCohortDocs()));
    store.set('releaseControl/numericPilot/operations/T882-OP-FAIL', {
      operationId: 'T882-OP-FAIL', cohortId: 'cohort-01', clientId: 'client-c1', coachUid: 'coach-1',
      planId: 'plan-c1-new', runtimeSha: SHA, startsAt: '2026-11-26T05:15:00Z', expiresAt: EXP_ISO, status: 'QUEUED', history: [],
    });
    store.set('releaseControl/numericPilotGlobalLock', { activeOperationId: 'T882-OP-FAIL', version: 1,
      leaseExpiresAt: '2026-11-26T13:00:00Z', pendingQueue: [{operationId:'T882-OP-NEXT'}] });
    let liveAlias = 'dpl_prev_live';
    let revertedTo = null;
    const baseIo = {
      now: () => NOW_ISO,
      readDoc: async (p) => store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null,
      writeDoc: async (p, d) => { store.set(p, JSON.parse(JSON.stringify(d))); },
      loadLiveRoster: async () => makeManifestWithFiveShards('client-c1', 'plan-c1-new', 'cohort-01'),
      currentApp: async () => liveAlias,
      checkNumericGuardOff: async () => makeDisarmedGuardEvidence(),
      baselineState: { production_deployment: 'dpl_off_base' },
      buildDeployment: async () => ({ deploymentId: 'dpl_cand_fail', url: 'cand.vercel.app', readyState: 'READY' }),
      verifyCandidate: async () => ({ verified: true }),
      promoteDeployment: async ({ deploymentId }) => { liveAlias = deploymentId; return { promoted: true, deploymentId, verifiedPublicPaths: 46 }; },
      revertDeployment: async (id) => { revertedTo = id; liveAlias = id; return { restored: true }; },
    };
    const rep = await cohortOps.executeRenewCohortOperation({
      operationId: 'T882-OP-FAIL',
      io: Object.assign(baseIo, overrides(store, () => liveAlias, (v) => { liveAlias = v; })),
    });
    return { rep, store, getAlias: () => liveAlias, getRevertedTo: () => revertedTo };
  };

  // A. Build failure -> FAILED, zero alias/fence rollback needed, lock released
  const rBuild = await runScenario(() => ({ buildDeployment: async () => { throw new Error('BUILD_CRASH'); } }));
  assert.equal(rBuild.rep.status, 'FAILED');
  assert.equal(rBuild.rep.failedPhase, 'DEPLOYING');
  assert.equal(rBuild.rep.rollbackPerformed, false);
  assert.equal(rBuild.getAlias(), 'dpl_prev_live');
  assert.equal(rBuild.store.get('releaseControl/numericPilotGlobalLock').activeOperationId, null);

  // B. Plan changed during deployment -> FAILED before promotion
  const rPlanDrift = await runScenario((store) => ({
    buildDeployment: async () => {
      store.get('clients/client-c1').activePlanId = 'plan-c1-even-newer';
      return { deploymentId: 'dpl_cand_stale', url: 'cand.vercel.app', readyState: 'READY' };
    },
  }));
  assert.equal(rPlanDrift.rep.status, 'FAILED');
  assert.equal(rPlanDrift.rep.errorCode, 'PLAN_CHANGED_DURING_DEPLOYMENT');
  assert.equal(rPlanDrift.getAlias(), 'dpl_prev_live');

  // C. Alias moved concurrently before promote -> FAILED (optimistic concurrency)
  const rAliasMoved = await runScenario((_store, _get, setAlias) => ({
    buildDeployment: async () => {
      setAlias('dpl_other_promotion');
      return { deploymentId: 'dpl_cand_late', url: 'cand.vercel.app', readyState: 'READY' };
    },
  }));
  assert.equal(rAliasMoved.rep.status, 'FAILED');
  assert.equal(rAliasMoved.rep.errorCode, 'OPTIMISTIC_CONCURRENCY_ALIAS_CHANGED');
  assert.equal(rAliasMoved.getAlias(), 'dpl_other_promotion');

  // D. STOP triggered during renewal -> aborts cleanly before promote
  const rStopMid = await runScenario((store) => ({
    buildDeployment: async () => {
      store.set('releaseControl/autoCohortRenewalControl', { stopped: true, reason: 'STOP_MID_BUILD' });
      return { deploymentId: 'dpl_cand_stopped', url: 'cand.vercel.app', readyState: 'READY' };
    },
  }));
  assert.equal(rStopMid.rep.status, 'FAILED');
  assert.equal(rStopMid.rep.errorCode, 'STOP_ACTIVE_DURING_RENEWAL');
  assert.equal(rStopMid.getAlias(), 'dpl_prev_live');

  // E. Re-arm failure after promotion -> ROLLED_BACK_VERIFIED restoring previous deployment & fences
  const rRearmFail = await runScenario(() => ({
    rearmCohortFences: async () => { throw new Error('FIRESTORE_REARM_ERROR'); },
  }));
  assert.equal(rRearmFail.rep.status, 'ROLLED_BACK_VERIFIED');
  assert.equal(rRearmFail.rep.aliasRestored, true);
  assert.equal(rRearmFail.rep.fencesRestored, true);
  assert.equal(rRearmFail.getRevertedTo(), 'dpl_prev_live');
  assert.equal(rRearmFail.getAlias(), 'dpl_prev_live');

  // F. Post-promotion failure when a NEWER promotion already moved alias -> NEVER reverts newer promotion
  const rNewerProm = await runScenario((_store, _get, setAlias) => ({
    rearmCohortFences: async () => {
      setAlias('dpl_newer_legit_prod');
      throw new Error('REARM_AFTER_NEWER_PROMO');
    },
  }));
  assert.equal(rNewerProm.rep.status, 'ROLLBACK_REQUIRED');
  assert.equal(rNewerProm.rep.rollbackSkippedNewerPromotion, true);
  assert.equal(rNewerProm.getRevertedTo(), null);
  assert.equal(rNewerProm.getAlias(), 'dpl_newer_legit_prod');
  assert.equal(rNewerProm.store.get('releaseControl/numericPilotGlobalLock').status, 'ROLLBACK_REQUIRED');
  assert.deepEqual(rNewerProm.store.get('releaseControl/numericPilotGlobalLock').pendingQueue, [{operationId:'T882-OP-NEXT'}]);

  const versioned = await runScenario((store) => {
    const lockPath = 'releaseControl/numericPilotGlobalLock';
    const name = p => 'projects/vdsen-ecosistema/databases/(default)/documents/' + p;
    const lockFields = cohortOps.toFsFields({...store.get(lockPath), status: 'REQUESTED'});
    let lockTime = 'v1';
    return {
      readVersion: async p => p === lockPath
        ? {name:name(p), updateTime:lockTime, fields:{...lockFields}}
        : {name:name(p), updateTime:'fence-v1', fields:cohortOps.toFsFields(store.get(p) || {})},
      commitVersion: async writes => {
        const lockWrite = writes.find(w => w.update.name === name(lockPath));
        assert.equal(lockWrite.currentDocument.updateTime, lockTime);
        if (writes.length === 4) {
          assert.ok(writes.slice(0,3).every(w => w.currentDocument.updateTime === 'fence-v1'));
          throw new Error('STALE_FENCE_VERSION');
        }
        Object.assign(lockFields, lockWrite.update.fields);
        lockTime += '-next';
      },
      dispatchNextQueued: async () => assert.fail('Queue must stay blocked'),
    };
  });
  assert.equal(versioned.rep.status, 'ROLLBACK_REQUIRED');
  assert.equal(versioned.rep.fencesRestored, false);

  for (const restoreConflict of [false, true]) {
    const r = await runScenario((store) => {
      const lock = 'releaseControl/numericPilotGlobalLock';
      const name = p => 'projects/vdsen-ecosistema/databases/(default)/documents/' + p;
      const lockFields = cohortOps.toFsFields({...store.get(lock), status:'REQUESTED'});
      let version = 1;
      let releaseAttempts = 0;
      return {
        readVersion: async p => p === lock
          ? {name:name(p), updateTime:String(version), fields:{...lockFields}}
          : {name:name(p), updateTime:'before', fields:cohortOps.toFsFields(store.get(p) || {})},
        writeDoc: async (p,d) => {
          if (d.status === 'RENEWED_VERIFIED') throw new Error('LEDGER_FINALIZATION_FAILED');
          store.set(p, d);
        },
        commitVersion: async writes => {
          const lockWrite = writes.find(w => w.update.name === name(lock));
          assert.equal(lockWrite.currentDocument.updateTime, String(version));
          if (writes.length === 4) {
            const restoring = writes[0].currentDocument.updateTime === 'rearmed-0';
            assert.deepEqual(writes.slice(0,3).map(w => w.currentDocument.updateTime),
              restoring ? ['rearmed-0','rearmed-1','rearmed-2'] : ['before','before','before']);
            if (restoring && restoreConflict) throw new Error('LATER_FENCE_WRITE');
          }
          if (writes.length === 1) {
            releaseAttempts++;
            assert.equal(releaseAttempts, 1);
            assert.ok(!lockWrite.updateMask.fieldPaths.includes('pendingQueue'));
          }
          Object.assign(lockFields, lockWrite.update.fields);
          version++;
          return {writeResults:writes.map((_, i)=>({updateTime:'rearmed-'+i}))};
        },
      };
    });
    assert.equal(r.rep.status, restoreConflict ? 'ROLLBACK_REQUIRED' : 'ROLLED_BACK_VERIFIED');
    assert.equal(r.rep.fencesRestored, !restoreConflict);
  }

  // Ambiguous promotion outcomes are resolved from the alias, not the return value.
  for (const message of ['VERIFY_PUBLIC_BYTES_FAILED', 'PROMOTION_TIMEOUT']) {
    const r = await runScenario((_store, _get, setAlias) => ({
      promoteDeployment: async ({ deploymentId }) => { setAlias(deploymentId); throw new Error(message); },
    }));
    assert.equal(r.rep.status, 'ROLLED_BACK_VERIFIED');
    assert.equal(r.getAlias(), 'dpl_prev_live');
  }
  const incomplete = await runScenario((_store, _get, setAlias) => ({
    promoteDeployment: async ({ deploymentId }) => { setAlias(deploymentId); return {}; },
  }));
  assert.equal(incomplete.rep.status, 'ROLLED_BACK_VERIFIED');
  const unexpected = await runScenario((_store, _get, setAlias) => ({
    promoteDeployment: async () => { setAlias('dpl_foreign'); throw new Error('TIMEOUT'); },
  }));
  assert.equal(unexpected.rep.status, 'ROLLBACK_REQUIRED');
  assert.equal(unexpected.getRevertedTo(), null);
  const noChange = await runScenario((_store, _get, setAlias) => ({
    promoteDeployment: async ({ deploymentId }) => { setAlias(deploymentId); throw new Error('TIMEOUT'); },
    revertDeployment: async () => ({ restored: true }),
  }));
  assert.equal(noChange.rep.status, 'ROLLBACK_REQUIRED');
  const lostLock = await runScenario((store, _get, setAlias) => ({
    promoteDeployment: async ({ deploymentId }) => {
      setAlias(deploymentId);
      store.set('releaseControl/numericPilotGlobalLock', { activeOperationId: 'other-op', version: 2 });
      throw new Error('TIMEOUT');
    },
  }));
  assert.equal(lostLock.rep.status, 'ROLLBACK_REQUIRED');
  assert.equal(lostLock.getRevertedTo(), null);
  const denied = await runScenario((_store, _get, setAlias) => ({
    promoteDeployment: async ({ deploymentId }) => { setAlias(deploymentId); throw new Error('TIMEOUT'); },
    revertDeployment: async () => { throw new Error('PERMISSION_DENIED'); },
  }));
  assert.equal(denied.rep.status, 'ROLLBACK_REQUIRED');
});

test('T882.7: Workflow contract & invocation authorization for renew-cohort + App Coach truthful states', () => {
  const wf = fs.readFileSync('.github/workflows/vdsen-numeric-pilot.yml', 'utf8');
  assert.ok(wf.includes('- renew-cohort'), 'workflow must expose renew-cohort action');
  assert.ok(wf.includes("inputs.action == 'renew-cohort'"), 'workflow must route renew-cohort');
  assert.ok(wf.includes("inputs.action == 'stop' && 'vdsen-numeric-pilot-stop'"), 'STOP must stay in its independent priority group');

  assert.throws(() => pilotOps.invocation({
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema',
    GITHUB_REF: 'refs/heads/codex/client-app-next',
    GITHUB_RUN_ATTEMPT: '1',
    VDSEN_NUMERIC_PILOT_RELEASE_ENABLED: 'false',
    VDSEN_AUTO_COHORT_RENEWAL_WORKFLOW_ENABLED: 'false',
  }, 'renew-cohort'), /NUMERIC_PILOT_RENEW_DISABLED/);

  const auth = pilotOps.invocation({
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema',
    GITHUB_REF: 'refs/heads/codex/client-app-next',
    GITHUB_RUN_ATTEMPT: '1',
    VDSEN_NUMERIC_PILOT_RELEASE_ENABLED: 'false',
    VDSEN_AUTO_COHORT_RENEWAL_WORKFLOW_ENABLED: 'true',
  }, 'renew-cohort');
  assert.equal(auth.authorized, true);

  // App Coach status renderer never claims active for QUEUED/DEPLOYING/STOPPED
  const coachHtml = fs.readFileSync('vdsen-coach.html', 'utf8');
  const m = coachHtml.match(/function _renderPlanEngineSyncStatus\(syncRes\) \{[\s\S]*?\n  \}/);
  assert.ok(m, '_renderPlanEngineSyncStatus must exist in vdsen-coach.html');
  const render = new Function('syncRes', m[0] + '\nreturn _renderPlanEngineSyncStatus(syncRes);');
  assert.equal(render({ status: 'QUEUED', engineState: 'AUTHORIZATION_PREPARING', numericApplyAuthorized: false }).code, 'AUTHORIZATION_PREPARING');
  assert.equal(render({ status: 'DEPLOYING', numericApplyAuthorized: false }).code, 'AUTHORIZATION_PREPARING');
  assert.equal(render({ status: 'RENEWAL_STOPPED', engineState: 'AUTHORIZATION_PENDING', numericApplyAuthorized: false }).code, 'AUTHORIZATION_PENDING');
  assert.equal(render({ status: 'FAILED', retryable: true, numericApplyAuthorized: false }).label.includes('reintentar'), true);
  assert.equal(render({ status: 'RENEWED_VERIFIED', engineState: 'MOTOR_INTEGRATED_AUTHORIZED', numericApplyAuthorized: true }).code, 'MOTOR_INTEGRATED_AUTHORIZED');
});

test('T883-B.1 & B.3: Stale lock fencing token (expired lease / higher version) blocks promotion + independent workflow verification rejects spoofed requester', async () => {
  // B1: Spoofed requester coachId mismatch against persisted operation fails before any build
  const store1 = new Map(Object.entries(makeMultiCohortDocs()));
  store1.set('releaseControl/numericPilot/operations/T883-OP-B1', {
    operationId: 'T883-OP-B1', cohortId: 'cohort-01', clientId: 'client-c1', coachUid: 'coach-1',
    planId: 'plan-c1-new', runtimeSha: SHA, startsAt: '2026-11-26T05:15:00Z', expiresAt: EXP_ISO, status: 'QUEUED', lockVersion: 2, history: [],
  });
  store1.set('releaseControl/numericPilotGlobalLock', { activeOperationId: 'T883-OP-B1', version: 2, leaseExpiresAt: '2026-11-26T12:30:00Z', pendingQueue: [] });
  await assert.rejects(() => cohortOps.executeRenewCohortOperation({
    operationId: 'T883-OP-B1',
    cohortId: 'cohort-01',
    coachId: 'coach-intruder',
    io: {
      now: () => NOW_ISO,
      readDoc: async (p) => store1.has(p) ? JSON.parse(JSON.stringify(store1.get(p))) : null,
      writeDoc: async (p, d) => { store1.set(p, JSON.parse(JSON.stringify(d))); },
    },
  }), /OPERATION_REQUESTER_MISMATCH/);

  // B3: Another operation acquired higher fencing version while build ran -> STALE_LOCK_FENCING_ABORT before promotion!
  const store2 = new Map(Object.entries(makeMultiCohortDocs()));
  store2.set('releaseControl/numericPilot/operations/T883-OP-STALE', {
    operationId: 'T883-OP-STALE', cohortId: 'cohort-01', clientId: 'client-c1', coachUid: 'coach-1',
    planId: 'plan-c1-new', runtimeSha: SHA, startsAt: '2026-11-26T05:15:00Z', expiresAt: EXP_ISO, status: 'QUEUED', lockVersion: 5, history: [],
  });
  store2.set('releaseControl/numericPilotGlobalLock', { activeOperationId: 'T883-OP-STALE', version: 5, leaseExpiresAt: '2026-11-26T12:30:00Z', pendingQueue: [] });
  let promotedCalled = false;
  const repStale = await cohortOps.executeRenewCohortOperation({
    operationId: 'T883-OP-STALE',
    io: {
      now: () => NOW_ISO,
      readDoc: async (p) => store2.has(p) ? JSON.parse(JSON.stringify(store2.get(p))) : null,
      writeDoc: async (p, d) => { store2.set(p, JSON.parse(JSON.stringify(d))); },
      loadLiveRoster: async () => makeManifestWithFiveShards('client-c1', 'plan-c1-new', 'cohort-01'),
      currentApp: async () => 'dpl_prev_live',
      checkNumericGuardOff: async () => makeDisarmedGuardEvidence(),
      baselineState: { production_deployment: 'dpl_off_base' },
      buildDeployment: async () => {
        // Simulate lease expiry & another operation taking version 6!
        store2.set('releaseControl/numericPilotGlobalLock', { activeOperationId: 'T883-OP-NEWER', version: 6, leaseExpiresAt: '2026-11-26T12:45:00Z', pendingQueue: [] });
        return { deploymentId: 'dpl_cand_stale_fence', url: 'cand.vercel.app', readyState: 'READY' };
      },
      verifyCandidate: async () => ({ verified: true }),
      promoteDeployment: async () => { promotedCalled = true; return { promoted: true }; },
    },
  });
  assert.equal(promotedCalled, false, 'Stale operation must NEVER promote after losing fencing lock');
  assert.equal(repStale.status, 'FAILED');
  assert.equal(repStale.errorCode, 'STALE_LOCK_FENCING_ABORT');
});

test('T883-B.4 & B.5 & B.6: Authenticated status polling endpoint enforces Coach+client isolation + Coach HTML exposes B4/B5/B6 safely', async () => {
  const docs = makeMultiCohortDocs();
  docs['releaseControl/numericPilot/operations/T883-OP-POLL'] = {
    operationId: 'T883-OP-POLL',
    status: 'RENEWED_VERIFIED',
    cohortId: 'cohort-01',
    clientId: 'client-c1',
    coachUid: 'coach-1',
    planId: 'plan-c1-new',
    pidCount: 1,
    deploymentId: 'dpl_verified_99',
    workflowRunId: '777888',
    updatedAt: NOW_ISO,
  };
  const db = makeFakeDb(docs);
  const statusHandler = planSync.makeStatusHandler({
    db,
    verifyIdToken: async (tok) => ({ uid: tok === 'tok-coach-1' ? 'coach-1' : 'coach-other' }),
  });

  // Unauthenticated -> 401
  const rUnauth = makeRes();
  await statusHandler({ method: 'GET', headers: {}, query: { operationId: 'T883-OP-POLL', clientId: 'client-c1' } }, rUnauth);
  assert.equal(rUnauth.statusCode, 401);

  // Another Coach -> 403 CLIENT_NOT_OWNED
  const rOther = makeRes();
  await statusHandler({ method: 'GET', headers: { authorization: 'Bearer tok-coach-other' }, query: { operationId: 'T883-OP-POLL', clientId: 'client-c1' } }, rOther);
  assert.equal(rOther.statusCode, 403);

  // Owner Coach -> 200 with verified status
  const rOwner = makeRes();
  await statusHandler({ method: 'GET', headers: { authorization: 'Bearer tok-coach-1' }, query: { operationId: 'T883-OP-POLL', clientId: 'client-c1' } }, rOwner);
  assert.equal(rOwner.statusCode, 200);
  assert.equal(rOwner.body.schema, 'vdsen-plan-activation-status-v1');
  assert.equal(rOwner.body.status, 'RENEWED_VERIFIED');
  assert.equal(rOwner.body.engineState, 'MOTOR_INTEGRATED_AUTHORIZED');
  assert.equal(rOwner.body.numericApplyAuthorized, true);
  assert.equal(rOwner.body.deploymentId, 'dpl_verified_99');

  // Coach HTML static checks for B4/B5/B6
  const coachHtml = fs.readFileSync('vdsen-coach.html', 'utf8');
  assert.ok(coachHtml.includes('function _pollPlanEngineSyncStatus('), 'B4 polling function must exist');
  assert.ok(coachHtml.includes('check=plan-activation-status'), 'B4 polling must call authenticated status endpoint');
  assert.ok(coachHtml.includes('pilotTargetPlanId'), 'B5 deterministic pilot planId support must exist');
  assert.ok(coachHtml.includes('function _vdsenCheckCohortShards('), 'B6 built-in cohort-shard diagnostic must exist');
});

test('T883-RO.1 Read-only Vercel Firestore IAM (7 PERMISSION_DENIED) dispatches renew-cohort cleanly without writing', async () => {
  const db = makeFakeDb(makeMultiCohortDocs());
  db.runTransaction = async () => {
    const err = new Error('7 PERMISSION_DENIED: Missing or insufficient permissions.');
    err.code = 7;
    throw err;
  };
  const dispatched = [];
  const handler = makeHandler({
    db,
    verifyIdToken: async () => ({ uid: 'coach-1' }),
    autoRenewalEnabled: true,
    autoRenewalMode: 'pilot',
    pilotScope: {
      schema: 'vdsen-auto-renewal-pilot-scope-v1',
      uid: 'client-c1',
      planId: 'plan-c1-new',
      cohortId: 'cohort-01',
      operationId: 'T883-RO-PILOT-20261126',
      startsAt: '2026-11-26T00:00:00Z',
      expiresAt: '2026-11-28T00:00:00Z',
    },
    commercialRoster: () => ({ schema: 'vdsen-commercial-roster-v1', firebaseProject: 'vdsen-ecosistema', activeUids: ['client-c1', 'client-c2'], inactiveUids: [] }),
    nowMs: Date.parse('2026-11-26T12:00:00Z'),
    dispatchRenewalWorkflow: async (p) => { dispatched.push(p); return { ok: true, workflow: 'vdsen-numeric-pilot.yml', ref: 'codex/client-app-next' }; },
  });
  const res = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { action: 'plan-activation-sync', clientId: 'client-c1', planId: 'plan-c1-new' } }, res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, 'QUEUED');
  assert.equal(res.body.workflowDispatched, true);
  assert.equal(res.body.readOnlyFirestoreMode, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].operationId, 'T883-RO-PILOT-20261126');
  assert.equal(dispatched[0].renewalMode, 'PILOT_RESTRICTED');
});

test('T883-RO.2 executeRenewCohortOperation bootstraps ledger, lock, and single-use pilotAuth under WIF when Vercel was read-only', async () => {
  const store = new Map(Object.entries(makeMultiCohortDocs()));
  let liveAlias = 'dpl_prev_ro';
  const res = await cohortOps.executeRenewCohortOperation({
    operationId: 'T883-RO-PILOT-20261126',
    cohortId: 'cohort-01',
    runtimeSha: SHA,
    coachId: 'coach-1',
    clientId: 'client-c1',
    planId: 'plan-c1-new',
    startsAt: '2026-11-26T00:00:00Z',
    expiresAt: EXP_ISO,
    renewalMode: 'PILOT_RESTRICTED',
    runId: '99887766',
    io: {
      now: () => NOW_ISO,
      readDoc: async (p) => store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null,
      writeDoc: async (p, d) => { store.set(p, JSON.parse(JSON.stringify(d))); },
      checkNumericGuardOff: async () => makeDisarmedGuardEvidence(),
      baselineState: { production_deployment: 'dpl_off_base' },
      currentApp: async () => liveAlias,
      loadLiveRoster: async () => makeManifestWithFiveShards('client-c1', 'plan-c1-new', 'cohort-01'),
      buildDeployment: async () => ({ deploymentId: 'dpl_new_ro', url: 'x.vercel.app', readyState: 'READY' }),
      verifyCandidate: async () => ({ verified: true }),
      promoteDeployment: async ({ deploymentId }) => { liveAlias = deploymentId; return { promoted: true, verifiedPublicPaths: 46 }; },
      rearmCohortFences: async () => ({ rearmed: true }),
    },
  });
  assert.equal(res.status, 'RENEWED_VERIFIED');
  assert.equal(store.get('releaseControl/numericPilot/pilotAuthorizations/T883-RO-PILOT-20261126').consumed, true);
  assert.equal(store.get('releaseControl/numericPilot/operations/T883-RO-PILOT-20261126').bootstrappedByWorkflow, true);
  assert.equal(store.get('releaseControl/numericPilotGlobalLock').activeOperationId, null);
});

test('T883-A: renewal fails closed and rolls back when promotion lacks effective-deployment surface evidence', async () => {
  const store = new Map(Object.entries(makeMultiCohortDocs()));
  store.set('releaseControl/numericPilot/operations/T883-PROVENANCE', {
    operationId: 'T883-PROVENANCE', cohortId: 'cohort-01', clientId: 'client-c1', coachUid: 'coach-1',
    planId: 'plan-c1-new', runtimeSha: SHA, startsAt: '2026-11-26T05:15:00Z', expiresAt: EXP_ISO, status: 'QUEUED', history: [],
  });
  store.set('releaseControl/numericPilotGlobalLock', { activeOperationId: 'T883-PROVENANCE', version: 1, pendingQueue: [] });
  let liveAlias = 'dpl_previous_effective';
  const rep = await cohortOps.executeRenewCohortOperation({
    operationId: 'T883-PROVENANCE',
    io: {
      readDoc: async (p) => store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : null,
      writeDoc: async (p, d) => { store.set(p, JSON.parse(JSON.stringify(d))); },
      loadLiveRoster: async () => makeManifestWithFiveShards('client-c1', 'plan-c1-new', 'cohort-01'),
      currentApp: async () => liveAlias,
      checkNumericGuardOff: async () => makeDisarmedGuardEvidence(),
      baselineState: { production_deployment: 'dpl_off_baseline' },
      buildDeployment: async () => ({ deploymentId: 'dpl_candidate_effective', url: 'cand.vercel.app', readyState: 'READY' }),
      verifyCandidate: async () => ({ verified: true }),
      promoteDeployment: async ({ deploymentId }) => { liveAlias = deploymentId; return { promoted: true, deploymentId }; },
      revertDeployment: async (deploymentId) => { liveAlias = deploymentId; return { restored: true, deploymentId }; },
    },
  });
  assert.equal(rep.status, 'ROLLED_BACK_VERIFIED');
  assert.equal(rep.errorCode, 'PROMOTION_SURFACE_EVIDENCE_MISSING');
  assert.equal(liveAlias, 'dpl_previous_effective');
  assert.equal(store.get('releaseControl/numericPilot/operations/T883-PROVENANCE').effectiveDeploymentProvenance, undefined);
});
