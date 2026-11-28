'use strict';
// T875 — Multi-Cohort General Activation Contract, Isolation, and Full-Flow Validation.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const C = require(path.join(root, 'api/_numericPilotContract.js'));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const cohortOps = require(path.join(root, 'scripts/pilot/numeric-cohort-ops.cjs'));

const SHA = '99155fc0e1a956c0121504d2ae3d34de9ae28d09';
const STARTS = '2026-11-24T00:00:00Z';
const EXPIRES = '2026-12-20T00:00:00Z';
const NOW = Date.parse('2026-11-24T04:00:00Z');
const COACH = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';

function makePlan(uid, planId, pidCount, opts = {}) {
  const exercises = Array.from({ length: pidCount }, (_, i) => ({
    prescriptionExerciseId: `${planId}-pid-${String(i + 1).padStart(2, '0')}`,
    exerciseName: `Exercise ${i + 1}`,
    sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 2, restSeconds: 90 }],
  }));
  return Object.assign({
    _id: planId,
    clientId: uid,
    coachId: COACH,
    status: 'active',
    updatedAt: '2026-11-20T00:00:00.000Z',
    days: [{ dayIndex: 0, exercises }],
  }, opts);
}

test('recovery preserves the roster, PIDs and existing expiry; only pilot plan drift is admissible', () => {
  const clients = Array.from({length:25}, (_, i) => ({
    _id: i === 24 ? COACH : 'client_' + String(i).padStart(2, '0'),
    coachId:COACH, status:'activo', activePlanId:'plan_' + i,
  }));
  const plans = Object.fromEntries(clients.map((c, i) =>
    [c.activePlanId, makePlan(c._id,c.activePlanId,i < 11 ? 34 : 33)]));
  const manifest = cohortOps.buildCohortsFromRoster(clients, plans, {
    runtimeSha:SHA, operationId:'T875-RECOVERY-NEW', startsAt:STARTS, expiresAt:EXPIRES,
  });
  const co = manifest.cohorts[2];
  const windows = Object.fromEntries(co.clients.map(c => [c.uid, {
    enabled:true, planId:c.planId, pids:c.pids, pidCount:c.pidCount, pidsHash:c.pidsHash,
    runtimeSha:SHA, operationId:'PREVIOUS-OP', expiresAt:EXPIRES,
  }]));
  windows[COACH].planId = 'superseded_plan';
  const common = {enabled:true, operationId:'PREVIOUS-OP', expiresAt:EXPIRES};
  const fences = {
    releaseFence:{...common, clientIds:co.clientIds},
    numericFence:{...common, runtimeSha:SHA, windows},
    coachCanaryCohort:{...common, clientIds:co.clientIds, prescriptionExerciseIds:co.allPids},
    coachCanaryEnabled:true,
  };
  const validate = (candidate = manifest, expires = EXPIRES) =>
    cohortOps.validateRecoveryScope(candidate, co, fences, SHA, expires, NOW);
  assert.doesNotThrow(() => validate());
  assert.throws(() => validate({...manifest, eligibleCount:26}), /RECOVERY_ROSTER_COUNT_CHANGED/);
  assert.throws(() => validate(manifest, STARTS), /RECOVERY_EXPIRY_CHANGED/);
  windows[COACH].pidsHash = 'changed-hash';
  assert.throws(() => validate(), /RECOVERY_AUTHORIZATION_DRIFT/);
});

test('staged recovery attestation binds the seal and refuses unverified or already live candidates', async () => {
  const expectedLive = 'dpl_live';
  const digest = 'a'.repeat(64);
  const deployment = {
    id:'dpl_stage', url:'staged-fixture.vercel.app', projectId:'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN', teamId:'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
    readyState:'READY', target:'production', meta:{githubCommitSha:SHA, vdsenRecoverySeal:digest},
    env:['AUTONOMOUS_PROGRESSION_ENABLED','AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED',
      'VDSEN_NUMERIC_PILOT_ENABLED','VDSEN_NUMERIC_PILOT_RUNTIME_SHA','VDSEN_NUMERIC_COHORT_1'],
  };
  let alias = expectedLive;
  const fetcher = async url => ({
    status:200, json:async () => url.includes('/deployments/') ? deployment : {deploymentId:alias},
  });
  const verify = (seal = digest) => cohortOps.verifyFleetDeploymentLive(
    'test-token', deployment.id, SHA, 'VDSEN_NUMERIC_COHORT_1', fetcher, {expectedLive,digest:seal});
  assert.equal((await verify()).attested, true);
  await assert.rejects(verify('b'.repeat(64)), /RECOVERY_SEAL_MISMATCH/);
  alias = deployment.id;
  await assert.rejects(verify(), /RECOVERY_STAGE_ALIAS_CHANGED/);
  alias = expectedLive;
  deployment.env.pop();
  await assert.rejects(verify(), /MISSING_COHORT_SHARD/);
  const shards = [1,1,2,2,3].map((cohort, i) => ({
    name:'VDSEN_NUMERIC_COHORT_' + (i+1),
    windows:[{runtimeSha:SHA,planId:'test_plan_'+i,uid:'client_'+i,cohortId:'cohort-0'+cohort}],
  }));
  deployment.env.push(...shards.map(shard => shard.name));
  const runtimeEnv = Object.fromEntries(shards.map(shard => [shard.name,JSON.stringify(shard.windows)]));
  runtimeEnv.VERCEL_DEPLOYMENT_ID = deployment.id;
  runtimeEnv.VDSEN_NUMERIC_PILOT_RUNTIME_SHA = SHA;
  const {makeHandler} = require('../api/autonomous-progression-trigger.js');
  const crypto = require('node:crypto');
  const {privateKey,publicKey} = crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const kid = 'fixture-key';
  const now = Math.floor(Date.now()/1000);
  const repo = 'vdsenasesoria-svg/vdsen-ecosistema';
  const ref = 'refs/heads/codex/client-app-next';
  const issue = (overrides = {}) => {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const claims = {
      iss:'https://token.actions.githubusercontent.com', aud:'vdsen-recovery-shards:'+deployment.id,
      sub:'repo:'+repo+':environment:Production', repository:repo, repository_owner:'vdsenasesoria-svg',
      workflow_ref:repo+'/.github/workflows/vdsen-numeric-pilot.yml@'+ref, ref, environment:'Production',
      event_name:'workflow_dispatch', run_attempt:'1', run_id:'123', iat:now, exp:now+300,
      ...overrides,
    };
    const data = encode({alg:'RS256',kid})+'.'+encode(claims);
    return data+'.'+crypto.sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url');
  };
  const handler = makeHandler({runtimeEnv, githubJwks:async () => [{...publicKey.export({format:'jwk'}),kid}],
    verifyIdToken:async () => assert.fail('OIDC request must not use Firebase authentication')});
  const probeFetcher = async (url, opts) => {
    const parsed = new URL(url);
    if (parsed.hostname !== deployment.url) return fetcher(url);
    assert.equal(opts.redirect,'error');
    let status, body;
    await handler({method:'GET',query:Object.fromEntries(parsed.searchParams),headers:opts.headers},
      {status(code){status=code;return this;},json(data){body=data;return this;}});
    return {status,json:async () => body};
  };
  const verifyValues = (token = issue()) => cohortOps.verifyFleetDeploymentLive(
    'test-token', deployment.id, SHA, shards.map(shard => shard.name), probeFetcher, {expectedLive,digest}, shards, token);
  await assert.rejects(verifyValues(''), /RECOVERY_PROBE_AUTH_UNAVAILABLE/);
  await assert.rejects(verifyValues('wrong-token'), /RECOVERY_PROBE_OIDC_ERROR:AUTH_INVALID/);
  for (const claims of [{aud:'vdsen-recovery-shards:dpl_other'}, {environment:'Preview'}, {ref:'refs/heads/main'},
    {workflow_ref:repo+'/.github/workflows/vdsen-ayrton-window.yml@'+ref}, {repository:'other/repo'}]) {
    await assert.rejects(verifyValues(issue(claims)), /RECOVERY_PROBE_OIDC_ERROR:OIDC_FORBIDDEN/);
  }
  await assert.rejects(verifyValues(issue({exp:now-1})), /RECOVERY_PROBE_OIDC_ERROR:AUTH_EXPIRED/);
  runtimeEnv[shards[0].name] = '[]';
  await assert.rejects(verifyValues(), /RECOVERY_PROBE_WINDOW_COUNT_MISMATCH/);
  runtimeEnv[shards[0].name] = JSON.stringify(shards[0].windows);
  runtimeEnv.VERCEL_DEPLOYMENT_ID = 'dpl_wrong';
  await assert.rejects(verifyValues(), /RECOVERY_PROBE_OIDC_ERROR:OIDC_FORBIDDEN/);
  runtimeEnv.VERCEL_DEPLOYMENT_ID = deployment.id;
  assert.equal((await verifyValues()).attested, true);
  deployment.env.push('VDSEN_NUMERIC_COHORT_6');
  await assert.rejects(verifyValues(), /RECOVERY_SHARD_SET_MISMATCH/);
});

test('updated APP-ONLY provenance preserves the prior seal baseline without changing the current baseline', () => {
  const next = 'a'.repeat(40);
  const state = {runtime_sha:next, production_deployment:'dpl_new', app_release:{
    runtime_sha:next, deployment:'dpl_new', previous_runtime_sha:SHA,
    previous_deployment:'dpl_old', source_release_run:'123',
  }};
  assert.equal(cohortOps.recoverySealBaseline(state,SHA), 'dpl_old');
  assert.equal(cohortOps.recoverySealBaseline(state,next), 'dpl_new');
  assert.throws(() => cohortOps.recoverySealBaseline(state,'b'.repeat(40)), /NOT_ACCREDITED/);
  state.app_release.deployment = 'dpl_other';
  assert.throws(() => cohortOps.recoverySealBaseline(state,SHA), /NOT_ACCREDITED/);
});

test('T875.1 Roster partitioning: 29 eligible clients -> 3 isolated cohorts (10+10+9), excludes inactive/no-plan/no-PID, each env shard < 4 KB', () => {
  const clients = [];
  const plans = {};
  for (let i = 1; i <= 29; i++) {
    const uid = `client_${String(i).padStart(2, '0')}`;
    const planId = `plan_${String(i).padStart(2, '0')}`;
    clients.push({ _id: uid, coachId: COACH, status: 'activo', activePlanId: planId });
    plans[planId] = makePlan(uid, planId, 33);
  }
  // Excluded identities
  clients.push({ _id: 'excl_inactive', coachId: COACH, status: 'inactivo', activePlanId: 'plan_01' });
  clients.push({ _id: 'excl_suspended', coachId: COACH, status: 'suspendido', activePlanId: 'plan_01' });
  clients.push({ _id: 'excl_no_plan', coachId: COACH, status: 'activo', activePlanId: null });
  clients.push({ _id: 'excl_legacy_nopid', coachId: COACH, status: 'activo', activePlanId: 'plan_legacy' });
  plans.plan_legacy = { _id: 'plan_legacy', clientId: 'excl_legacy_nopid', coachId: COACH, status: 'active', days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Legacy' }] }] };

  const manifest = cohortOps.buildCohortsFromRoster(clients, plans, {
    runtimeSha: SHA,
    operationId: 'T875-FLEET-20261124',
    startsAt: STARTS,
    expiresAt: EXPIRES,
  });

  assert.equal(manifest.totalClients, 33);
  assert.equal(manifest.eligibleCount, 29);
  assert.equal(manifest.excludedCount, 4);
  assert.equal(manifest.cohortCount, 3);
  assert.deepEqual(manifest.cohorts.map(c => c.clientCount), [10, 10, 9]);
  assert.equal(manifest.totalEligiblePids, 29 * 33);
  for (const co of manifest.cohorts) {
    assert.ok(co.clientCount <= 10, 'strict <= 10 cap per cohort');
    assert.ok(co.envVarBytes < 4000, `${co.envVarName} must fit under 4 KB Vercel limit (${co.envVarBytes} bytes)`);
  }
});

test('T875.2 Sharded env runtimeAuthorization + cryptographic pidsHash verification + strict rejection of foreign PID/client and >10 cap', () => {
  const clients = Array.from({ length: 12 }, (_, i) => ({
    _id: `u_${String(i + 1).padStart(2, '0')}`,
    coachId: COACH,
    status: 'activo',
    activePlanId: `p_${String(i + 1).padStart(2, '0')}`,
  }));
  const plans = {};
  clients.forEach(c => { plans[c.activePlanId] = makePlan(c._id, c.activePlanId, 4); });

  const manifest = cohortOps.buildCohortsFromRoster(clients, plans, {
    runtimeSha: SHA,
    operationId: 'T875-TEST-OP',
    startsAt: STARTS,
    expiresAt: EXPIRES,
  });
  assert.equal(manifest.cohortCount, 2);

  const env = {
    AUTONOMOUS_PROGRESSION_ENABLED: 'true',
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: SHA,
    VDSEN_NUMERIC_COHORT_1: JSON.stringify(manifest.cohorts[0].compactWindows),
    VDSEN_NUMERIC_COHORT_2: JSON.stringify(manifest.cohorts[1].compactWindows),
  };

  // Client 1 in cohort-01 and Client 12 in cohort-02 both resolve independently
  const w1 = C.runtimeAuthorization(env, NOW, 'u_01');
  const w12 = C.runtimeAuthorization(env, NOW, 'u_12');
  const wAlien = C.runtimeAuthorization(env, NOW, 'u_99');
  assert.equal(w1.cohortId, 'cohort-01');
  assert.equal(w12.cohortId, 'cohort-02');
  assert.equal(wAlien, null);

  // Cryptographic pidsHash binding inside transactionAllowed
  const co1 = manifest.cohorts[0];
  const u1 = co1.clients[0];
  const fence1 = Object.assign({}, w1, { pids: u1.pids, enabled: true });
  const release1 = { schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: co1.clientIds, expiresAt: EXPIRES };
  const coachCanary = {
    enabled: true,
    schema: 'vdsen-canary-cohort-v1',
    cohort: true,
    cohorts: {
      'cohort-01': { enabled: true, clientIds: co1.clientIds, prescriptionExerciseIds: co1.allPids },
    },
  };
  const ledger1 = {
    schema: 'vdsen-numeric-operations-ledger-v1',
    status: 'RESERVED',
    operationId: co1.operationId,
    runtimeSha: SHA,
    windows: Object.fromEntries(co1.compactWindows.map(w => [w.uid, w])),
    scope: { enabled: true, clientIds: co1.clientIds, prescriptionExerciseIds: co1.allPids },
    appliedRecordKeys: [],
  };
  const recValid = { state: 'PENDING', prescriptionExerciseId: u1.pids[2] };
  assert.equal(C.transactionAllowed(w1, w1, fence1, release1, coachCanary, 'u_01', recValid, plans.p_01, ledger1, 'v1_aaa'), true);

  // Tampered PID list fails pidsHash check
  const tamperedFence = Object.assign({}, fence1, { pids: u1.pids.slice(0, 3).concat(['forged-pid']) });
  assert.equal(C.transactionAllowed(w1, w1, tamperedFence, release1, coachCanary, 'u_01', { state: 'PENDING', prescriptionExerciseId: 'forged-pid' }, plans.p_01, ledger1, 'v1_bbb'), false);

  // 11-client cohort cap strictly rejected in both releaseFence and coachCanary
  const oversizedRelease = Object.assign({}, release1, { clientIds: co1.clientIds.concat(['extra_11']) });
  assert.equal(C.transactionAllowed(w1, w1, fence1, oversizedRelease, coachCanary, 'u_01', recValid, plans.p_01, ledger1, 'v1_ccc'), false);
  const oversizedCanary = {
    enabled: true, schema: 'vdsen-canary-cohort-v1', cohort: true,
    cohorts: { 'cohort-01': { enabled: true, clientIds: co1.clientIds.concat(['extra_11']), prescriptionExerciseIds: co1.allPids } },
  };
  assert.equal(consumer.inCanaryScope(oversizedCanary, 'u_01', u1.pids[0]), false);
  assert.equal(C.scopeValid(oversizedCanary, 'u_01', u1.pids[0], plans.p_01, { cohort: true, cohortId: 'cohort-01' }), false);

  // Cross-cohort isolation: cohort-02 client cannot pass cohort-01 canary
  assert.equal(consumer.inCanaryScope(coachCanary, 'u_12', manifest.cohorts[1].clients[1].pids[0]), false);

  // Disarming cohort-01 does not affect cohort-02
  const twoCanary = {
    enabled: true, schema: 'vdsen-canary-cohort-v1', cohort: true,
    cohorts: {
      'cohort-01': { enabled: false, clientIds: co1.clientIds, prescriptionExerciseIds: co1.allPids },
      'cohort-02': { enabled: true, clientIds: manifest.cohorts[1].clientIds, prescriptionExerciseIds: manifest.cohorts[1].allPids },
    },
  };
  assert.equal(consumer.inCanaryScope(twoCanary, 'u_01', u1.pids[0]), false);
  assert.equal(consumer.inCanaryScope(twoCanary, 'u_12', manifest.cohorts[1].clients[1].pids[0]), true);
});

test('attestRecoveryShards differentiates probe failures, sends bypass header safely, and redacts secrets', async () => {
  const { computeServedCohortDigest } = require(path.join(root, 'api/_planActivationSync.js'));
  const deployment = { id: 'dpl_stageProbe1', url: 'staged-probe.vercel.app' };
  const shards = [{
    name: 'VDSEN_NUMERIC_COHORT_1',
    windows: [{ uid: 'client_01', planId: 'plan_01', pidsHash: 'h1', pidCount: 33, operationId: 'op1', runtimeSha: SHA, expiresAt: EXPIRES, cohortId: 'cohort-01' }],
  }];
  const expectedDigest = computeServedCohortDigest(shards[0].windows);
  const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const token = `${encode({ alg: 'RS256', kid: 'k1' })}.${encode({
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'vdsen-recovery-shards:' + deployment.id,
    sub: 'repo:vdsenasesoria-svg/vdsen-ecosistema:environment:Production',
    repository: 'vdsenasesoria-svg/vdsen-ecosistema',
    ref: 'refs/heads/codex/client-app-next',
    event_name: 'workflow_dispatch',
    environment: 'Production',
    workflow_ref: 'vdsenasesoria-svg/vdsen-ecosistema/.github/workflows/vdsen-numeric-pilot.yml@refs/heads/codex/client-app-next',
    run_attempt: '1',
    iat: nowSec,
    exp: nowSec + 300,
  })}.sig_secret_never_log`;
  const bypassSecret = 'bypass_secret_value_never_log';

  const runFailureCase = async (fetcher, opts = {}) => {
    let caught;
    try {
      await cohortOps.attestRecoveryShards(deployment, shards, SHA, token, fetcher, {
        protectionBypassSecret: bypassSecret,
        ssoProtectionType: 'standard_protection',
        ...opts,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected attestRecoveryShards to reject');
    const serialized = JSON.stringify({ message: caught.message, diagnostic: caught.diagnostic || null });
    assert.ok(!serialized.includes(bypassSecret), 'bypass secret must never appear in error or diagnostic');
    assert.ok(!serialized.includes('sig_secret_never_log'), 'raw JWT signature must never appear in error or diagnostic');
    return caught;
  };

  // Transport error
  let err = await runFailureCase(async () => { throw new Error('ECONNRESET'); });
  assert.equal(err.message, 'RECOVERY_PROBE_TRANSPORT_ERROR');

  // Timeout
  err = await runFailureCase(async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; });
  assert.equal(err.message, 'RECOVERY_PROBE_TIMEOUT');

  // Vercel protection: 302 redirect, redirect fetch error, and 401 HTML
  err = await runFailureCase(async () => ({ status: 302, headers: new Headers({ location: 'https://vercel.com/sso-api' }), text: async () => '' }));
  assert.equal(err.message, 'RECOVERY_PROBE_DEPLOYMENT_PROTECTION');
  assert.equal(err.diagnostic.vercelProtectionDetected, true);

  err = await runFailureCase(async () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); });
  assert.equal(err.message, 'RECOVERY_PROBE_DEPLOYMENT_PROTECTION');
  assert.equal(err.diagnostic.vercelProtectionDetected, true);

  err = await runFailureCase(async () => ({
    status: 401,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    text: async () => '<html><title>Authentication Required - Vercel</title></html>',
  }));
  assert.equal(err.message, 'RECOVERY_PROBE_DEPLOYMENT_PROTECTION');
  assert.equal(err.diagnostic.vercelProtectionDetected, true);

  // OIDC error JSON
  err = await runFailureCase(async () => ({
    status: 403,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ error: 'OIDC_FORBIDDEN' }),
  }));
  assert.equal(err.message, 'RECOVERY_PROBE_OIDC_ERROR:OIDC_FORBIDDEN');
  assert.equal(err.diagnostic.apiError, 'OIDC_FORBIDDEN');
  assert.equal(err.diagnostic.oidcClaims.aud, 'vdsen-recovery-shards:' + deployment.id);

  err = await runFailureCase(async () => ({
    status: 403,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ error: 'DEPLOYMENT_ID_UNAVAILABLE' }),
  }));
  assert.equal(err.message, 'RECOVERY_PROBE_OIDC_ERROR:DEPLOYMENT_ID_UNAVAILABLE');

  // Other HTTP status
  err = await runFailureCase(async () => ({
    status: 502,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ error: 'UPSTREAM_BAD_GATEWAY' }),
  }));
  assert.equal(err.message, 'RECOVERY_PROBE_HTTP_502');

  // Invalid JSON
  err = await runFailureCase(async () => ({
    status: 200,
    headers: new Headers({ 'content-type': 'text/plain' }),
    text: async () => 'not-json',
  }));
  assert.equal(err.message, 'RECOVERY_PROBE_INVALID_JSON');

  // Field mismatches
  const validPayload = {
    schema: 'vdsen-served-cohort-probe-v1',
    deploymentId: deployment.id,
    cohortId: 'cohort-01',
    runtimeSha: SHA,
    windowCount: 1,
    windowsDigest: expectedDigest,
  };
  const mismatchCases = [
    [{ schema: 'wrong-schema' }, 'RECOVERY_PROBE_SCHEMA_MISMATCH'],
    [{ deploymentId: 'dpl_other' }, 'RECOVERY_PROBE_DEPLOYMENT_ID_MISMATCH'],
    [{ cohortId: 'cohort-02' }, 'RECOVERY_PROBE_COHORT_ID_MISMATCH'],
    [{ runtimeSha: 'b'.repeat(40) }, 'RECOVERY_PROBE_RUNTIME_SHA_MISMATCH'],
    [{ windowCount: 99 }, 'RECOVERY_PROBE_WINDOW_COUNT_MISMATCH'],
    [{ windowsDigest: '0'.repeat(64) }, 'RECOVERY_PROBE_DIGEST_MISMATCH'],
  ];
  for (const [override, expectedCode] of mismatchCases) {
    err = await runFailureCase(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ ...validPayload, ...override }),
    }));
    assert.equal(err.message, expectedCode);
  }

  // Sends x-vercel-protection-bypass and succeeds on valid probe
  let seenHeaders = null;
  const ok = await cohortOps.attestRecoveryShards(deployment, shards, SHA, token, async (_url, reqOpts) => {
    seenHeaders = reqOpts.headers;
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(validPayload),
    };
  }, { protectionBypassSecret: bypassSecret });
  assert.equal(seenHeaders.authorization, 'Bearer ' + token);
  assert.equal(seenHeaders['x-vercel-protection-bypass'], bypassSecret);
  assert.deepEqual(ok, [{ cohortId: 'cohort-01', windowCount: 1, windowsDigest: expectedDigest }]);

  // readVercelAutomationBypass picks up automation-bypass key from project config
  const bypassInfo = await cohortOps.readVercelAutomationBypass('vercel-token', async () => ({
    status: 200,
    json: async () => ({
      ssoProtection: { deploymentType: 'standard_protection' },
      protectionBypass: {
        otherKey: { scope: 'shareable-link' },
        [bypassSecret]: { scope: 'automation-bypass' },
      },
    }),
  }));
  assert.equal(bypassInfo.secret, bypassSecret);
  assert.equal(bypassInfo.ssoProtectionType, 'standard_protection');
  assert.equal(bypassInfo.hasAutomationBypass, true);
});

test('findReusableRecoveryCandidate selects matching READY candidate and skips live or mismatched deployments', async () => {
  const digest = 'c'.repeat(64);
  const expectedLive = 'dpl_liveCurrent';
  const shardNames = ['VDSEN_NUMERIC_COHORT_1', 'VDSEN_NUMERIC_COHORT_2'];
  const deploymentsList = [
    // Matches everything, EXCEPT it is the live deployment
    { uid: expectedLive, readyState: 'READY', target: 'production', createdAt: 500, meta: { githubCommitSha: SHA, vdsenRecoverySeal: digest } },
    // Not READY
    { uid: 'dpl_building', readyState: 'BUILDING', target: 'production', createdAt: 400, meta: { githubCommitSha: SHA, vdsenRecoverySeal: digest } },
    // Wrong seal
    { uid: 'dpl_wrongSeal', readyState: 'READY', target: 'production', createdAt: 300, meta: { githubCommitSha: SHA, vdsenRecoverySeal: 'd'.repeat(64) } },
    // Matching newest candidate
    { uid: 'dpl_goodNew', readyState: 'READY', target: 'production', createdAt: 200, meta: { githubCommitSha: SHA, vdsenRecoverySeal: digest } },
    // Older matching candidate
    { uid: 'dpl_goodOld', readyState: 'READY', target: 'production', createdAt: 100, meta: { githubCommitSha: SHA, vdsenRecoverySeal: digest } },
  ];
  const fullById = {
    dpl_goodNew: {
      id: 'dpl_goodNew', url: 'good-new.vercel.app', readyState: 'READY', target: 'production',
      meta: { githubCommitSha: SHA, vdsenRecoverySeal: digest },
      env: ['AUTONOMOUS_PROGRESSION_ENABLED', ...shardNames],
    },
  };
  const fetcher = async (url) => {
    if (url.includes('/v6/deployments?')) return { status: 200, json: async () => ({ deployments: deploymentsList }) };
    if (url.includes('/v13/deployments/dpl_goodNew')) return { status: 200, json: async () => fullById.dpl_goodNew };
    throw new Error('Unexpected URL: ' + url);
  };
  const found = await cohortOps.findReusableRecoveryCandidate('tok', SHA, digest, expectedLive, shardNames, fetcher);
  assert.equal(found && found.id, 'dpl_goodNew');

  // Returns null when shard set mismatches
  fullById.dpl_goodNew.env = ['AUTONOMOUS_PROGRESSION_ENABLED', 'VDSEN_NUMERIC_COHORT_1'];
  const missingShard = await cohortOps.findReusableRecoveryCandidate('tok', SHA, digest, expectedLive, shardNames, fetcher);
  assert.equal(missingShard, null);
});
