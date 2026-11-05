'use strict';
// T698 — Post-Release OFF Safe Rebaseline & Contract Separation Tests.
//
// Proves:
// 1. Coherence of the new canonical manifest (.release/vdsen-client.json) and frozen deployed-product.json.
// 2. Real identity of official release run 41950979614, its deployment dpl_AuykDuRaXejkbUzFNjFz6XocNPZt,
//    runtime 353df8c12982cad7f4dc89b3622a6b63b3127b52, and digest sha256:0a2e116db5faabc5daaa0c8c0c0d8199a4c899501df910de8f662a8f26b5a96f.
// 3. Valid OFF evidence verification via scripts/pilot/off-baseline.cjs for run 41950979614.
// 4. Pinned safe recovery deployment (dpl_5gQbFsFXdJoyCdJy7WVgiKLb1pPP) matching previous deployment.
// 5. Prohibition of automatic rollback to the legacy armed deployment (dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K).
// 6. Rejection of inconsistent artifacts and malformed separation records.
// 7. Idempotency of baseline recovery and compatibility with existing release contracts (check.cjs, lib.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { json, validate, verifyDeployment } = require('../scripts/release/lib.cjs');
const { assertAppReleaseCoherence, assertPublishedRulesCoherence } = require('../scripts/release/check.cjs');
const deployedProduct = require('../scripts/release/deployed-product.cjs');
const app = require('../scripts/release/app-live.cjs');
const NG = require('../scripts/release/numeric-guard.cjs');
const B = require('../scripts/pilot/off-baseline.cjs');
const P = require('../scripts/pilot/window-protocol.cjs');

const SCHEMA = json('.release/schema/release-state.schema.json');
const STATE = json('.release/vdsen-client.json');
const MANIFEST = json(deployedProduct.MANIFEST);

const CANONICAL_SHA = '353df8c12982cad7f4dc89b3622a6b63b3127b52';
const PROD_DEPLOYMENT = 'dpl_AuykDuRaXejkbUzFNjFz6XocNPZt';
const PREVIOUS_REAL_DEPLOYMENT = 'dpl_5gQbFsFXdJoyCdJy7WVgiKLb1pPP';
const PREVIOUS_RUNTIME_SHA = 'c3c1875425fe53981df512bdaa0dbe18d81de34d';
const SAFE_OFF_RECOVERY_DEPLOYMENT = 'dpl_5gQbFsFXdJoyCdJy7WVgiKLb1pPP';
const OFFICIAL_RUN = '41950979614';
const OFFICIAL_DIGEST = 'sha256:0a2e116db5faabc5daaa0c8c0c0d8199a4c899501df910de8f662a8f26b5a96f';

const clone = (x) => JSON.parse(JSON.stringify(x));

test('T698-1 canonical manifest and deployed-product.json reflect the verified T697 OFF release', () => {
  validate(STATE, SCHEMA);
  assertAppReleaseCoherence(STATE);
  assertPublishedRulesCoherence(STATE);

  assert.equal(STATE.runtime_sha, CANONICAL_SHA);
  assert.equal(STATE.production_deployment, PROD_DEPLOYMENT);
  assert.equal(STATE.target_deployment, PROD_DEPLOYMENT);
  assert.equal(STATE.numeric_apply_enabled, false);
  assert.equal(STATE.release_mode, 'app_only');

  assert.equal(STATE.app_release.runtime_sha, CANONICAL_SHA);
  assert.equal(STATE.app_release.deployment, PROD_DEPLOYMENT);
  assert.equal(STATE.app_release.promotion_model, 'staged_production');
  assert.equal(STATE.app_release.verified_surfaces, 25);
  assert.equal(STATE.app_release.source_release_run, OFFICIAL_RUN);
  assert.equal(STATE.app_release.completed_at, '2026-11-05T01:51:27Z');

  assert.equal(MANIFEST.runtime_sha, CANONICAL_SHA);
  assert.equal(Object.keys(MANIFEST.files).length, 47);
  deployedProduct.verify(CANONICAL_SHA, deployedProduct.MANIFEST);
});

test('T698-2 explicit safe recovery deployment and distinct-SHA rollback target', () => {
  // Real previous deployment that served immediately before T697
  assert.equal(STATE.app_release.previous_deployment, PREVIOUS_REAL_DEPLOYMENT);
  assert.equal(STATE.app_release.previous_runtime_sha, PREVIOUS_RUNTIME_SHA);

  // Accredited safe OFF recovery deployment for distinct-SHA rollback
  assert.equal(STATE.rollback_deployment, SAFE_OFF_RECOVERY_DEPLOYMENT);
  assert.equal(STATE.rollback_runtime_sha, PREVIOUS_RUNTIME_SHA);
  assert.equal(STATE.app_release.safe_recovery_deployment, SAFE_OFF_RECOVERY_DEPLOYMENT);
  assert.equal(STATE.app_release.safe_recovery_runtime_sha, PREVIOUS_RUNTIME_SHA);

  assert.equal(STATE.app_release.previous_deployment, STATE.rollback_deployment);
  assert.notEqual(STATE.rollback_deployment, P.LEGACY_ARMED_DEPLOYMENT);
  assert.notEqual(STATE.app_release.safe_recovery_deployment, P.LEGACY_ARMED_DEPLOYMENT);

  // Rules lane CLI identity verification accepts the new production deployment and the safe OFF rollback deployment,
  // while rejecting the legacy armed deployment as a rollback target.
  const cli = (id, sha) => ({ id, projectId: STATE.production_project, readyState: 'READY', source: 'cli', meta: { githubCommitSha: sha } });
  assert.equal(verifyDeployment(cli(PROD_DEPLOYMENT, CANONICAL_SHA), STATE, CANONICAL_SHA, 'codex/client-app-next').id, PROD_DEPLOYMENT);
  assert.equal(verifyDeployment(cli(SAFE_OFF_RECOVERY_DEPLOYMENT, PREVIOUS_RUNTIME_SHA), STATE, PREVIOUS_RUNTIME_SHA).id, SAFE_OFF_RECOVERY_DEPLOYMENT);
  assert.throws(
    () => verifyDeployment(cli(P.LEGACY_ARMED_DEPLOYMENT, PREVIOUS_RUNTIME_SHA), STATE, PREVIOUS_RUNTIME_SHA),
    /Deployment without Git metadata must be exactly the reviewed deployment/
  );
});

test('T698-3 contract rejects legacy armed deployment as rollback target and rejects inconsistent separation fields', () => {
  // 1. Legacy armed deployment in rollback_deployment is forbidden
  const badLegacyRollback = clone(STATE);
  badLegacyRollback.rollback_deployment = P.LEGACY_ARMED_DEPLOYMENT;
  badLegacyRollback.app_release.safe_recovery_deployment = P.LEGACY_ARMED_DEPLOYMENT;
  assert.throws(() => assertAppReleaseCoherence(badLegacyRollback), /retired legacy armed deployment/);

  // 2. Mismatch between safe_recovery_deployment and rollback_deployment is rejected
  const mismatchRecovery = clone(STATE);
  mismatchRecovery.app_release.safe_recovery_deployment = 'dpl_OtherDeployment12345';
  assert.throws(() => assertAppReleaseCoherence(mismatchRecovery), /app_release\.safe_recovery_deployment must equal rollback_deployment/);

  // 3. Mismatch between safe_recovery_runtime_sha and rollback_runtime_sha is rejected
  const mismatchSha = clone(STATE);
  mismatchSha.app_release.safe_recovery_runtime_sha = 'a'.repeat(40);
  assert.throws(() => assertAppReleaseCoherence(mismatchSha), /app_release\.safe_recovery_runtime_sha must equal rollback_runtime_sha/);

  // 4. Partial safe_recovery block (missing runtime_sha) is rejected
  const partialRecovery = clone(STATE);
  delete partialRecovery.app_release.safe_recovery_runtime_sha;
  assert.throws(() => assertAppReleaseCoherence(partialRecovery), /app_release\.safe_recovery_runtime_sha must be a 40-char commit SHA/);
});

test('T698-4 SAFE_OFF_BASELINE pins the new accredited OFF release and off-baseline verifier accepts run 41950979614', () => {
  assert.equal(app.SAFE_OFF_BASELINE.runtimeSha, CANONICAL_SHA);
  assert.equal(app.SAFE_OFF_BASELINE.deployment, PROD_DEPLOYMENT);
  assert.equal(app.SAFE_OFF_BASELINE.officialReleaseRun, OFFICIAL_RUN);
  assert.equal(app.SAFE_OFF_BASELINE.evidenceArtifactDigest, OFFICIAL_DIGEST);

  const before = NG.evaluateProductionEnv(
    [
      { id: 'urptQzR1JvlvhDAj', key: 'AUTONOMOUS_PROGRESSION_ENABLED', type: 'plain', target: ['production'], value: 'false', updatedAt: 1793494508147 },
      { id: 'cMTcWVYzKp4IvrS5', key: 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', type: 'plain', target: ['production'], value: 'false', updatedAt: 1793494240690 },
    ],
    { project: STATE.production_project, team: STATE.vercel_team, runtimeSha: CANONICAL_SHA, now: Date.parse('2026-11-05T01:50:00.000Z') }
  );
  const after = Object.assign({}, before, {
    captured_at: '2026-11-05T01:51:00.000Z',
    deployment_env: {
      names_reported: true,
      progression_names: ['AUTONOMOUS_PROGRESSION_ENABLED', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED'],
    },
  });

  const deploymentObj = {
    id: PROD_DEPLOYMENT,
    projectId: STATE.production_project,
    teamId: STATE.vercel_team,
    readyState: 'READY',
    target: 'production',
    meta: { githubCommitSha: CANONICAL_SHA },
    env: ['AUTONOMOUS_PROGRESSION_ENABLED', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED'],
  };

  const makeBundle = (over = {}) => ({
    run: {
      id: 41950979614,
      repository: { full_name: 'vdsenasesoria-svg/vdsen-ecosistema' },
      path: '.github/workflows/vdsen-app-release-prod.yml',
      head_branch: 'codex/client-app-next',
      head_sha: CANONICAL_SHA,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      run_attempt: 1,
    },
    preflight: {
      release_id: OFFICIAL_RUN,
      runtime_sha: CANONICAL_SHA,
      candidate: PROD_DEPLOYMENT,
      production_deployment: PREVIOUS_REAL_DEPLOYMENT,
      production_runtime_sha: PREVIOUS_RUNTIME_SHA,
      main_sha: '353df8c12982cad7f4dc89b3622a6b63b3127b52',
      env: { present: 5, missing: [] },
      firebase_project: 'MATCH',
      numeric_guard: before,
      rollback_artifact: 'app-rollback-41950979614.json',
      app_only: 'NO_FIRESTORE_MUTATION_PATH',
    },
    staged: {
      release_id: OFFICIAL_RUN,
      staged_deployment: PROD_DEPLOYMENT,
      staged_url: 'https://vdsen-ecosistema-oof9gsiog-vdsenasesoria-svgs-projects.vercel.app',
      staged_target: 'production',
      staged_ready_state: 'READY',
      candidate_sha: CANONICAL_SHA,
      production_project: STATE.production_project,
      vercel_team: STATE.vercel_team,
      verified_paths: 26,
      production_alias_before: PREVIOUS_REAL_DEPLOYMENT,
      production_alias_after: PREVIOUS_REAL_DEPLOYMENT,
      exported_tree: '/tmp/vdsen-staged-353df8c12982',
      cli_version: '59.11.7',
      staged_at: '2026-11-05T01:51:00.000Z',
      numeric_guard: after,
    },
    result: {
      release_id: OFFICIAL_RUN,
      runtime_sha: CANONICAL_SHA,
      app_release_status: 'SUCCESS',
      production_deployment: PROD_DEPLOYMENT,
      previous_deployment: PREVIOUS_REAL_DEPLOYMENT,
      promotion_target: PROD_DEPLOYMENT,
      promotion_model: 'staged_production',
      candidate_deployment: PROD_DEPLOYMENT,
      staged_deployment: PROD_DEPLOYMENT,
      safe_off_deployment: SAFE_OFF_RECOVERY_DEPLOYMENT,
      rules_mutated: false,
      main_unchanged: true,
      error: null,
      rollback_required: false,
      verified_surfaces: 25,
      state: 'VERIFIED',
    },
    rollback: {
      release_id: OFFICIAL_RUN,
      release_reason: 'T697 authorized production app release OFF',
      candidate_sha: CANONICAL_SHA,
      candidate_deployment: PROD_DEPLOYMENT,
      production_deployment: PREVIOUS_REAL_DEPLOYMENT,
      production_runtime_sha: PREVIOUS_RUNTIME_SHA,
      safe_off_deployment: SAFE_OFF_RECOVERY_DEPLOYMENT,
      safe_off_evidence_sha256: '7d5c78b8a0c12f388ff128383567d617d61f606fb902f3147242ed63ff603d33',
      production_project: STATE.production_project,
      vercel_team: STATE.vercel_team,
      production_origin: 'https://vdsen-ecosistema.vercel.app',
      main_sha: '353df8c12982cad7f4dc89b3622a6b63b3127b52',
      live_rules_observation: 'NOT_CAPTURED_NO_GOOGLE_TOKEN',
      captured_at: '2026-11-05T01:50:30.000Z',
    },
    artifact: {
      id: 13380543643,
      name: 'app-release-result-41950979614',
      digest: OFFICIAL_DIGEST,
      expired: false,
      workflow_run: {
        id: 41950979614,
        head_sha: CANONICAL_SHA,
        head_branch: 'codex/client-app-next',
      },
    },
    ...over,
  });

  const verified = B.verify(STATE, app.SAFE_OFF_BASELINE, deploymentObj, makeBundle());
  assert.equal(verified.status, 'OFF_AT_IMMUTABLE_BUILD');
  assert.equal(verified.officialReleaseRun, OFFICIAL_RUN);
  assert.equal(verified.deployment, PROD_DEPLOYMENT);
  assert.equal(verified.artifactDigest, OFFICIAL_DIGEST);

  // Reject inconsistent artifacts (e.g. wrong previous_deployment in result vs rollback, or wrong digest)
  const badPrevious = makeBundle();
  badPrevious.result = Object.assign({}, badPrevious.result, { previous_deployment: 'dpl_wrong_previous' });
  assert.throws(() => B.verify(STATE, app.SAFE_OFF_BASELINE, deploymentObj, badPrevious), /OFF_BASELINE_PREVIOUS_MISMATCH/);

  const badDigest = makeBundle({
    artifact: Object.assign({}, makeBundle().artifact, { digest: 'sha256:' + '0'.repeat(64) }),
  });
  assert.throws(() => B.verify(STATE, app.SAFE_OFF_BASELINE, deploymentObj, badDigest), /OFF_BASELINE_ARTIFACT_DIGEST_MISMATCH/);
});

test('T698-5 app rollback targets the new SAFE_OFF_BASELINE and never reverts to the legacy armed deployment', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't698-rollback-'));
  const prevOut = app.getOut();
  const rid = process.env.GITHUB_RUN_ID || 'local';
  const rbName = 'app-rollback-' + rid + '.json';
  app.setOut(tmp);
  try {
    const mockProof = {
      status: 'OFF_AT_IMMUTABLE_BUILD',
      officialReleaseRun: app.SAFE_OFF_BASELINE.officialReleaseRun,
      deployment: app.SAFE_OFF_BASELINE.deployment,
      evidenceSha256: 'f'.repeat(64),
    };
    fs.writeFileSync(path.join(tmp, 'app-result.json'), JSON.stringify({
      release_id: rid,
      rollback_required: true,
      mutation_status: 'MUTATED',
    }));
    fs.writeFileSync(path.join(tmp, rbName), JSON.stringify({
      release_id: rid,
      candidate_sha: 'd'.repeat(40),
      candidate_deployment: 'dpl_future_cand',
      production_deployment: PROD_DEPLOYMENT,
      production_runtime_sha: CANONICAL_SHA,
      safe_off_deployment: app.SAFE_OFF_BASELINE.deployment,
      safe_off_evidence_sha256: 'f'.repeat(64),
      production_project: STATE.production_project,
      vercel_team: STATE.vercel_team,
      production_origin: STATE.production_origin,
      main_sha: '353df8c12982cad7f4dc89b3622a6b63b3127b52',
      captured_at: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(tmp, 'app-staged.json'), JSON.stringify({
      release_id: rid,
      staged_deployment: 'dpl_future_staged',
      candidate_sha: 'd'.repeat(40),
      production_project: STATE.production_project,
      vercel_team: STATE.vercel_team,
      production_alias_before: PROD_DEPLOYMENT,
      numeric_guard: { status: 'DISARMED' },
    }));

    let revertedTarget = null;
    const out = await app.rollbackApp({
      verifySafeOffBaseline: async () => mockProof,
      currentApp: async () => (revertedTarget ? revertedTarget : 'dpl_future_staged'),
      revertApp: async (s, target) => { revertedTarget = target; return target; },
      deployment: async (s, id) => ({
        id, readyState: 'READY', target: 'production', meta: { githubCommitSha: CANONICAL_SHA },
      }),
      servedSurface: () => ['vdsen-cliente.html'],
      verifyPublicBytes: async (s, sha, surface) => {
        assert.equal(sha, CANONICAL_SHA);
        return surface;
      },
    });

    assert.equal(out.rollback_status, 'PASS');
    assert.equal(out.state, 'RECOVERED');
    assert.equal(revertedTarget, PROD_DEPLOYMENT);
    assert.notEqual(revertedTarget, P.LEGACY_ARMED_DEPLOYMENT);

    // Idempotency when already at PROD_DEPLOYMENT
    let secondRevertCalled = false;
    const idem = await app.rollbackApp({
      verifySafeOffBaseline: async () => mockProof,
      currentApp: async () => PROD_DEPLOYMENT,
      revertApp: async () => { secondRevertCalled = true; },
    });
    assert.equal(idem.rollback_status, 'NOT_NEEDED');
    assert.equal(idem.state, 'NO_MUTATION');
    assert.equal(idem.current_deployment, PROD_DEPLOYMENT);
    assert.equal(secondRevertCalled, false);
  } finally {
    app.setOut(prevOut);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
