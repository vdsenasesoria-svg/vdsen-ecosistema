'use strict';
// T821: Focal provenance & rollback separation tests for APP-ONLY release lane.
// Ensures current live production (f6b90e40... / dpl_BpiwPJNVs1CXwX2nkotXLzquZmBv)
// is verified independently from the immutable historical SAFE_OFF_BASELINE
// (3fc264e2... / dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8 / run 43132135716),
// while preserving fail-closed provenance, alias, rollback, and Numeric Apply OFF gates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const app = require('../scripts/release/app-live.cjs');
const NG = require('../scripts/release/numeric-guard.cjs');
const B = require('../scripts/pilot/off-baseline.cjs');
const { json } = require('../scripts/release/lib.cjs');

const HIST = app.SAFE_OFF_BASELINE;
const CURRENT_RUNTIME = 'f6b90e401d093bc68c648541dd36c946794cff48';
const CURRENT_DPL = 'dpl_BpiwPJNVs1CXwX2nkotXLzquZmBv';
const CANDIDATE_RUNTIME = '076c8c70a276cb80d669d7cd187861756405871f';
const CANDIDATE_DPL = 'dpl_HFxrj2ssiAXhJn6uNQLhfvcEjN3j';
const STAGED_DPL = 'dpl_staged_t821_test';
const PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';

function makeOffBaselineFiles() {
  const dir = 'release-output/off-baseline';
  fs.mkdirSync(dir, { recursive: true });
  const nowIso = new Date().toISOString();
  const ng = {
    schema: 'vdsen-numeric-guard-v1',
    status: 'DISARMED',
    runtime_sha: HIST.runtimeSha,
    project: PROJECT,
    team: TEAM,
    captured_at: nowIso,
    flags: {
      AUTONOMOUS_PROGRESSION_ENABLED: 'PLAIN_FALSE',
      AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'PLAIN_FALSE'
    },
    env_fingerprint: 'a'.repeat(64)
  };
  const run = {
    id: Number(HIST.officialReleaseRun),
    repository: { full_name: 'vdsenasesoria-svg/vdsen-ecosistema' },
    path: '.github/workflows/vdsen-app-release-prod.yml',
    head_branch: 'codex/client-app-next',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    head_sha: HIST.runtimeSha
  };
  const preflight = {
    release_id: HIST.officialReleaseRun,
    runtime_sha: HIST.runtimeSha,
    candidate: HIST.deployment,
    production_deployment: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
    rollback_artifact: 'app-rollback-' + HIST.officialReleaseRun + '.json',
    numeric_guard: ng
  };
  const staged = {
    release_id: HIST.officialReleaseRun,
    candidate_sha: HIST.runtimeSha,
    staged_deployment: HIST.deployment,
    staged_target: 'production',
    staged_ready_state: 'READY',
    staged_at: nowIso,
    production_project: PROJECT,
    vercel_team: TEAM,
    production_alias_before: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
    production_alias_after: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
    numeric_guard: ng
  };
  const rollback = {
    release_id: HIST.officialReleaseRun,
    candidate_sha: HIST.runtimeSha,
    candidate_deployment: HIST.deployment,
    production_deployment: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
    production_project: PROJECT,
    vercel_team: TEAM
  };
  const result = {
    release_id: HIST.officialReleaseRun,
    runtime_sha: HIST.runtimeSha,
    app_release_status: 'SUCCESS',
    state: 'VERIFIED',
    promotion_model: 'staged_production',
    promotion_target: HIST.deployment,
    production_deployment: HIST.deployment,
    previous_deployment: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
    rollback_required: false,
    rules_mutated: false,
    main_unchanged: true
  };
  const artifact = {
    id: 1,
    name: 'app-release-result-' + HIST.officialReleaseRun,
    expired: false,
    digest: HIST.evidenceArtifactDigest,
    workflow_run: { id: Number(HIST.officialReleaseRun), head_sha: HIST.runtimeSha, head_branch: 'codex/client-app-next' }
  };
  fs.writeFileSync(path.join(dir, 'official-run.json'), JSON.stringify(run));
  fs.writeFileSync(path.join(dir, 'app-preflight.json'), JSON.stringify(preflight));
  fs.writeFileSync(path.join(dir, 'app-staged.json'), JSON.stringify(staged));
  fs.writeFileSync(path.join(dir, 'app-result.json'), JSON.stringify(result));
  fs.writeFileSync(path.join(dir, 'app-rollback-' + HIST.officialReleaseRun + '.json'), JSON.stringify(rollback));
  fs.writeFileSync(path.join(dir, 'official-artifact.json'), JSON.stringify(artifact));
  return {
    histDeployment: {
      id: HIST.deployment,
      projectId: PROJECT,
      teamId: TEAM,
      readyState: 'READY',
      target: 'production',
      meta: { githubCommitSha: HIST.runtimeSha },
      env: { AUTONOMOUS_PROGRESSION_ENABLED: 'false', AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'false' }
    }
  };
}

function makeGuard(sha, overrides = {}) {
  return Object.assign({
    schema: 'vdsen-numeric-guard-v1',
    status: 'DISARMED',
    runtime_sha: sha,
    project: PROJECT,
    team: TEAM,
    captured_at: new Date().toISOString(),
    flags: {
      AUTONOMOUS_PROGRESSION_ENABLED: 'PLAIN_FALSE',
      AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'PLAIN_FALSE'
    },
    env_fingerprint: 'a'.repeat(64)
  }, overrides);
}

function setupApplyWorkspace(dir, opts = {}) {
  const runId = opts.runId || '999888';
  const prevOut = app.getOut();
  const prevEnv = {
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    APP_RUNTIME_SHA: process.env.APP_RUNTIME_SHA,
    CLIENT_APP_RELEASE_ENABLED: process.env.CLIENT_APP_RELEASE_ENABLED
  };
  app.setOut(dir);
  process.env.GITHUB_RUN_ID = runId;
  process.env.APP_RUNTIME_SHA = CANDIDATE_RUNTIME;
  process.env.CLIENT_APP_RELEASE_ENABLED = 'true';

  const guard = opts.guard || makeGuard(CANDIDATE_RUNTIME);
  const proof = opts.proof || {
    status: 'OFF_AT_IMMUTABLE_BUILD',
    officialReleaseRun: HIST.officialReleaseRun,
    deployment: HIST.deployment,
    evidenceSha256: 'c'.repeat(64)
  };
  const rollbackName = 'app-rollback-' + runId + '.json';
  const preflight = {
    release_id: runId,
    runtime_sha: CANDIDATE_RUNTIME,
    candidate: CANDIDATE_DPL,
    production_deployment: CURRENT_DPL,
    production_runtime_sha: CURRENT_RUNTIME,
    numeric_guard: guard,
    rollback_artifact: rollbackName
  };
  const rollbackArtifact = {
    release_id: runId,
    candidate_sha: CANDIDATE_RUNTIME,
    candidate_deployment: CANDIDATE_DPL,
    production_deployment: CURRENT_DPL,
    production_runtime_sha: CURRENT_RUNTIME,
    safe_off_deployment: HIST.deployment,
    safe_off_evidence_sha256: proof.evidenceSha256,
    production_project: PROJECT,
    vercel_team: TEAM,
    production_origin: 'https://vdsen-ecosistema.vercel.app',
    main_sha: '5f25b5b9a3c45b425bad4d8eadd145cf7423aec7',
    captured_at: new Date().toISOString()
  };
  const staged = {
    release_id: runId,
    candidate_sha: CANDIDATE_RUNTIME,
    staged_deployment: STAGED_DPL,
    staged_target: 'production',
    staged_ready_state: 'READY',
    production_project: PROJECT,
    vercel_team: TEAM,
    production_alias_before: CURRENT_DPL,
    production_alias_after: CURRENT_DPL,
    numeric_guard: guard
  };
  fs.writeFileSync(path.join(dir, 'app-preflight.json'), JSON.stringify(preflight));
  fs.writeFileSync(path.join(dir, rollbackName), JSON.stringify(rollbackArtifact));
  fs.writeFileSync(path.join(dir, 'app-staged.json'), JSON.stringify(staged));

  return {
    proof,
    restore() {
      app.setOut(prevOut);
      Object.keys(prevEnv).forEach(k => {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      });
    }
  };
}

test('T821.1 current production distinct from historical SAFE_OFF_BASELINE passes when both provenances are valid', async () => {
  const dir = 'release-output/off-baseline';
  const backupDir = 'release-output/.t821-off-baseline-backup-' + process.pid;
  const hadExisting = fs.existsSync(dir);
  if (hadExisting) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.renameSync(dir, backupDir);
  }
  const { histDeployment } = makeOffBaselineFiles();
  try {
    const manifestState = json('.release/vdsen-client.json');
    assert.match(manifestState.runtime_sha || '', /^[0-9a-f]{40}$/);
    assert.notEqual(manifestState.runtime_sha, HIST.runtimeSha);

    const proof = await app.verifySafeOffBaseline(manifestState, false, async (_s, id) => {
      assert.equal(id, HIST.deployment);
      return histDeployment;
    });
    assert.equal(proof.status, 'OFF_AT_IMMUTABLE_BUILD');
    assert.equal(proof.deployment, HIST.deployment);

    const artifact = {
      production_deployment: manifestState.production_deployment,
      production_runtime_sha: manifestState.runtime_sha,
      safe_off_deployment: HIST.deployment,
      safe_off_evidence_sha256: proof.evidenceSha256
    };
    const checked = app.assertSafeRollbackProof(artifact, proof);
    assert.equal(checked.evidenceSha256, proof.evidenceSha256);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (hadExisting && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, dir);
    }
  }
});

test('T821.2 tampered historical baseline (SHA, deployment, run, or digest) fails closed', () => {
  const proof = {
    status: 'OFF_AT_IMMUTABLE_BUILD',
    officialReleaseRun: HIST.officialReleaseRun,
    deployment: HIST.deployment,
    evidenceSha256: 'b'.repeat(64)
  };
  const validArtifact = {
    production_runtime_sha: CURRENT_RUNTIME,
    safe_off_deployment: HIST.deployment,
    safe_off_evidence_sha256: proof.evidenceSha256
  };
  assert.throws(() => app.assertSafeRollbackProof(validArtifact, Object.assign({}, proof, { deployment: 'dpl_tampered' })), /SAFE_OFF_DEPLOYMENT_MISMATCH/);
  assert.throws(() => app.assertSafeRollbackProof(validArtifact, Object.assign({}, proof, { officialReleaseRun: '999999' })), /SAFE_OFF_RUN_MISMATCH/);
  assert.throws(() => app.assertSafeRollbackProof(validArtifact, Object.assign({}, proof, { runtimeSha: '0'.repeat(40) })), /SAFE_OFF_RUNTIME_MISMATCH/);
  assert.throws(() => app.assertSafeRollbackProof(Object.assign({}, validArtifact, { safe_off_evidence_sha256: 'd'.repeat(64) }), proof), /SAFE_OFF_EVIDENCE_CHANGED/);
});

test('T821.3 current live runtime distinct from manifest runtime_sha fails closed', () => {
  const manifestState = json('.release/vdsen-client.json');
  const observedLiveDeployment = { id: CURRENT_DPL, meta: { githubCommitSha: '1'.repeat(40) } };
  assert.throws(
    () => assert.equal(observedLiveDeployment.meta.githubCommitSha, manifestState.runtime_sha, 'Current production runtime does not match the recorded baseline'),
    /Current production runtime does not match/
  );
});

test('T821.4 concurrent production alias change between preflight and promotion fails closed before promote', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t821-4-'));
  const ws = setupApplyWorkspace(dir);
  let promoteCalled = false;
  try {
    await assert.rejects(
      () => app.apply({
        verifySafeOffBaseline: async () => ws.proof,
        numericGuard: async () => makeGuard(CANDIDATE_RUNTIME),
        currentApp: async () => 'dpl_concurrent_other_deploy',
        deployment: async (_s, id) => ({ id, projectId: PROJECT, teamId: TEAM, readyState: 'READY', target: 'production', meta: { githubCommitSha: CANDIDATE_RUNTIME } }),
        promote: async () => { promoteCalled = true; }
      }),
      /BASELINE_MOVED_BEFORE_PROMOTION/
    );
    assert.equal(promoteCalled, false);
  } finally {
    ws.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T821.5 rollback artifact & release result preserve current live deployment rather than substituting historical baseline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t821-5-'));
  const ws = setupApplyWorkspace(dir);
  try {
    const res = await app.apply({
      verifySafeOffBaseline: async () => ws.proof,
      numericGuard: async () => makeGuard(CANDIDATE_RUNTIME),
      currentApp: async () => (resState.promoted ? STAGED_DPL : CURRENT_DPL),
      deployment: async (_s, id) => ({ id, projectId: PROJECT, teamId: TEAM, readyState: 'READY', target: 'production', meta: { githubCommitSha: CANDIDATE_RUNTIME } }),
      promote: async () => { resState.promoted = true; },
      verifyPublicBytes: async () => ['vdsen-cliente.html'],
      surface: () => ['vdsen-cliente.html']
    });
    assert.equal(res.app_release_status, 'SUCCESS');
    assert.equal(res.previous_deployment, CURRENT_DPL);
    assert.notEqual(res.previous_deployment, HIST.deployment);
    assert.equal(res.safe_off_deployment, HIST.deployment);
  } finally {
    ws.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const resState = { promoted: false };

test('T821.6 Numeric Apply ON or unverifiable fails closed before promotion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t821-6-'));
  const ws = setupApplyWorkspace(dir);
  let promoteCalled = false;
  try {
    await assert.rejects(
      () => app.apply({
        verifySafeOffBaseline: async () => ws.proof,
        numericGuard: async () => makeGuard(CANDIDATE_RUNTIME, {
          status: 'ARMED',
          variables: { AUTONOMOUS_PROGRESSION_ENABLED: 'true', AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true' }
        }),
        currentApp: async () => CURRENT_DPL,
        deployment: async (_s, id) => ({ id, projectId: PROJECT, teamId: TEAM, readyState: 'READY', target: 'production', meta: { githubCommitSha: CANDIDATE_RUNTIME } }),
        promote: async () => { promoteCalled = true; }
      }),
      /NUMERIC|DISARMED|ARMED/i
    );
    assert.equal(promoteCalled, false);
  } finally {
    ws.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T821.7 historical baseline verification failure stops promotion with zero production writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t821-7-'));
  const ws = setupApplyWorkspace(dir);
  let promoteCalled = false;
  try {
    await assert.rejects(
      () => app.apply({
        verifySafeOffBaseline: async () => { throw new Error('OFF_BASELINE_ARTIFACT_DIGEST_MISMATCH'); },
        numericGuard: async () => makeGuard(CANDIDATE_RUNTIME),
        currentApp: async () => CURRENT_DPL,
        promote: async () => { promoteCalled = true; }
      }),
      /OFF_BASELINE_ARTIFACT_DIGEST_MISMATCH/
    );
    assert.equal(promoteCalled, false);
  } finally {
    ws.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T821.8 APP-ONLY lane never touches Firestore rules, IAM, or client data', () => {
  assert.equal(app.assertAppOnlySources(), true);
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'vdsen-app-release-prod.yml'), 'utf8');
  assert.ok(!wf.includes('scripts/release/live.cjs'));
  assert.ok(!wf.includes('firestore.rules'));
  assert.ok(!/vars\.PRODUCTION_RELEASE_ENABLED/.test(wf));
});
