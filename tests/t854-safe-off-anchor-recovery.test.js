'use strict';
// T854 — Safe OFF Anchor Recovery & Provenance Verification Tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { json, validate } = require('../scripts/release/lib.cjs');
const { assertAppReleaseCoherence, assertPublishedRulesCoherence } = require('../scripts/release/check.cjs');
const app = require('../scripts/release/app-live.cjs');
const NG = require('../scripts/release/numeric-guard.cjs');
const B = require('../scripts/pilot/off-baseline.cjs');

const STATE = json('.release/vdsen-client.json');
const SCHEMA = json('.release/schema/release-state.schema.json');

const NEW_RUN = '44662166798';
const NEW_DEPLOYMENT = 'dpl_4H91D85NYxvq4FSaJRvtdzRH3bcT';
const NEW_SHA = 'af2629a8e6f9f4473bd583005d5ed2a5f2be9d5f';
const OFFICIAL_ZIP_DIGEST = 'sha256:05e67f626c98e128963d55485dff86d11279072a8215ca2cdb3702b87c404b82';
const WRONG_DOC_DIGEST = 'sha256:83606e4bec06a849f2ba8163ec1f333b06251e94e6c8bf8ce00c76d762b04917';
const PREV_DEPLOYMENT = 'dpl_8CQkSnR5hn6WsWPhnscdLQbq3DHS';
const PREV_SHA = 'd424482f6170a264f90a1c421442e9fa56df975d';

function makeValidBundle(over = {}) {
  const before = NG.evaluateProductionEnv(
    [
      { id: 'urptQzR1JvlvhDAj', key: 'AUTONOMOUS_PROGRESSION_ENABLED', type: 'plain', target: ['production'], value: 'false', updatedAt: 1793494508147 },
      { id: 'cMTcWVYzKp4IvrS5', key: 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', type: 'plain', target: ['production'], value: 'false', updatedAt: 1793494240690 },
    ],
    { project: STATE.production_project, team: STATE.vercel_team, runtimeSha: NEW_SHA, now: Date.parse('2026-11-20T02:46:57.000Z') }
  );
  const after = Object.assign({}, before, {
    captured_at: '2026-11-20T02:47:45.000Z',
    deployment_env: {
      names_reported: true,
      progression_names: ['AUTONOMOUS_PROGRESSION_ENABLED', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED'],
    },
  });
  return {
    run: {
      id: Number(NEW_RUN),
      repository: { full_name: 'vdsenasesoria-svg/vdsen-ecosistema' },
      path: '.github/workflows/vdsen-app-release-prod.yml',
      head_branch: 'codex/client-app-next',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      run_attempt: 1,
      head_sha: NEW_SHA,
    },
    artifact: {
      name: 'app-release-result-' + NEW_RUN,
      expired: false,
      digest: OFFICIAL_ZIP_DIGEST,
      workflow_run: { id: Number(NEW_RUN), head_sha: NEW_SHA, head_branch: 'codex/client-app-next' },
    },
    preflight: {
      runtime_sha: NEW_SHA,
      candidate: 'dpl_cand_44662166798',
      production_deployment: PREV_DEPLOYMENT,
      rollback_artifact: 'app-rollback-' + NEW_RUN + '.json',
      numeric_guard: before,
    },
    staged: {
      staged_deployment: NEW_DEPLOYMENT,
      candidate_sha: NEW_SHA,
      production_project: STATE.production_project,
      vercel_team: STATE.vercel_team,
      staged_target: 'production',
      staged_ready_state: 'READY',
      production_alias_before: PREV_DEPLOYMENT,
      production_alias_after: PREV_DEPLOYMENT,
      staged_at: '2026-11-20T02:47:46.000Z',
      numeric_guard: after,
    },
    result: {
      release_id: NEW_RUN,
      runtime_sha: NEW_SHA,
      app_release_status: 'SUCCESS',
      state: 'VERIFIED',
      promotion_model: 'staged_production',
      promotion_target: NEW_DEPLOYMENT,
      production_deployment: NEW_DEPLOYMENT,
      previous_deployment: PREV_DEPLOYMENT,
      rollback_required: false,
      rules_mutated: false,
      main_unchanged: true,
    },
    rollback: {
      release_id: NEW_RUN,
      candidate_sha: NEW_SHA,
      candidate_deployment: 'dpl_cand_44662166798',
      production_deployment: PREV_DEPLOYMENT,
      production_project: STATE.production_project,
      vercel_team: STATE.vercel_team,
    },
    ...over,
  };
}

function makeDeployment(over = {}) {
  return {
    id: NEW_DEPLOYMENT,
    projectId: STATE.production_project,
    teamId: STATE.vercel_team,
    readyState: 'READY',
    target: 'production',
    meta: { githubCommitSha: NEW_SHA },
    env: ['AUTONOMOUS_PROGRESSION_ENABLED', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED'],
    ...over,
  };
}

test('T854.1 Nueva ancla autenticada (run 44662166798, ZIP digest 05e67f62...) -> PASS', () => {
  assert.equal(app.SAFE_OFF_BASELINE.deployment, NEW_DEPLOYMENT);
  assert.equal(app.SAFE_OFF_BASELINE.runtimeSha, NEW_SHA);
  assert.equal(app.SAFE_OFF_BASELINE.officialReleaseRun, NEW_RUN);
  assert.equal(app.SAFE_OFF_BASELINE.evidenceArtifactDigest, OFFICIAL_ZIP_DIGEST);

  const proof = B.verify(STATE, app.SAFE_OFF_BASELINE, makeDeployment(), makeValidBundle());
  assert.equal(proof.status, 'OFF_AT_IMMUTABLE_BUILD');
  assert.equal(proof.deployment, NEW_DEPLOYMENT);
  assert.equal(proof.officialReleaseRun, NEW_RUN);
  assert.equal(proof.artifactDigest, OFFICIAL_ZIP_DIGEST);
});

test('T854.2 Digest incorrecto (incluyendo 83606e4b...) -> FAIL', () => {
  const b = makeValidBundle();
  b.artifact.digest = WRONG_DOC_DIGEST;
  assert.throws(() => B.verify(STATE, app.SAFE_OFF_BASELINE, makeDeployment(), b), /OFF_BASELINE_ARTIFACT_DIGEST_MISMATCH/);
});

test('T854.3 Deployment inexistente o distinto -> FAIL', async () => {
  assert.throws(
    () => B.verify(STATE, app.SAFE_OFF_BASELINE, makeDeployment({ id: 'dpl_nonexistent_404' }), makeValidBundle()),
    /Expected values to be strictly equal/
  );
  await assert.rejects(
    () => app.verifySafeOffBaseline(STATE, false, async () => { throw new Error('API GET /v13/deployments/dpl_missing failed: HTTP 404'); }),
    /HTTP 404/
  );
});

test('T854.4 SHA diferente -> FAIL', () => {
  assert.throws(
    () => B.verify(STATE, app.SAFE_OFF_BASELINE, makeDeployment({ meta: { githubCommitSha: '0'.repeat(40) } }), makeValidBundle()),
    /Expected values to be strictly equal/
  );
});

test('T854.5 Artefacto expirado, ambiguo o truncado -> FAIL', () => {
  const bExpired = makeValidBundle();
  bExpired.artifact.expired = true;
  assert.throws(() => B.verify(STATE, app.SAFE_OFF_BASELINE, makeDeployment(), bExpired), /OFF_BASELINE_ARTIFACT_EXPIRED/);

  const dupList = {
    total_count: 2,
    artifacts: [{ name: 'app-release-result-' + NEW_RUN }, { name: 'app-release-result-' + NEW_RUN }],
  };
  assert.throws(() => B.selectArtifact(dupList, NEW_RUN), /OFF_BASELINE_ARTIFACT_MISSING_OR_AMBIGUOUS/);

  const truncList = { total_count: 2, artifacts: [{ name: 'app-release-result-' + NEW_RUN }] };
  assert.throws(() => B.selectArtifact(truncList, NEW_RUN), /OFF_BASELINE_ARTIFACT_LIST_TRUNCATED/);
});

test('T854.6 Proyecto o equipo incorrecto -> FAIL', () => {
  assert.throws(
    () => B.verify(STATE, app.SAFE_OFF_BASELINE, makeDeployment({ projectId: 'prj_wrong' }), makeValidBundle()),
    /Expected values to be strictly equal/
  );
  assert.throws(
    () => B.verify(STATE, app.SAFE_OFF_BASELINE, makeDeployment({ teamId: 'team_wrong' }), makeValidBundle()),
    /Expected values to be strictly equal/
  );
});

test('T854.7 Evidencia Numeric Apply ON -> FAIL', () => {
  const bOn = makeValidBundle();
  bOn.preflight.numeric_guard = Object.assign({}, bOn.preflight.numeric_guard, {
    status: 'ARMED',
    flags: { AUTONOMOUS_PROGRESSION_ENABLED: 'PLAIN_TRUE', AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'PLAIN_TRUE' },
  });
  assert.throws(() => B.verify(STATE, app.SAFE_OFF_BASELINE, makeDeployment(), bOn));
});

test('T854.8 Rollback sin prueba válida -> FAIL', () => {
  const validArtifact = {
    production_runtime_sha: NEW_SHA,
    safe_off_deployment: NEW_DEPLOYMENT,
    safe_off_evidence_sha256: 'a'.repeat(64),
  };
  assert.throws(() => app.assertSafeRollbackProof(validArtifact, null), /SAFE_OFF_PROOF_REQUIRED/);
  assert.throws(
    () => app.assertSafeRollbackProof(validArtifact, { status: 'OFF_AT_IMMUTABLE_BUILD', deployment: 'dpl_other', officialReleaseRun: NEW_RUN, evidenceSha256: 'a'.repeat(64) }),
    /SAFE_OFF_DEPLOYMENT_MISMATCH/
  );
  assert.throws(
    () => app.assertSafeRollbackProof(validArtifact, { status: 'OFF_AT_IMMUTABLE_BUILD', deployment: NEW_DEPLOYMENT, officialReleaseRun: NEW_RUN, evidenceSha256: 'b'.repeat(64) }),
    /SAFE_OFF_EVIDENCE_CHANGED/
  );
});

test('T854.9 Historial, completed_at y deployment anterior preservados en .release/vdsen-client.json', () => {
  validate(STATE, SCHEMA);
  assertAppReleaseCoherence(STATE);
  assertPublishedRulesCoherence(STATE);

  assert.equal(STATE.production_deployment, NEW_DEPLOYMENT);
  assert.equal(STATE.runtime_sha, NEW_SHA);
  assert.equal(STATE.rollback_deployment, 'dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8');
  assert.equal(STATE.rollback_runtime_sha, '3fc264e23d67a8ecb1611a6c8af04ad739f422da');
  assert.equal(STATE.app_release.safe_recovery_deployment, 'dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8');
  assert.equal(STATE.app_release.safe_recovery_runtime_sha, '3fc264e23d67a8ecb1611a6c8af04ad739f422da');
  assert.equal(STATE.app_release.previous_deployment, PREV_DEPLOYMENT);
  assert.equal(STATE.app_release.previous_runtime_sha, PREV_SHA);
  assert.equal(STATE.app_release.completed_at, '2026-11-20T02:48:05Z');
  assert.equal(STATE.app_release.source_release_run, NEW_RUN);
  assert.equal(STATE.numeric_apply_enabled, false);
  assert.ok(STATE.observation_source.includes(OFFICIAL_ZIP_DIGEST));
});

test('T854.10 El release APP-ONLY continúa sin permisos de modificación Firestore ni Rules', () => {
  const wf = fs.readFileSync('.github/workflows/vdsen-app-release-prod.yml', 'utf8')
    .split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/firestore\.googleapis|firebaserules|google-github-actions\/auth|GOOGLE_ACCESS_TOKEN/.test(wf));
});
