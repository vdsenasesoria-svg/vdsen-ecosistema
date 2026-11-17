'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeHandler, verifyGithubA4OidcToken, GH_A4_AUDIENCE_PREFIX } = require('../api/autonomous-progression-trigger.js');
const { invocation, executeWindowAction, AUTHORIZED_PID } = require('../scripts/pilot/ayrton-window-ops.cjs');
const { runtimeEvidence } = require('../scripts/pilot/ayrton-window.cjs');
const C = require('../scripts/pilot/ayrton-canary.cjs');

const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const COACH = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const PLAN = 'D5fVjlS3NysTD6Yg2ZpW';
const OP_ID = 'op-t831-oidc-verified';
const RUNTIME_SHA = '076c8c70a276cb80d669d7cd187861756405871f';
const OFF_BASELINE = 'dpl_8kLZt5zTgAbyvPR9jyoLeb6MsD6C';
const STAGE1_DEPLOYMENT = 'dpl_Stage1ShadowReal0000000001';
const FUTURE_EXP = new Date(Date.now() + 2 * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PAST_EXP = new Date(Date.now() - 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');

const sha256 = x => crypto.createHash('sha256').update(x).digest('hex');
const b64url = buf => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 't831-test-key', use: 'sig', alg: 'RS256' };

function signJwt(payloadOverrides = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: JWK.kid, ...headerOverrides };
  const payload = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: GH_A4_AUDIENCE_PREFIX + OP_ID,
    exp: now + 300,
    nbf: now - 10,
    iat: now - 10,
    repository: 'vdsenasesoria-svg/vdsen-ecosistema',
    repository_owner: 'vdsenasesoria-svg',
    ref: 'refs/heads/codex/client-app-next',
    event_name: 'workflow_dispatch',
    environment: 'Production',
    job_workflow_ref: 'vdsenasesoria-svg/vdsen-ecosistema/.github/workflows/vdsen-ayrton-window.yml@refs/heads/codex/client-app-next',
    run_attempt: '1',
    run_id: '44099999999',
    ...payloadOverrides,
  };
  const body = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(body), privateKey);
  return body + '.' + b64url(sig);
}

function mkRes() {
  const out = { statusCode: 0, body: null, headers: {} };
  return {
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.statusCode = c; return { json(b) { out.body = b; return out; } }; },
  };
}

function pilotWindowJson(exp = FUTURE_EXP, op = OP_ID) {
  return JSON.stringify({ uidHash: sha256(UID), planHash: sha256(PLAN), expiresAt: exp, operationId: op });
}

test('T831.1 Valid GitHub Actions OIDC token succeeds on ?check=runtime-a4 without touching Firestore', async () => {
  const handler = makeHandler({
    enabled: true,
    numericApplyEnabled: false,
    pilotWindow: pilotWindowJson(),
    runtimeSha: RUNTIME_SHA,
    githubJwks: async () => [JWK],
    db: { collection() { throw new Error('FIRESTORE_MUST_NOT_BE_TOUCHED'); } },
  });
  const tok = signJwt();
  const res = await handler({ method: 'GET', query: { check: 'runtime-a4' }, headers: { authorization: 'Bearer ' + tok } }, mkRes());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.schema, 'vdsen-progression-runtime-v1');
  assert.equal(res.body.processingEnabled, true);
  assert.equal(res.body.numericApplyEnabled, false);
  assert.equal(res.body.cronConfigured, false);
  assert.equal(res.body.pilotWindow.operationId, OP_ID);
  assert.equal(res.body.runtimeSha, RUNTIME_SHA);
});

test('T831.2 Cryptographic & claim negative tests reject invalid signature, issuer, audience, expiry, repo, branch, workflow, env, rerun, and PR', async () => {
  const handler = makeHandler({
    enabled: true,
    numericApplyEnabled: false,
    pilotWindow: pilotWindowJson(),
    githubJwks: async () => [JWK],
  });

  // No credentials -> 401
  const noAuth = await handler({ method: 'GET', query: { check: 'runtime-a4' }, headers: {} }, mkRes());
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.body.error, 'AUTH_MISSING');

  // Invalid signature -> 401
  const validTok = signJwt();
  const tampered = validTok.slice(0, -4) + 'AAAA';
  const badSig = await handler({ method: 'GET', query: { check: 'runtime-a4' }, headers: { authorization: 'Bearer ' + tampered } }, mkRes());
  assert.equal(badSig.statusCode, 401);
  assert.equal(badSig.body.error, 'AUTH_INVALID');

  // Expired -> 401
  const expTok = signJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  const expRes = await handler({ method: 'GET', query: { check: 'runtime-a4' }, headers: { authorization: 'Bearer ' + expTok } }, mkRes());
  assert.equal(expRes.statusCode, 401);
  assert.equal(expRes.body.error, 'AUTH_EXPIRED');

  // Wrong issuer, wrong audience / operationId, wrong repo, wrong branch, wrong workflow, wrong env, rerun, PR
  const badClaims = [
    { iss: 'https://evil.example.com' },
    { aud: 'vdsen-ayrton-runtime-a4:op-wrong' },
    { repository: 'other/repo' },
    { ref: 'refs/heads/main' },
    { job_workflow_ref: 'vdsenasesoria-svg/vdsen-ecosistema/.github/workflows/other.yml@refs/heads/codex/client-app-next' },
    { environment: 'staging' },
    { run_attempt: '2' },
    { head_ref: 'feature-pr' },
  ];
  for (const c of badClaims) {
    const r = await handler({ method: 'GET', query: { check: 'runtime-a4' }, headers: { authorization: 'Bearer ' + signJwt(c) } }, mkRes());
    assert.equal(r.statusCode, 403, 'Expected 403 for ' + JSON.stringify(c));
    assert.equal(r.body.error, 'OIDC_FORBIDDEN');
  }
});

test('T831.3 Expired pilot window rejected (403) and POST / ?check=runtime preserve Firebase user Auth', async () => {
  const expiredHandler = makeHandler({
    enabled: true,
    numericApplyEnabled: false,
    pilotWindow: pilotWindowJson(PAST_EXP),
    githubJwks: async () => [JWK],
  });
  const rExp = await expiredHandler({ method: 'GET', query: { check: 'runtime-a4' }, headers: { authorization: 'Bearer ' + signJwt() } }, mkRes());
  assert.equal(rExp.statusCode, 403);
  assert.equal(rExp.body.error, 'PILOT_WINDOW_INVALID');

  // User POST & ?check=runtime still require Firebase verifyIdToken and reject GitHub OIDC token
  const userHandler = makeHandler({
    enabled: true,
    numericApplyEnabled: false,
    pilotWindow: pilotWindowJson(),
    verifyIdToken: async () => { throw new Error('NOT_A_FIREBASE_ID_TOKEN'); },
  });
  const oidcTok = signJwt();
  const rPost = await userHandler({ method: 'POST', headers: { authorization: 'Bearer ' + oidcTok }, body: {} }, mkRes());
  assert.equal(rPost.statusCode, 401);
  assert.equal(rPost.body.error, 'AUTH_INVALID');

  const rRuntime = await userHandler({ method: 'GET', query: { check: 'runtime' }, headers: { authorization: 'Bearer ' + oidcTok } }, mkRes());
  assert.equal(rRuntime.statusCode, 401);
  assert.equal(rRuntime.body.error, 'AUTH_INVALID');
});

test('T831.4 runtimeEvidence validates runtimeSha and Numeric Apply OFF via ?check=runtime-a4', async () => {
  const w = {
    schema: 'vdsen-ayrton-window-v1',
    mode: 'STAGE1_SHADOW',
    pid: AUTHORIZED_PID,
    uid: UID,
    coachId: COACH,
    planId: PLAN,
    runtimeSha: RUNTIME_SHA,
    deployment: STAGE1_DEPLOYMENT,
    expiresAt: FUTURE_EXP,
    operationId: OP_ID,
  };
  const sha = 'fb6c056b17d798c07d06878a857c359aa70828ea44debb1bcab5eb644701fe12';
  const baseDeploy = { id: STAGE1_DEPLOYMENT, projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN', teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8', url: 'vdsen-stage1.vercel.app', readyState: 'READY', target: 'production', meta: { githubCommitSha: RUNTIME_SHA } };

  // Wrong runtimeSha -> rejected
  await assert.rejects(() => runtimeEvidence(w, {
    assertLegacyRetired: async () => true,
    oidcToken: signJwt(),
    deployment: async () => baseDeploy,
    currentApp: async () => STAGE1_DEPLOYMENT,
    fetch: async () => ({ status: 200, json: async () => ({ schema: 'vdsen-progression-runtime-v1', processingEnabled: true, numericApplyEnabled: false, cronConfigured: false, pilotWindow: { uidHash: sha, planHash: sha256(PLAN), expiresAt: FUTURE_EXP, operationId: OP_ID }, runtimeSha: 'f'.repeat(40) }) }),
  }), /RUNTIME_CHANGED/);

  // Numeric Apply enabled -> rejected
  await assert.rejects(() => runtimeEvidence(w, {
    assertLegacyRetired: async () => true,
    oidcToken: signJwt(),
    deployment: async () => baseDeploy,
    currentApp: async () => STAGE1_DEPLOYMENT,
    fetch: async () => ({ status: 200, json: async () => ({ schema: 'vdsen-progression-runtime-v1', processingEnabled: true, numericApplyEnabled: true, cronConfigured: false, pilotWindow: { uidHash: sha, planHash: sha256(PLAN), expiresAt: FUTURE_EXP, operationId: OP_ID }, runtimeSha: RUNTIME_SHA }) }),
  }), /EFFECTIVE_NUMERIC_MUST_BE_OFF_IN_SHADOW/);
});

test('T831.5 ENABLE with GitHub Actions OIDC fails closed before writing Firestore if probe fails, and succeeds when all gates pass', async () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema',
    GITHUB_REF: 'refs/heads/codex/client-app-next',
    GITHUB_WORKFLOW_REF: 'vdsenasesoria-svg/vdsen-ecosistema/.github/workflows/vdsen-ayrton-window.yml@refs/heads/codex/client-app-next',
    GITHUB_RUN_ATTEMPT: '1',
    AYRTON_WINDOW_RELEASE_ENABLED: 'true',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token?sig=1',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ephemeral-req-tok',
    INPUT_ARM_RUN_ID: '44099999999',
    INPUT_UID: UID,
    INPUT_COACH: COACH,
    INPUT_PLAN: PLAN,
    INPUT_PID: AUTHORIZED_PID,
    INPUT_RUNTIME: RUNTIME_SHA,
    INPUT_EXPIRY: FUTURE_EXP,
    INPUT_OPERATION: OP_ID,
    GOOGLE_ACCESS_TOKEN: 'mock-wif-token',
  };
  assert.equal(invocation(env, 'ENABLE').action, 'ENABLE');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't831-oidc-'));
  const windowFile = path.join(tmpDir, 'win.json');
  const handler = makeHandler({
    enabled: true,
    numericApplyEnabled: false,
    pilotWindow: pilotWindowJson(),
    runtimeSha: RUNTIME_SHA,
    githubJwks: async () => [JWK],
  });

  // Failing probe -> zero Firestore COMMIT calls
  let commitsOnFail = 0;
  await assert.rejects(() => executeWindowAction('ENABLE', {
    env,
    state: { runtime_sha: RUNTIME_SHA, production_deployment: OFF_BASELINE },
    windowFile,
    gh: () => JSON.stringify({ path: '.github/workflows/vdsen-ayrton-runtime.yml', head_branch: 'codex/client-app-next', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }),
    report: {
      schema: 'vdsen-ayrton-runtime-release-v1', operationId: OP_ID, runtimeSha: RUNTIME_SHA, mode: 'STAGE1_SHADOW', pid: AUTHORIZED_PID,
      baseline: { runtimeSha: RUNTIME_SHA, deployment: OFF_BASELINE }, staged: { id: STAGE1_DEPLOYMENT },
      window: { schema: 'vdsen-ayrton-window-v1', mode: 'STAGE1_SHADOW', pid: AUTHORIZED_PID, uid: UID, coachId: COACH, planId: PLAN, runtimeSha: RUNTIME_SHA, deployment: STAGE1_DEPLOYMENT, expiresAt: FUTURE_EXP, operationId: OP_ID },
      fencesAfter: { releaseEnabled: false, coachEnabled: false }, status: 'RUNTIME_READY_FENCES_CLOSED_NOT_ACTIVATED',
    },
    currentApp: async () => STAGE1_DEPLOYMENT,
    deployment: async (_s, id) => ({ id, projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN', teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8', target: 'production', readyState: 'READY', url: 'vdsen-stage1.vercel.app', meta: { githubCommitSha: RUNTIME_SHA } }),
    fetch: async url => {
      if (String(url).startsWith('https://oidc.example/')) return { status: 200, json: async () => ({ value: signJwt({ aud: 'vdsen-ayrton-runtime-a4:wrong-op' }) }) };
      const r = await handler({ method: 'GET', query: { check: 'runtime-a4' }, headers: { authorization: 'Bearer ' + signJwt({ aud: 'vdsen-ayrton-runtime-a4:wrong-op' }) } }, mkRes());
      return { status: r.statusCode, json: async () => r.body };
    },
    http: async (m, p) => {
      if (m === 'COMMIT') { commitsOnFail++; return { status: 500, body: {} }; }
      if (p === C.RELEASE_PATH) return { status: 200, body: { fields: { schema: { stringValue: 'vdsen-autonomous-release-v1' }, enabled: { booleanValue: false }, clientIds: { arrayValue: { values: [{ stringValue: UID }] } }, expiresAt: { stringValue: PAST_EXP } } } };
      if (p.startsWith('coaches/')) return { status: 200, body: { fields: { autoApplyCanary: { mapValue: { fields: { enabled: { booleanValue: false }, clientIds: { arrayValue: { values: [{ stringValue: UID }] } }, prescriptionExerciseIds: { arrayValue: { values: [{ stringValue: AUTHORIZED_PID }] } } } } } } } };
      if (p.startsWith('clients/')) return { status: 200, body: { fields: { coachId: { stringValue: COACH }, activePlanId: { stringValue: PLAN } } } };
      if (p.startsWith('plans/')) return { status: 200, body: { fields: { days: { arrayValue: { values: [{ mapValue: { fields: { exercises: { arrayValue: { values: [{ mapValue: { fields: { prescriptionExerciseId: { stringValue: AUTHORIZED_PID } } } }] } } } } }] } } } } };
      return { status: 404, body: {} };
    },
  }), /WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY/);
  assert.equal(commitsOnFail, 0);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
