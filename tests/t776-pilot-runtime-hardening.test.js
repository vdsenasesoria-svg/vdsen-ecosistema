'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { closed, adapters } = require('../scripts/pilot/ayrton-runtime.cjs');
const P = require('../scripts/pilot/window-protocol.cjs');

const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const COACH = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const PLAN = 'D5fVjlS3NysTD6Yg2ZpW';
const PID = 'ab150537-0d02-423b-a7e0-2b2f1a8a9a83';
const RUNTIME_SHA = '3fc264e23d67a8ecb1611a6c8af04ad739f422da';
const DEPLOYMENT = 'dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8';
const EXPIRES_AT = '2026-11-14T04:00:00Z';
const OPERATION_ID = 'op-ayrton-shadow-t776-test0001';

const sampleWindow = () => ({
  schema: 'vdsen-ayrton-window-v1',
  mode: 'STAGE1_SHADOW',
  pid: PID,
  uid: UID,
  coachId: COACH,
  planId: PLAN,
  runtimeSha: RUNTIME_SHA,
  deployment: DEPLOYMENT,
  expiresAt: EXPIRES_AT,
  operationId: OPERATION_ID,
});

const sampleState = () => ({
  runtime_sha: RUNTIME_SHA,
  production_deployment: DEPLOYMENT,
  production_project: P.PROJECT,
  vercel_team: P.TEAM,
  numeric_apply_enabled: false,
  app_release: {
    deployment: DEPLOYMENT,
    source_release_run: '43132135716',
    completed_at: '2026-11-12T01:16:37Z',
  },
});

test('T776-H1: closed() passes when release fence is absent/null (HTTP 404 in Firestore) and coach fence is closed', () => {
  const w = sampleWindow();
  const snap = {
    uid: UID,
    coachId: COACH,
    client: { coachId: COACH, activePlanId: PLAN },
    release: null, // absent document -> closed by default
    coach: { autoApplyCanary: { enabled: false, clientIds: [UID] } },
  };
  assert.doesNotThrow(() => closed(w, snap));
});

test('T776-H2: closed() passes when both release and coach fences are absent/empty', () => {
  const w = sampleWindow();
  const snap = {
    uid: UID,
    coachId: COACH,
    client: { coachId: COACH, activePlanId: PLAN },
    release: null,
    coach: {},
  };
  assert.doesNotThrow(() => closed(w, snap));
});

test('T776-H3: closed() strictly rejects when release fence is enabled: true', () => {
  const w = sampleWindow();
  const snap = {
    uid: UID,
    coachId: COACH,
    client: { coachId: COACH, activePlanId: PLAN },
    release: { enabled: true, clientIds: [UID], expiresAt: EXPIRES_AT },
    coach: { autoApplyCanary: { enabled: false, clientIds: [UID] } },
  };
  assert.throws(() => closed(w, snap), /RELEASE_FENCE_MUST_BE_DISABLED/);
});

test('T776-H4: closed() strictly rejects when coach fence is enabled: true', () => {
  const w = sampleWindow();
  const snap = {
    uid: UID,
    coachId: COACH,
    client: { coachId: COACH, activePlanId: PLAN },
    release: { enabled: false, clientIds: [UID] },
    coach: { autoApplyCanary: { enabled: true, clientIds: [UID], prescriptionExerciseIds: [PID] } },
  };
  assert.throws(() => closed(w, snap), /COACH_FENCE_MUST_BE_DISABLED/);
});

test('T776-H5: assertNoPriorOperation passes when no deployment matches operationId or baseline', async () => {
  const s = sampleState();
  const deployments = [
    { id: 'dpl_other1', meta: { githubCommitSha: 'abc' } },
    { id: 'dpl_other2', meta: { vdsenPilotOperation: 'other-op', vdsenPilotBaseline: 'dpl_other_baseline' } },
    { id: 'dpl_other3' },
  ];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ deployments, pagination: { next: null } }),
  });
  try {
    const io = adapters(s);
    await assert.doesNotReject(async () => io.assertNoPriorOperation('op-fresh-12345678'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('T776-H6: assertNoPriorOperation rejects when a deployment matches the operationId', async () => {
  const s = sampleState();
  const deployments = [
    { id: 'dpl_other1', meta: { githubCommitSha: 'abc' } },
    { id: 'dpl_matched', meta: { vdsenPilotOperation: 'op-already-used-1234' } },
  ];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ deployments, pagination: { next: null } }),
  });
  try {
    const io = adapters(s);
    await assert.rejects(
      async () => io.assertNoPriorOperation('op-already-used-1234'),
      /PILOT_OPERATION_ALREADY_EXISTS/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('T776-H7: assertNoPriorOperation rejects when a deployment matches the production baseline', async () => {
  const s = sampleState();
  const deployments = [
    { id: 'dpl_staged_earlier', meta: { vdsenPilotBaseline: DEPLOYMENT } },
  ];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ deployments, pagination: { next: null } }),
  });
  try {
    const io = adapters(s);
    await assert.rejects(
      async () => io.assertNoPriorOperation('op-fresh-unique'),
      /PILOT_BASELINE_ALREADY_STAGED/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('T776-H8: assertNoPriorOperation rejects when deployment pagination is incomplete', async () => {
  const s = sampleState();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ deployments: [], pagination: { next: 12345 } }),
  });
  try {
    const io = adapters(s);
    await assert.rejects(
      async () => io.assertNoPriorOperation('op-fresh-unique'),
      /DEPLOYMENT_LIST_INCOMPLETE/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('T776-H9: Commit-scoped single arm attempt policy simulation', () => {
  const headSha = 'abc1111111111111111111111111111111111111';
  const otherSha = 'def2222222222222222222222222222222222222';
  const currentRunId = '99999999';

  // Case A: Previous run on otherSha; exactly one run on headSha matching currentRunId -> PASS
  const runsCaseA = [
    { id: 11111111, head_sha: otherSha },
    { id: 99999999, head_sha: headSha },
  ];
  const forHeadA = runsCaseA.filter(w => w.head_sha === headSha);
  assert.equal(forHeadA.length, 1);
  assert.equal(String(forHeadA[0].id), currentRunId);

  // Case B: Second attempt on the same headSha -> REJECT (uncertainty requires review/code fix)
  const runsCaseB = [
    { id: 11111111, head_sha: otherSha },
    { id: 88888888, head_sha: headSha }, // prior attempt on same commit
    { id: 99999999, head_sha: headSha }, // current attempt
  ];
  const forHeadB = runsCaseB.filter(w => w.head_sha === headSha);
  assert.notEqual(forHeadB.length, 1, 'multiple attempts on same commit must be rejected');

  // Case C: Run ID mismatch -> REJECT
  const runsCaseC = [
    { id: 12345678, head_sha: headSha },
  ];
  const forHeadC = runsCaseC.filter(w => w.head_sha === headSha);
  assert.notEqual(String(forHeadC[0].id), currentRunId, 'run ID mismatch must be rejected');
});
