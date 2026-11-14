'use strict';
// T773 — Post-Release OFF Safe Rebaseline & Contract Separation Tests.
//
// Proves:
// 1. Coherence of the new canonical manifest (.release/vdsen-client.json) and frozen deployed-product.json.
// 2. Real identity of official release run 43132135716, its deployment dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8,
//    runtime 3fc264e23d67a8ecb1611a6c8af04ad739f422da, and digest sha256:c2a20d42b7b4ea439375641345e3eea9fefb61a42b6cc32b89eea0758a53ec1a.
// 3. Valid OFF evidence verification via scripts/pilot/off-baseline.cjs for run 43132135716.
// 4. Pinned safe recovery deployment (dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H) matching previous deployment.
// 5. Prohibition of automatic rollback to the legacy armed deployment (dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K).
// 6. Rejection of inconsistent artifacts and malformed separation records.
// 7. Idempotency of baseline recovery and compatibility with existing release contracts (check.cjs, lib.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { json, validate } = require('../scripts/release/lib.cjs');
const { assertAppReleaseCoherence, assertPublishedRulesCoherence } = require('../scripts/release/check.cjs');
const deployedProduct = require('../scripts/release/deployed-product.cjs');
const app = require('../scripts/release/app-live.cjs');
const NG = require('../scripts/release/numeric-guard.cjs');
const B = require('../scripts/pilot/off-baseline.cjs');
const P = require('../scripts/pilot/window-protocol.cjs');

const { execFileSync } = require('node:child_process');
const T773_COMMIT = '48f7d21995a048187ef8b4a8e0c06c034d432cb9';
const SCHEMA = json('.release/schema/release-state.schema.json');
const STATE = JSON.parse(execFileSync('git', ['show', T773_COMMIT + ':.release/vdsen-client.json'], { encoding: 'utf8' }));
const MANIFEST = JSON.parse(execFileSync('git', ['show', T773_COMMIT + ':.release/deployed-product.json'], { encoding: 'utf8' }));

const CANONICAL_SHA = '3fc264e23d67a8ecb1611a6c8af04ad739f422da';
const PROD_DEPLOYMENT = 'dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8';
const PREVIOUS_REAL_DEPLOYMENT = 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H';
const PREVIOUS_RUNTIME_SHA = 'ec3b30f99d095c90fc8e1d54cf05366a0427205a';
const SAFE_OFF_RECOVERY_DEPLOYMENT = 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H';
const OFFICIAL_RUN = '43132135716';
const OFFICIAL_DIGEST = 'sha256:c2a20d42b7b4ea439375641345e3eea9fefb61a42b6cc32b89eea0758a53ec1a';

const clone = (x) => JSON.parse(JSON.stringify(x));

test('T773-1 canonical manifest and deployed-product.json reflect the verified T773 OFF release', () => {
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
  assert.equal(STATE.app_release.verified_surfaces, 46);
  assert.equal(STATE.app_release.source_release_run, OFFICIAL_RUN);
  assert.equal(STATE.app_release.completed_at, '2026-11-12T01:16:37Z');

  assert.equal(MANIFEST.runtime_sha, CANONICAL_SHA);
  assert.equal(Object.keys(MANIFEST.files).length, 47);
  deployedProduct.verify(json('.release/vdsen-client.json').runtime_sha, deployedProduct.MANIFEST);
});

test('T773-2 explicit safe recovery deployment and distinct-SHA rollback target', () => {
  assert.equal(STATE.app_release.previous_deployment, PREVIOUS_REAL_DEPLOYMENT);
  assert.equal(STATE.app_release.previous_runtime_sha, PREVIOUS_RUNTIME_SHA);

  assert.equal(STATE.rollback_deployment, SAFE_OFF_RECOVERY_DEPLOYMENT);
  assert.equal(STATE.rollback_runtime_sha, PREVIOUS_RUNTIME_SHA);
  assert.equal(STATE.app_release.safe_recovery_deployment, SAFE_OFF_RECOVERY_DEPLOYMENT);
  assert.equal(STATE.app_release.safe_recovery_runtime_sha, PREVIOUS_RUNTIME_SHA);

  assert.notEqual(STATE.rollback_deployment, PROD_DEPLOYMENT);
  assert.notEqual(STATE.rollback_runtime_sha, CANONICAL_SHA);
  assert.notEqual(STATE.rollback_deployment, P.LEGACY_ARMED_DEPLOYMENT);
  assert.notEqual(STATE.app_release.safe_recovery_deployment, P.LEGACY_ARMED_DEPLOYMENT);
});

test('T773-3 reject corrupted or forged safe recovery metadata', () => {
  const forged = clone(STATE);
  forged.rollback_deployment = P.LEGACY_ARMED_DEPLOYMENT;
  forged.app_release.safe_recovery_deployment = P.LEGACY_ARMED_DEPLOYMENT;
  assert.throws(() => assertAppReleaseCoherence(forged), /must never point to the retired legacy armed deployment/);

  const missingSafe = clone(STATE);
  delete missingSafe.app_release.safe_recovery_deployment;
  assert.throws(() => assertAppReleaseCoherence(missingSafe), /required when separating/);

  const mismatchDeployment = clone(STATE);
  mismatchDeployment.rollback_deployment = 'dpl_some_other_deployment';
  assert.throws(() => assertAppReleaseCoherence(mismatchDeployment), /must equal rollback_deployment/);

  const mismatchRuntime = clone(STATE);
  mismatchRuntime.rollback_runtime_sha = 'a'.repeat(40);
  assert.throws(() => assertAppReleaseCoherence(mismatchRuntime), /must equal rollback_runtime_sha/);
});

test('T773-4 SAFE_OFF_BASELINE pins the new accredited OFF release and off-baseline verifier accepts run 43132135716', () => {
  assert.equal(app.SAFE_OFF_BASELINE.runtimeSha, CANONICAL_SHA);
  assert.equal(app.SAFE_OFF_BASELINE.deployment, PROD_DEPLOYMENT);
  assert.equal(app.SAFE_OFF_BASELINE.officialReleaseRun, OFFICIAL_RUN);
  assert.equal(app.SAFE_OFF_BASELINE.evidenceArtifactDigest, OFFICIAL_DIGEST);

  const before = NG.evaluateProductionEnv(
    [
      { id: 'urptQzR1JvlvhDAj', key: 'AUTONOMOUS_PROGRESSION_ENABLED', type: 'plain', target: ['production'], value: 'false', updatedAt: 1793494508147 },
      { id: 'cMTcWVYzKp4IvrS5', key: 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', type: 'plain', target: ['production'], value: 'false', updatedAt: 1793494240690 },
    ],
    { project: STATE.production_project, team: STATE.vercel_team, runtimeSha: CANONICAL_SHA, now: Date.parse('2026-11-12T01:15:29.820Z') }
  );
  const after = Object.assign({}, before, {
    captured_at: '2026-11-12T01:16:26.764Z',
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
  };

  const makeBundle = (over = {}) => ({
    run: {
      id: Number(OFFICIAL_RUN),
      repository: { full_name: 'vdsenasesoria-svg/vdsen-ecosistema' },
      path: '.github/workflows/vdsen-app-release-prod.yml',
      head_branch: 'codex/client-app-next',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      run_attempt: 1,
      head_sha: CANONICAL_SHA,
    },
    preflight: {
      runtime_sha: CANONICAL_SHA,
      rollback_artifact: 'app-rollback-' + OFFICIAL_RUN + '.json',
      candidate: 'dpl_7p8Bkk76huZNhcCt3aj8RRsJdsFB',
      production_deployment: PREVIOUS_REAL_DEPLOYMENT,
      numeric_guard: before,
    },
    staged: {
      staged_deployment: PROD_DEPLOYMENT,
      candidate_sha: CANONICAL_SHA,
      production_project: STATE.production_project,
      vercel_team: STATE.vercel_team,
      staged_target: 'production',
      staged_ready_state: 'READY',
      production_alias_before: PREVIOUS_REAL_DEPLOYMENT,
      production_alias_after: PREVIOUS_REAL_DEPLOYMENT,
      numeric_guard: after,
      staged_at: '2026-11-12T01:16:27.168Z',
    },
    result: {
      release_id: OFFICIAL_RUN,
      runtime_sha: CANONICAL_SHA,
      app_release_status: 'SUCCESS',
      state: 'VERIFIED',
      promotion_model: 'staged_production',
      promotion_target: PROD_DEPLOYMENT,
      production_deployment: PROD_DEPLOYMENT,
      previous_deployment: PREVIOUS_REAL_DEPLOYMENT,
      rollback_required: false,
      rules_mutated: false,
      main_unchanged: true,
    },
    rollback: {
      release_id: OFFICIAL_RUN,
      candidate_sha: CANONICAL_SHA,
      candidate_deployment: 'dpl_7p8Bkk76huZNhcCt3aj8RRsJdsFB',
      production_deployment: PREVIOUS_REAL_DEPLOYMENT,
      production_runtime_sha: PREVIOUS_RUNTIME_SHA,
      safe_off_deployment: PREVIOUS_REAL_DEPLOYMENT,
      safe_off_evidence_sha256: 'f'.repeat(64),
      production_project: STATE.production_project,
      vercel_team: STATE.vercel_team,
      production_origin: 'https://vdsen-ecosistema.vercel.app',
      main_sha: 'f6596ba5207dc158b8a9b01483cd0fe0ebeb274c',
      live_rules_observation: 'NOT_CAPTURED_NO_GOOGLE_TOKEN',
      captured_at: '2026-11-12T01:15:32.765Z',
    },
    artifact: {
      id: 13905149821,
      name: 'app-release-result-43132135716',
      digest: OFFICIAL_DIGEST,
      expired: false,
      workflow_run: {
        id: 43132135716,
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

  const badPrevious = makeBundle();
  badPrevious.result = Object.assign({}, badPrevious.result, { previous_deployment: 'dpl_wrong_previous' });
  assert.throws(() => B.verify(STATE, app.SAFE_OFF_BASELINE, deploymentObj, badPrevious), /OFF_BASELINE_PREVIOUS_MISMATCH/);

  const badDigest = makeBundle({
    artifact: Object.assign({}, makeBundle().artifact, { digest: 'sha256:' + '0'.repeat(64) }),
  });
  assert.throws(() => B.verify(STATE, app.SAFE_OFF_BASELINE, deploymentObj, badDigest), /OFF_BASELINE_ARTIFACT_DIGEST_MISMATCH/);
});

test('T773-5 app rollback targets the new SAFE_OFF_BASELINE and never reverts to the legacy armed deployment', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't773-rollback-'));
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
      main_sha: 'f6596ba5207dc158b8a9b01483cd0fe0ebeb274c',
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
