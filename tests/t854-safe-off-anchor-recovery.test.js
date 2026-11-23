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
const ANCHOR_STATE = Object.assign({}, STATE, {
  runtime_sha: NEW_SHA,
  production_deployment: NEW_DEPLOYMENT,
  app_release: Object.assign({}, STATE.app_release, {
    runtime_sha: NEW_SHA,
    deployment: NEW_DEPLOYMENT,
    source_release_run: NEW_RUN,
  }),
});

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

  const proof = B.verify(ANCHOR_STATE, app.SAFE_OFF_BASELINE, makeDeployment(), makeValidBundle());
  assert.equal(proof.status, 'OFF_AT_IMMUTABLE_BUILD');
  assert.equal(proof.deployment, NEW_DEPLOYMENT);
  assert.equal(proof.officialReleaseRun, NEW_RUN);
  assert.equal(proof.artifactDigest, OFFICIAL_ZIP_DIGEST);
});

test('T854.2 Digest incorrecto (incluyendo 83606e4b...) -> FAIL', () => {
  const b = makeValidBundle();
  b.artifact.digest = WRONG_DOC_DIGEST;
  assert.throws(() => B.verify(ANCHOR_STATE, app.SAFE_OFF_BASELINE, makeDeployment(), b), /OFF_BASELINE_ARTIFACT_DIGEST_MISMATCH/);
});

test('T854.3 Deployment inexistente o distinto -> FAIL', async () => {
  assert.throws(
    () => B.verify(ANCHOR_STATE, app.SAFE_OFF_BASELINE, makeDeployment({ id: 'dpl_nonexistent_404' }), makeValidBundle()),
    /Expected values to be strictly equal/
  );
  await assert.rejects(
    () => app.verifySafeOffBaseline(STATE, false, async () => { throw new Error('API GET /v13/deployments/dpl_missing failed: HTTP 404'); }),
    /HTTP 404/
  );
});

test('T854.4 SHA diferente -> FAIL', () => {
  assert.throws(
    () => B.verify(ANCHOR_STATE, app.SAFE_OFF_BASELINE, makeDeployment({ meta: { githubCommitSha: '0'.repeat(40) } }), makeValidBundle()),
    /Expected values to be strictly equal/
  );
});

test('T854.5 Artefacto expirado, ambiguo o truncado -> FAIL', () => {
  const bExpired = makeValidBundle();
  bExpired.artifact.expired = true;
  assert.throws(() => B.verify(ANCHOR_STATE, app.SAFE_OFF_BASELINE, makeDeployment(), bExpired), /OFF_BASELINE_ARTIFACT_EXPIRED/);

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
    () => B.verify(ANCHOR_STATE, app.SAFE_OFF_BASELINE, makeDeployment({ projectId: 'prj_wrong' }), makeValidBundle()),
    /Expected values to be strictly equal/
  );
  assert.throws(
    () => B.verify(ANCHOR_STATE, app.SAFE_OFF_BASELINE, makeDeployment({ teamId: 'team_wrong' }), makeValidBundle()),
    /Expected values to be strictly equal/
  );
});

test('T854.7 Evidencia Numeric Apply ON -> FAIL', () => {
  const bOn = makeValidBundle();
  bOn.preflight.numeric_guard = Object.assign({}, bOn.preflight.numeric_guard, {
    status: 'ARMED',
    flags: { AUTONOMOUS_PROGRESSION_ENABLED: 'PLAIN_TRUE', AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'PLAIN_TRUE' },
  });
  assert.throws(() => B.verify(ANCHOR_STATE, app.SAFE_OFF_BASELINE, makeDeployment(), bOn));
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

  assert.equal(STATE.rollback_deployment, 'dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8');
  assert.equal(STATE.rollback_runtime_sha, '3fc264e23d67a8ecb1611a6c8af04ad739f422da');
  assert.equal(STATE.app_release.safe_recovery_deployment, 'dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8');
  assert.equal(STATE.app_release.safe_recovery_runtime_sha, '3fc264e23d67a8ecb1611a6c8af04ad739f422da');
  assert.equal(STATE.numeric_apply_enabled, false);
  assert.ok(
    (STATE.production_deployment === NEW_DEPLOYMENT && STATE.app_release.previous_deployment === PREV_DEPLOYMENT) ||
    (STATE.app_release.previous_deployment === NEW_DEPLOYMENT && STATE.app_release.previous_runtime_sha === NEW_SHA) ||
    (
      STATE.production_deployment === 'dpl_26Q4iTpsCbQvPNFR8vKwa74PrPpS' &&
      STATE.runtime_sha === '0e4c98db0999e24e66e0f0455d21f128101f3cca' &&
      STATE.app_release.source_release_run === '44967701489' &&
      STATE.app_release.completed_at === '2026-11-22T00:49:55Z' &&
      STATE.app_release.previous_deployment === 'dpl_C6Cys2xFLtf8kePD84yWXGU6X3i4' &&
      STATE.app_release.previous_runtime_sha === '0430df740a2a12c05f102eecc694153fbe9a2536' &&
      STATE.observation_source.includes('sha256:4d981bdf98be697e5a6aa02483a07bb29edcb4c39a179903ecce7a1e22ecdfa6') &&
      STATE.observation_source.includes(NEW_DEPLOYMENT) &&
      STATE.observation_source.includes(OFFICIAL_ZIP_DIGEST)
    ) ||
    (
      STATE.production_deployment === 'dpl_GdjjRpevKPXMUvW52fkfbKfdDXTA' &&
      STATE.runtime_sha === '487bd58dee1491c4f6c83b42b74ff852580d9d37' &&
      STATE.app_release.source_release_run === '45036988679' &&
      STATE.app_release.completed_at === '2026-11-22T15:22:35Z' &&
      STATE.app_release.previous_deployment === 'dpl_26Q4iTpsCbQvPNFR8vKwa74PrPpS' &&
      STATE.app_release.previous_runtime_sha === '0e4c98db0999e24e66e0f0455d21f128101f3cca' &&
      STATE.observation_source.includes('sha256:bf7b974d0d5e0c25257acad64c561a8dbfdedcec057824e0de6d963fa7153a4d') &&
      STATE.observation_source.includes('sha256:4d981bdf98be697e5a6aa02483a07bb29edcb4c39a179903ecce7a1e22ecdfa6') &&
      STATE.observation_source.includes(NEW_DEPLOYMENT) &&
      STATE.observation_source.includes(OFFICIAL_ZIP_DIGEST)
    ) ||
    (
      STATE.production_deployment === 'dpl_3yr6ntHAP3Lg2jqMRPtnuYT2o9si' &&
      STATE.runtime_sha === 'bfa380c1148064df3c037dca85ee3ff4b49de40a' &&
      STATE.app_release.source_release_run === '45088520701' &&
      STATE.app_release.completed_at === '2026-11-23T00:33:23Z' &&
      STATE.app_release.previous_deployment === 'dpl_GdjjRpevKPXMUvW52fkfbKfdDXTA' &&
      STATE.app_release.previous_runtime_sha === '487bd58dee1491c4f6c83b42b74ff852580d9d37' &&
      STATE.observation_source.includes('sha256:77f42a6bc0656be9975abc71a99df1d654f9fdac376186e2a6c43e506243a0ce') &&
      STATE.observation_source.includes('sha256:bf7b974d0d5e0c25257acad64c561a8dbfdedcec057824e0de6d963fa7153a4d') &&
      STATE.observation_source.includes(NEW_DEPLOYMENT) &&
      STATE.observation_source.includes(OFFICIAL_ZIP_DIGEST)
    ) ||
    (
      STATE.production_deployment === 'dpl_3FUD41kgs6FXXyVPrY6DnTnpVxCy' &&
      STATE.runtime_sha === 'fc6937882c3ed6b225301dc068e72e3be9a92585' &&
      STATE.app_release.source_release_run === '45114732758' &&
      STATE.app_release.completed_at === '2026-11-23T05:06:05Z' &&
      STATE.app_release.previous_deployment === 'dpl_3yr6ntHAP3Lg2jqMRPtnuYT2o9si' &&
      STATE.app_release.previous_runtime_sha === 'bfa380c1148064df3c037dca85ee3ff4b49de40a' &&
      STATE.observation_source.includes('sha256:cb46a15007cdb04dba7c2551226950969ff50de3acf7d6508b64a18c4bdbd636') &&
      STATE.observation_source.includes('sha256:77f42a6bc0656be9975abc71a99df1d654f9fdac376186e2a6c43e506243a0ce') &&
      STATE.observation_source.includes(NEW_DEPLOYMENT) &&
      STATE.observation_source.includes(OFFICIAL_ZIP_DIGEST)
    ) ||
    (
      STATE.production_deployment === 'dpl_5dCM9WMbVCJ3zxKi5XsKU1gvarQG' &&
      STATE.runtime_sha === '5c9024684a71f10441056404e0bc5a4705fdb377' &&
      STATE.app_release.source_release_run === '45166439226' &&
      STATE.app_release.completed_at === '2026-11-23T11:45:11Z' &&
      STATE.app_release.previous_deployment === 'dpl_3FUD41kgs6FXXyVPrY6DnTnpVxCy' &&
      STATE.app_release.previous_runtime_sha === 'fc6937882c3ed6b225301dc068e72e3be9a92585' &&
      STATE.observation_source.includes('sha256:acd295c071aede819606ab1a0ff3652a076c4a9df993ced12b52ad657a080fbe') &&
      STATE.observation_source.includes('sha256:cb46a15007cdb04dba7c2551226950969ff50de3acf7d6508b64a18c4bdbd636') &&
      STATE.observation_source.includes(NEW_DEPLOYMENT) &&
      STATE.observation_source.includes(OFFICIAL_ZIP_DIGEST)
    ),
    'SAFE_OFF_BASELINE anchor and exact accredited current/previous release identities are verified in canonical provenance'
  );
  assert.match(STATE.app_release.completed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(STATE.app_release.source_release_run, /^\d+$/);
  assert.match(STATE.observation_source, /sha256:[0-9a-f]{64}/);
});

test('T854.10 El release APP-ONLY continúa sin permisos de modificación Firestore ni Rules', () => {
  const wf = fs.readFileSync('.github/workflows/vdsen-app-release-prod.yml', 'utf8')
    .split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/firestore\.googleapis|firebaserules|google-github-actions\/auth|GOOGLE_ACCESS_TOKEN/.test(wf));
});
