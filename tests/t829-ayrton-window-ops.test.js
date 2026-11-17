'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { invocation, verifyArmArtifact, buildWindow, executeStatus, executeWindowAction, AUTHORIZED_PID } = require('../scripts/pilot/ayrton-window-ops.cjs');
const C = require('../scripts/pilot/ayrton-canary.cjs');
const { makeHandler } = require('../api/autonomous-progression-trigger.js');

const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const COACH = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const PLAN = 'D5fVjlS3NysTD6Yg2ZpW';
const RUNTIME_SHA = '076c8c70a276cb80d669d7cd187861756405871f';
const OFF_BASELINE = 'dpl_8kLZt5zTgAbyvPR9jyoLeb6MsD6C';
const STAGE1_DEPLOYMENT = 'dpl_Stage1ShadowReal0000000001';
const ARM_RUN_ID = '44099999999';
const OP_ID = 'op-t830-shadow-verified';
const FUTURE_EXP = new Date(Date.now() + 2 * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PAST_EXP = new Date(Date.now() - 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');

function baseEnv(overrides = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema',
    GITHUB_REF: 'refs/heads/codex/client-app-next',
    GITHUB_WORKFLOW_REF: 'vdsenasesoria-svg/vdsen-ecosistema/.github/workflows/vdsen-ayrton-window.yml@refs/heads/codex/client-app-next',
    GITHUB_RUN_ATTEMPT: '1',
    INPUT_ARM_RUN_ID: ARM_RUN_ID,
    INPUT_UID: UID,
    INPUT_COACH: COACH,
    INPUT_PLAN: PLAN,
    INPUT_PID: AUTHORIZED_PID,
    INPUT_RUNTIME: RUNTIME_SHA,
    INPUT_EXPIRY: FUTURE_EXP,
    INPUT_OPERATION: OP_ID,
    GOOGLE_ACCESS_TOKEN: 'mock-wif-token',
    ...overrides,
  };
}

function validArmReport(overrides = {}) {
  return {
    schema: 'vdsen-ayrton-runtime-release-v1',
    operationId: OP_ID,
    runtimeSha: RUNTIME_SHA,
    mode: 'STAGE1_SHADOW',
    pid: AUTHORIZED_PID,
    baseline: { runtimeSha: RUNTIME_SHA, deployment: OFF_BASELINE, officialReleaseRun: '43992221920' },
    staged: { id: STAGE1_DEPLOYMENT, url: 'vdsen-stage1.vercel.app' },
    window: {
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
    },
    fencesAfter: { releaseEnabled: false, coachEnabled: false, exclusiveScopeVerified: true },
    status: 'RUNTIME_READY_FENCES_CLOSED_NOT_ACTIVATED',
    ...overrides,
  };
}

function validGhRun(overrides = {}) {
  return JSON.stringify({
    path: '.github/workflows/vdsen-ayrton-runtime.yml',
    head_branch: 'codex/client-app-next',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  });
}

function encDoc(obj) {
  return {
    name: 'projects/vdsen-ecosistema/databases/(default)/documents/mock',
    updateTime: '2026-11-17T04:00:00Z',
    fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => {
      if (typeof v === 'boolean') return [k, { booleanValue: v }];
      if (typeof v === 'string') return [k, { stringValue: v }];
      if (Array.isArray(v)) return [k, { arrayValue: { values: v.map(x => ({ stringValue: x })) } }];
      return [k, {
        mapValue: {
          fields: {
            enabled: { booleanValue: !!v.enabled },
            clientIds: { arrayValue: { values: (v.clientIds || []).map(x => ({ stringValue: x })) } },
            prescriptionExerciseIds: { arrayValue: { values: (v.prescriptionExerciseIds || []).map(x => ({ stringValue: x })) } },
          },
        },
      }];
    })),
  };
}

test('A: Deployment OFF vs STAGE1 real — ENABLE rejects OFF baseline and binds to staged.id + live Vercel alias', async () => {
  const s = { runtime_sha: RUNTIME_SHA, production_deployment: OFF_BASELINE };
  assert.throws(() => buildWindow(baseEnv(), s, 'ENABLE', Date.now(), OFF_BASELINE), /ENABLE_REQUIRES_VERIFIED_STAGE1_DEPLOYMENT/);

  const verified = await verifyArmArtifact({
    armRunId: ARM_RUN_ID,
    state: s,
    uid: UID,
    coachId: COACH,
    planId: PLAN,
    pid: AUTHORIZED_PID,
    runtimeSha: RUNTIME_SHA,
    operationId: OP_ID,
    expiresAt: FUTURE_EXP,
    gh: () => validGhRun(),
    report: validArmReport(),
    currentApp: async () => STAGE1_DEPLOYMENT,
    deployment: async (_s, id) => ({
      id,
      projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
      teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
      target: 'production',
      readyState: 'READY',
      meta: { githubCommitSha: RUNTIME_SHA },
    }),
  });
  assert.equal(verified.deployment, STAGE1_DEPLOYMENT);
  assert.notEqual(verified.deployment, OFF_BASELINE);
  assert.equal(verified.window.deployment, STAGE1_DEPLOYMENT);
});

test('B & C & H: Rejects missing/unauthorized/altered ARM artifact, mismatched operationId, or wrong runtime SHA', async () => {
  const s = { runtime_sha: RUNTIME_SHA, production_deployment: OFF_BASELINE };
  const baseOpts = {
    armRunId: ARM_RUN_ID,
    state: s,
    uid: UID,
    coachId: COACH,
    planId: PLAN,
    pid: AUTHORIZED_PID,
    runtimeSha: RUNTIME_SHA,
    operationId: OP_ID,
    expiresAt: FUTURE_EXP,
    currentApp: async () => STAGE1_DEPLOYMENT,
    deployment: async (_s, id) => ({
      id,
      projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
      teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
      target: 'production',
      readyState: 'READY',
      meta: { githubCommitSha: RUNTIME_SHA },
    }),
  };

  await assert.rejects(() => verifyArmArtifact({ ...baseOpts, gh: () => validGhRun({ path: '.github/workflows/other.yml' }), report: validArmReport() }), /ARM_RUN_WORKFLOW_MISMATCH/);
  await assert.rejects(() => verifyArmArtifact({ ...baseOpts, gh: () => validGhRun({ head_branch: 'main' }), report: validArmReport() }), /ARM_RUN_BRANCH_MISMATCH/);
  await assert.rejects(() => verifyArmArtifact({ ...baseOpts, gh: () => validGhRun({ conclusion: 'failure' }), report: validArmReport() }), /ARM_RUN_DID_NOT_SUCCEED/);
  await assert.rejects(() => verifyArmArtifact({ ...baseOpts, gh: () => validGhRun(), report: validArmReport({ status: 'PREPARING' }) }), /ARM_ARTIFACT_STATUS_INVALID/);
  await assert.rejects(() => verifyArmArtifact({ ...baseOpts, gh: () => validGhRun(), report: validArmReport({ operationId: 'op-other' }) }), /ARM_OPERATION_ID_MISMATCH/);
  await assert.rejects(() => verifyArmArtifact({ ...baseOpts, gh: () => validGhRun(), report: validArmReport({ runtimeSha: 'f'.repeat(40) }) }), /ARM_RUNTIME_SHA_MISMATCH/);
  await assert.rejects(() => verifyArmArtifact({
    ...baseOpts,
    gh: () => validGhRun(),
    report: validArmReport(),
    deployment: async (_s, id) => ({
      id,
      projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
      teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
      target: 'production',
      readyState: 'READY',
      meta: { githubCommitSha: 'e'.repeat(40) },
    }),
  }), /ARM_VERCEL_SHA_MISMATCH/);
});

test('D & E & F: Runtime probe requires valid Firebase ID token for Ayrton; rejects missing (401) and unauthorized UID (403)', async () => {
  const mkRes = () => {
    const out = { statusCode: 0, body: null, headers: {} };
    return {
      setHeader(k, v) { out.headers[k] = v; },
      status(c) { out.statusCode = c; return { json(b) { out.body = b; return out; } }; },
    };
  };
  const sha256 = x => crypto.createHash('sha256').update(x).digest('hex');
  const handler = makeHandler({
    enabled: true,
    numericApplyEnabled: false,
    pilotWindow: JSON.stringify({ uidHash: sha256(UID), planHash: sha256(PLAN), expiresAt: FUTURE_EXP, operationId: OP_ID }),
    verifyIdToken: async tok => {
      if (tok === 'valid-ayrton-tok') return { uid: UID };
      if (tok === 'other-user-tok') return { uid: 'OtherUserUid1234567890123' };
      throw new Error('INVALID_TOKEN');
    },
  });

  // E: No auth -> 401
  const noAuth = await handler({ method: 'GET', query: { check: 'runtime' }, headers: {} }, mkRes());
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.body.error, 'AUTH_MISSING');

  // F: Unauthorized UID -> 403
  const other = await handler({ method: 'GET', query: { check: 'runtime' }, headers: { authorization: 'Bearer other-user-tok' } }, mkRes());
  assert.equal(other.statusCode, 403);
  assert.equal(other.body.error, 'PROBE_FORBIDDEN');

  // D: Valid Ayrton Firebase ID token -> 200 with numericApplyEnabled=false
  const ok = await handler({ method: 'GET', query: { check: 'runtime' }, headers: { authorization: 'Bearer valid-ayrton-tok' } }, mkRes());
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.processingEnabled, true);
  assert.equal(ok.body.numericApplyEnabled, false);
});

test('G: ENABLE rejected without A4 authorization, without Firebase ID token, or without arm_run_id', () => {
  assert.throws(() => invocation(baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', VDSEN_PILOT_ID_TOKEN: 'idtok' }), 'ENABLE'), /FENCE_ENABLE_DISARMED/);
  assert.throws(() => invocation(baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true' }), 'ENABLE'), /AUTHENTICATED_PROBE_BLOCKED/);
  assert.throws(() => invocation(baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'idtok', INPUT_ARM_RUN_ID: '' }), 'ENABLE'), /ARM_RUN_ID_REQUIRED/);
  assert.throws(() => invocation(baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'idtok', GITHUB_RUN_ATTEMPT: '2' }), 'ENABLE'), /NO_JOB_RERUNS/);
});

test('I: Workflow concurrency serializes ARM/ENABLE/RESTORE on vdsen-production and keeps emergency STOP deadlock-free', () => {
  const winWf = fs.readFileSync('.github/workflows/vdsen-ayrton-window.yml', 'utf8');
  const rtWf = fs.readFileSync('.github/workflows/vdsen-ayrton-runtime.yml', 'utf8');
  assert.ok(rtWf.includes('group: vdsen-production'));
  assert.ok(winWf.includes("inputs.action == 'STOP' && 'vdsen-ayrton-emergency-stop' || 'vdsen-production'"));
  assert.ok(winWf.includes('cancel-in-progress: false'));
  assert.ok(winWf.includes('environment: Production'));
  assert.ok(winWf.includes('google-github-actions/auth'));
  assert.ok(!winWf.includes('credentials_json:'));
  assert.ok(!winWf.includes('VDSEN_PILOT_ID_TOKEN'));
  assert.ok(!winWf.includes('NUMERIC_APPLY_ENABLED'));
});

test('M & N: STATUS and ENABLE readback preserve Numeric Apply OFF and bind to STAGE1_DEPLOYMENT', async () => {
  const statusRes = await executeStatus({
    uid: UID,
    coachId: COACH,
    token: 'secret-wif-token',
    http: async (_m, p) => {
      if (p === C.RELEASE_PATH) return { status: 200, body: encDoc({ schema: 'vdsen-autonomous-release-v1', enabled: false, clientIds: [UID], expiresAt: PAST_EXP }) };
      if (p.startsWith('coaches/')) return { status: 200, body: encDoc({ autoApplyCanary: { enabled: false, clientIds: [UID], prescriptionExerciseIds: [AUTHORIZED_PID] } }) };
      if (p.startsWith('clients/')) return { status: 200, body: encDoc({ coachId: COACH, activePlanId: PLAN }) };
      return { status: 404, body: {} };
    },
  });
  assert.equal(statusRes.bothClosed, true);
  assert.ok(!JSON.stringify(statusRes).includes('secret-wif-token'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't830-enable-'));
  const windowFile = path.join(tmpDir, 'win.json');
  let relEnabled = false;
  let coachEnabled = false;
  const res = await executeWindowAction('ENABLE', {
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'ayrton-id-token' }),
    state: { runtime_sha: RUNTIME_SHA, production_deployment: OFF_BASELINE },
    windowFile,
    gh: () => validGhRun(),
    report: validArmReport(),
    currentApp: async () => STAGE1_DEPLOYMENT,
    deployment: async (_s, id) => ({
      id,
      projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
      teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
      target: 'production',
      readyState: 'READY',
      meta: { githubCommitSha: RUNTIME_SHA },
    }),
    http: async (m, p) => {
      if (m === 'COMMIT') {
        relEnabled = true;
        coachEnabled = true;
        return { status: 200, body: { writeResults: [{ updateTime: '2026-11-17T04:10:00Z' }, { updateTime: '2026-11-17T04:10:00Z' }] } };
      }
      if (p === C.RELEASE_PATH) return { status: 200, body: encDoc({ schema: 'vdsen-autonomous-release-v1', enabled: relEnabled, clientIds: [UID], expiresAt: relEnabled ? FUTURE_EXP : PAST_EXP }) };
      if (p.startsWith('coaches/')) return { status: 200, body: encDoc({ autoApplyCanary: { enabled: coachEnabled, clientIds: [UID], prescriptionExerciseIds: [AUTHORIZED_PID] } }) };
      if (p.startsWith('clients/')) return { status: 200, body: encDoc({ coachId: COACH, activePlanId: PLAN }) };
      if (p.startsWith('plans/')) return { status: 200, body: { fields: { days: { arrayValue: { values: [{ mapValue: { fields: { exercises: { arrayValue: { values: [{ mapValue: { fields: { prescriptionExerciseId: { stringValue: AUTHORIZED_PID } } } }] } } } } }] } } } } };
      return { status: 404, body: {} };
    },
    runtimeEvidence: async w => ({
      deployment: w.deployment,
      runtimeSha: w.runtimeSha,
      flags: { processingEnabled: true, numericApplyEnabled: false, cronConfigured: false },
      capturedAt: new Date().toISOString(),
    }),
  });
  assert.equal(res.deployment, STAGE1_DEPLOYMENT);
  assert.equal(res.wrote, 4);
  assert.equal(res.readback.releaseEnabled, true);
  assert.equal(res.readback.coachEnabled, true);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('J & K & L: STOP recovers expired window without runtime/Vercel/ID-token/ENABLE-switch and is idempotent on repeat', async () => {
  const auth = invocation(baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', GITHUB_RUN_ATTEMPT: '3', INPUT_ARM_RUN_ID: '' }), 'STOP');
  assert.equal(auth.action, 'STOP');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't830-stop-'));
  const windowFile = path.join(tmpDir, 'win.json');
  let relEnabled = true;
  let coachEnabled = true;
  let relExp = PAST_EXP;
  let revoked = false;

  const mockHttp = async (m, p) => {
    if (m === 'COMMIT') {
      relEnabled = false;
      coachEnabled = false;
      revoked = true;
      relExp = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      return { status: 200, body: { writeResults: [{ updateTime: '2026-11-17T04:12:00Z' }, { updateTime: '2026-11-17T04:12:00Z' }, { updateTime: '2026-11-17T04:12:00Z' }, { updateTime: '2026-11-17T04:12:00Z' }, { updateTime: '2026-11-17T04:12:00Z' }] } };
    }
    if (p.startsWith('releaseControl/ayrtonRevocation_')) return revoked ? { status: 200, body: encDoc({ revoked: true, operationId: OP_ID }) } : { status: 404, body: {} };
    if (p.startsWith('releaseControl/ayrtonOperation_')) return revoked ? { status: 200, body: encDoc({ status: 'REVOKED', operationId: OP_ID }) } : { status: 404, body: {} };
    if (p === 'releaseControl/ayrtonActiveWindow') return revoked ? { status: 200, body: encDoc({ active: false, operationId: OP_ID }) } : { status: 404, body: {} };
    if (p === C.RELEASE_PATH) return { status: 200, body: encDoc({ schema: 'vdsen-autonomous-release-v1', enabled: relEnabled, clientIds: [UID], expiresAt: relExp }) };
    if (p.startsWith('coaches/')) return { status: 200, body: encDoc({ autoApplyCanary: { enabled: coachEnabled, clientIds: [UID], prescriptionExerciseIds: [AUTHORIZED_PID] } }) };
    if (p.startsWith('clients/')) return { status: 200, body: encDoc({ coachId: COACH, activePlanId: PLAN }) };
    return { status: 404, body: {} };
  };

  const first = await executeWindowAction('STOP', {
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', INPUT_PLAN: '', INPUT_EXPIRY: '', INPUT_ARM_RUN_ID: '' }),
    state: { runtime_sha: RUNTIME_SHA, production_deployment: OFF_BASELINE },
    windowFile,
    http: mockHttp,
    currentApp: async () => { throw new Error('VERCEL_UNREACHABLE'); },
    runtimeEvidence: async () => { throw new Error('RUNTIME_DOWN_502'); },
  });
  assert.equal(first.wrote, 5);
  assert.equal(first.operationRevoked, true);
  assert.equal(first.revocationScope, 'DURABLE_OPERATION_REVOCATION_VERIFIED');
  assert.equal(first.readback.releaseEnabled, false);
  assert.equal(first.readback.coachEnabled, false);
  assert.equal(first.readback.revocationVerified, true);

  const second = await executeWindowAction('STOP', {
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', INPUT_PLAN: '', INPUT_EXPIRY: '', INPUT_ARM_RUN_ID: '' }),
    state: { runtime_sha: RUNTIME_SHA, production_deployment: OFF_BASELINE },
    windowFile,
    http: mockHttp,
    currentApp: async () => { throw new Error('VERCEL_UNREACHABLE'); },
    runtimeEvidence: async () => { throw new Error('RUNTIME_DOWN_502'); },
  });
  assert.equal(second.unchanged, true);
  assert.equal(second.wrote, 0);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('T832 D/E/F/G/J/K: STOP/ENABLE concurrency race, durable revocation, no duplicate ENABLE, and uncertain Firestore failure', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't832-race-'));
  const windowFile = path.join(tmpDir, 'win.json');

  // Simulated atomic Firestore store with updateTime & exists preconditions
  function createStore() {
    let ver = 1;
    const docs = {
      [C.RELEASE_PATH]: { updateTime: 't' + ver, data: { schema: 'vdsen-autonomous-release-v1', enabled: false, clientIds: [UID], expiresAt: PAST_EXP } },
      ['coaches/' + COACH]: { updateTime: 't' + ver, data: { autoApplyCanary: { enabled: false, clientIds: [UID], prescriptionExerciseIds: [AUTHORIZED_PID] } } },
      ['clients/' + UID]: { updateTime: 't' + ver, data: { coachId: COACH, activePlanId: PLAN } },
      ['plans/' + PLAN]: { updateTime: 't' + ver, data: { days: [{ exercises: [{ prescriptionExerciseId: AUTHORIZED_PID }] }] } },
    };
    const http = async (m, p, _tok, body) => {
      const cleanPath = p.split('?')[0];
      if (m === 'GET') {
        const entry = docs[cleanPath];
        if (!entry) return { status: 404, body: {} };
        if (cleanPath.startsWith('plans/')) {
          return { status: 200, body: { updateTime: entry.updateTime, fields: { days: { arrayValue: { values: [{ mapValue: { fields: { exercises: { arrayValue: { values: [{ mapValue: { fields: { prescriptionExerciseId: { stringValue: AUTHORIZED_PID } } } }] } } } } }] } } } } };
        }
        return { status: 200, body: { ...encDoc(entry.data), updateTime: entry.updateTime } };
      }
      if (m === 'COMMIT') {
        for (const w of body.writes) {
          const wPath = w.update.name.replace(/^projects\/[^/]+\/databases\/\(default\)\/documents\//, '');
          const cur = docs[wPath];
          const cond = w.currentDocument || {};
          if (cond.exists === false && cur) return { status: 409, body: { error: 'ALREADY_EXISTS' } };
          if (cond.updateTime && (!cur || cur.updateTime !== cond.updateTime)) return { status: 409, body: { error: 'FAILED_PRECONDITION' } };
        }
        ver++;
        const ts = 't' + ver;
        const results = [];
        for (const w of body.writes) {
          const wPath = w.update.name.replace(/^projects\/[^/]+\/databases\/\(default\)\/documents\//, '');
          const decoded = C.decDoc({ fields: w.update.fields }) || {};
          docs[wPath] = { updateTime: ts, data: Object.assign({}, docs[wPath] ? docs[wPath].data : {}, decoded) };
          results.push({ updateTime: ts });
        }
        return { status: 200, body: { writeResults: results } };
      }
      return { status: 404, body: {} };
    };
    return { docs, http };
  }

  const commonOpts = store => ({
    state: { runtime_sha: RUNTIME_SHA, production_deployment: OFF_BASELINE },
    windowFile,
    gh: () => validGhRun(),
    report: validArmReport(),
    currentApp: async () => STAGE1_DEPLOYMENT,
    deployment: async (_s, id) => ({ id, projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN', teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8', target: 'production', readyState: 'READY', meta: { githubCommitSha: RUNTIME_SHA } }),
    runtimeEvidence: async w => ({ deployment: w.deployment, runtimeSha: w.runtimeSha, flags: { processingEnabled: true, numericApplyEnabled: false, cronConfigured: false }, capturedAt: new Date().toISOString() }),
    http: store.http,
  });

  // D: ENABLE reads closed fences before STOP; STOP commits first (even though fences were already closed!); ENABLE's commit MUST fail closed and fences stay CLOSED.
  const storeD = createStore();
  let stopRan = false;
  const wrappedHttpD = async (m, p, tok, body) => {
    if (m === 'COMMIT' && !stopRan) {
      stopRan = true;
      await executeWindowAction('STOP', { ...commonOpts(storeD), env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false' }) });
    }
    return storeD.http(m, p, tok, body);
  };
  await assert.rejects(() => executeWindowAction('ENABLE', {
    ...commonOpts(storeD),
    http: wrappedHttpD,
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'tok' }),
  }), /WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY/);
  assert.equal(storeD.docs[C.RELEASE_PATH].data.enabled, false);
  assert.equal(storeD.docs['coaches/' + COACH].data.autoApplyCanary.enabled, false);

  // E & J: STOP occurs before ENABLE (or new authorization reuses revoked operationId) -> ENABLE rejected
  await assert.rejects(() => executeWindowAction('ENABLE', {
    ...commonOpts(storeD),
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'tok' }),
  }), /WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY/);
  assert.equal(storeD.docs[C.RELEASE_PATH].data.enabled, false);

  // F & G: ENABLE commits first; second concurrent ENABLE for same operationId is rejected; subsequent STOP closes both fences
  const storeFG = createStore();
  const firstEnable = await executeWindowAction('ENABLE', {
    ...commonOpts(storeFG),
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'tok' }),
  });
  assert.equal(firstEnable.readback.releaseEnabled, true);
  await assert.rejects(() => executeWindowAction('ENABLE', {
    ...commonOpts(storeFG),
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'tok' }),
  }), /WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY/);
  const stopAfter = await executeWindowAction('STOP', {
    ...commonOpts(storeFG),
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false' }),
  });
  assert.equal(stopAfter.readback.releaseEnabled, false);
  assert.equal(stopAfter.readback.coachEnabled, false);

  // K: Uncertain Firestore COMMIT (500) must fail closed without declaring success
  await assert.rejects(() => executeWindowAction('STOP', {
    ...commonOpts(storeFG),
    report: validArmReport({ operationId: 'op-t832-uncertain-500', window: { ...validArmReport().window, operationId: 'op-t832-uncertain-500' } }),
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', INPUT_OPERATION: 'op-t832-uncertain-500' }),
    http: async (m, p, tok, body) => (m === 'COMMIT' ? { status: 500, body: {} } : storeFG.http(m, p, tok, body)),
  }), /WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY/);

  // T833 A/C/D/E: STOP without INPUT_OPERATION resolves authentic operationId from ARM artifact, blocks concurrent/subsequent ENABLE, and rejects mismatched operationId
  const storeT833 = createStore();
  let t833StopRan = false;
  const wrappedT833 = async (m, p, tok, body) => {
    if (m === 'COMMIT' && !t833StopRan) {
      t833StopRan = true;
      const stopRes = await executeWindowAction('STOP', {
        ...commonOpts(storeT833),
        env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', INPUT_OPERATION: '', INPUT_PLAN: '', INPUT_EXPIRY: '' }),
      });
      assert.equal(stopRes.operationId, OP_ID);
      assert.equal(stopRes.operationRevoked, true);
      assert.equal(stopRes.revocationScope, 'DURABLE_OPERATION_REVOCATION_VERIFIED');
      assert.equal(stopRes.readback.revocationVerified, true);
    }
    return storeT833.http(m, p, tok, body);
  };
  await assert.rejects(() => executeWindowAction('ENABLE', {
    ...commonOpts(storeT833),
    http: wrappedT833,
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'tok' }),
  }), /WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY/);
  assert.equal(storeT833.docs[C.RELEASE_PATH].data.enabled, false);
  assert.equal(storeT833.docs['releaseControl/ayrtonRevocation_' + OP_ID].data.revoked, true);
  assert.equal(storeT833.docs['releaseControl/ayrtonRevocation_op-emergency-stop'], undefined);

  // T833 C: STOP with operationId different from ARM artifact fails closed
  await assert.rejects(() => executeWindowAction('STOP', {
    ...commonOpts(storeT833),
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', INPUT_OPERATION: 'op-other-not-arm' }),
  }), /ARM_OPERATION_ID_MISMATCH/);

  // T833 B: STOP without operationId and without ARM/active-window evidence closes fences atomically without inventing op-emergency-stop
  const storeUnresolved = createStore();
  storeUnresolved.docs[C.RELEASE_PATH].data.enabled = true;
  storeUnresolved.docs['coaches/' + COACH].data.autoApplyCanary.enabled = true;
  const unresolvedRes = await executeWindowAction('STOP', {
    ...commonOpts(storeUnresolved),
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', INPUT_ARM_RUN_ID: '', INPUT_OPERATION: '', INPUT_PLAN: '', INPUT_EXPIRY: '' }),
  });
  assert.equal(unresolvedRes.operationId, null);
  assert.equal(unresolvedRes.operationRevoked, false);
  assert.equal(unresolvedRes.revocationScope, 'EMERGENCY_FENCES_CLOSED_OPERATION_UNVERIFIED');
  assert.equal(unresolvedRes.readback.releaseEnabled, false);
  assert.equal(unresolvedRes.readback.coachEnabled, false);
  assert.equal(storeUnresolved.docs['releaseControl/ayrtonRevocation_op-emergency-stop'], undefined);

  // T833 H/I: Post-commit revocation readback failure reports uncertain state without claiming success
  const storeReadbackFail = createStore();
  await assert.rejects(() => executeWindowAction('STOP', {
    ...commonOpts(storeReadbackFail),
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false' }),
    http: async (m, p, tok, body) => {
      const r = await storeReadbackFail.http(m, p, tok, body);
      if (m === 'GET' && p.startsWith('releaseControl/ayrtonRevocation_') && storeReadbackFail.docs['releaseControl/ayrtonRevocation_' + OP_ID]) {
        return { status: 503, body: {} };
      }
      return r;
    },
  }), /WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
