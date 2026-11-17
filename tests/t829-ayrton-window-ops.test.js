'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { invocation, buildWindow, executeStatus, executeWindowAction, AUTHORIZED_PID } = require('../scripts/pilot/ayrton-window-ops.cjs');
const C = require('../scripts/pilot/ayrton-canary.cjs');

const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const COACH = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const PLAN = 'D5fVjlS3NysTD6Yg2ZpW';
const RUNTIME_SHA = '076c8c70a276cb80d669d7cd187861756405871f';
const DEPLOYMENT = 'dpl_8kLZt5zTgAbyvPR9jyoLeb6MsD6C';
const FUTURE_EXP = new Date(Date.now() + 2 * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PAST_EXP = new Date(Date.now() - 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');

function baseEnv(overrides = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema',
    GITHUB_REF: 'refs/heads/codex/client-app-next',
    GITHUB_WORKFLOW_REF: 'vdsenasesoria-svg/vdsen-ecosistema/.github/workflows/vdsen-ayrton-window.yml@refs/heads/codex/client-app-next',
    GITHUB_RUN_ATTEMPT: '1',
    INPUT_UID: UID,
    INPUT_COACH: COACH,
    INPUT_PLAN: PLAN,
    INPUT_PID: AUTHORIZED_PID,
    INPUT_RUNTIME: RUNTIME_SHA,
    INPUT_EXPIRY: FUTURE_EXP,
    INPUT_OPERATION: 'op-t829-window-test',
    GOOGLE_ACCESS_TOKEN: 'mock-wif-token',
    ...overrides,
  };
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

test('T829.1 STATUS reads both closed fences via WIF without leaking tokens or personal docs', async () => {
  const res = await executeStatus({
    uid: UID,
    coachId: COACH,
    token: 'secret-wif-token-never-logged',
    http: async (_m, p) => {
      if (p === C.RELEASE_PATH) return { status: 200, body: encDoc({ schema: 'vdsen-autonomous-release-v1', enabled: false, clientIds: [UID], expiresAt: PAST_EXP }) };
      if (p.startsWith('coaches/')) return { status: 200, body: encDoc({ autoApplyCanary: { enabled: false, clientIds: [UID], prescriptionExerciseIds: [AUTHORIZED_PID] } }) };
      if (p.startsWith('clients/')) return { status: 200, body: encDoc({ coachId: COACH, activePlanId: PLAN }) };
      return { status: 404, body: {} };
    },
  });
  assert.equal(res.bothClosed, true);
  assert.equal(res.releaseFence.enabled, false);
  assert.equal(res.coachFence.enabled, false);
  assert.equal(res.releaseFence.exclusiveScope, true);
  assert.equal(res.coachFence.exclusiveScope, true);
  assert.equal(res.clientLinkConsistent, true);
  assert.ok(!JSON.stringify(res).includes('secret-wif-token-never-logged'));
});

test('T829.2 ENABLE rejected without A4 authorization, without Firebase ID token, on rerun, or on non-canonical branch', () => {
  assert.throws(() => invocation(baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', VDSEN_PILOT_ID_TOKEN: 'idtok' }), 'ENABLE'), /FENCE_ENABLE_DISARMED/);
  assert.throws(() => invocation(baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true' }), 'ENABLE'), /AUTHENTICATED_PROBE_BLOCKED/);
  assert.throws(() => invocation(baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'idtok', GITHUB_RUN_ATTEMPT: '2' }), 'ENABLE'), /NO_JOB_RERUNS/);
  assert.throws(() => invocation(baseEnv({ GITHUB_REF: 'refs/heads/main', AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'idtok' }), 'ENABLE'), /CANONICAL_BRANCH_REQUIRED/);
});

test('T829.3 ENABLE rejects expired window, wrong UID, and wrong PID', () => {
  const s = { runtime_sha: RUNTIME_SHA, production_deployment: DEPLOYMENT };
  assert.throws(() => buildWindow(baseEnv({ INPUT_EXPIRY: PAST_EXP }), s, 'ENABLE'), /EXPIRY_INVALID/);
  assert.throws(() => buildWindow(baseEnv({ INPUT_UID: 'OtherAthleteUid1234567890' }), s, 'ENABLE'), /ONLY_AYRTON/);
  assert.throws(() => buildWindow(baseEnv({ INPUT_PID: 'wrong-pid' }), s, 'ENABLE'), /ONLY_AUTHORIZED_PID/);
});

test('T829.4 ENABLE simulated atomic transaction + readback + verified runtime probe (Numeric Apply stays OFF)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't829-enable-'));
  const windowFile = path.join(tmpDir, 'win.json');
  let relEnabled = false;
  let coachEnabled = false;
  let committed = 0;

  const res = await executeWindowAction('ENABLE', {
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'ayrton-id-token' }),
    state: { runtime_sha: RUNTIME_SHA, production_deployment: DEPLOYMENT },
    windowFile,
    http: async (m, p) => {
      if (m === 'COMMIT') {
        committed++;
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

  assert.equal(committed, 1);
  assert.equal(res.wrote, 2);
  assert.equal(res.verifiedBefore, true);
  assert.equal(res.verifiedAfter, true);
  assert.equal(res.readback.releaseEnabled, true);
  assert.equal(res.readback.coachEnabled, true);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('T829.5 Partial failure / uncertain commit fails closed and writes diagnostic evidence', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't829-fail-'));
  const windowFile = path.join(tmpDir, 'win.json');

  await assert.rejects(async () => executeWindowAction('ENABLE', {
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'true', VDSEN_PILOT_ID_TOKEN: 'ayrton-id-token' }),
    state: { runtime_sha: RUNTIME_SHA, production_deployment: DEPLOYMENT },
    windowFile,
    http: async (m, p) => {
      if (m === 'COMMIT') return { status: 409, body: { error: { message: 'ABORTED_PRECONDITION' } } };
      if (p === C.RELEASE_PATH) return { status: 200, body: encDoc({ schema: 'vdsen-autonomous-release-v1', enabled: false, clientIds: [UID], expiresAt: PAST_EXP }) };
      if (p.startsWith('coaches/')) return { status: 200, body: encDoc({ autoApplyCanary: { enabled: false, clientIds: [UID], prescriptionExerciseIds: [AUTHORIZED_PID] } }) };
      if (p.startsWith('clients/')) return { status: 200, body: encDoc({ coachId: COACH, activePlanId: PLAN }) };
      return { status: 404, body: {} };
    },
    runtimeEvidence: async w => ({ deployment: w.deployment, runtimeSha: w.runtimeSha, flags: { processingEnabled: true, numericApplyEnabled: false, cronConfigured: false } }),
  }), /WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY/);

  assert.ok(fs.existsSync(windowFile + '.evidence.json'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('T829.6 STOP closes fences without ENABLE switch, even on rerun, even if runtime probe fails, and is idempotent on repeat', async () => {
  const auth = invocation(baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', GITHUB_RUN_ATTEMPT: '3' }), 'STOP');
  assert.equal(auth.action, 'STOP');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't829-stop-'));
  const windowFile = path.join(tmpDir, 'win.json');
  let relEnabled = true;
  let coachEnabled = true;
  let relExp = FUTURE_EXP;

  const mockHttp = async (m, p) => {
    if (m === 'COMMIT') {
      relEnabled = false;
      coachEnabled = false;
      relExp = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      return { status: 200, body: { writeResults: [{ updateTime: '2026-11-17T04:12:00Z' }, { updateTime: '2026-11-17T04:12:00Z' }] } };
    }
    if (p === C.RELEASE_PATH) return { status: 200, body: encDoc({ schema: 'vdsen-autonomous-release-v1', enabled: relEnabled, clientIds: [UID], expiresAt: relExp }) };
    if (p.startsWith('coaches/')) return { status: 200, body: encDoc({ autoApplyCanary: { enabled: coachEnabled, clientIds: [UID], prescriptionExerciseIds: [AUTHORIZED_PID] } }) };
    if (p.startsWith('clients/')) return { status: 200, body: encDoc({ coachId: COACH, activePlanId: PLAN }) };
    return { status: 404, body: {} };
  };

  const first = await executeWindowAction('STOP', {
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', INPUT_EXPIRY: PAST_EXP }),
    state: { runtime_sha: RUNTIME_SHA, production_deployment: DEPLOYMENT },
    windowFile,
    http: mockHttp,
    runtimeEvidence: async () => { throw new Error('RUNTIME_DOWN_502'); },
  });
  assert.equal(first.wrote, 2);
  assert.equal(first.readback.releaseEnabled, false);
  assert.equal(first.readback.coachEnabled, false);

  const second = await executeWindowAction('STOP', {
    env: baseEnv({ AYRTON_WINDOW_RELEASE_ENABLED: 'false', INPUT_EXPIRY: PAST_EXP }),
    state: { runtime_sha: RUNTIME_SHA, production_deployment: DEPLOYMENT },
    windowFile,
    http: mockHttp,
    runtimeEvidence: async () => { throw new Error('RUNTIME_DOWN_502'); },
  });
  assert.equal(second.unchanged, true);
  assert.equal(second.wrote, 0);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('T829.7 vdsen-ayrton-window.yml enforces Environment Production, concurrency, WIF, and no ID token input/secret', () => {
  const wf = fs.readFileSync('.github/workflows/vdsen-ayrton-window.yml', 'utf8');
  assert.ok(wf.includes('environment: Production'));
  assert.ok(wf.includes('group: vdsen-ayrton-window'));
  assert.ok(wf.includes('cancel-in-progress: false'));
  assert.ok(wf.includes('google-github-actions/auth'));
  assert.ok(!wf.includes('credentials_json:'));
  assert.ok(!wf.includes('VDSEN_PILOT_ID_TOKEN'));
  assert.ok(!wf.includes('id_token'));
  assert.ok(!wf.includes('NUMERIC_APPLY_ENABLED'));
});
