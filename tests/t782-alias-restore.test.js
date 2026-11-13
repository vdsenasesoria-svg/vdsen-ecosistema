'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateStateManifest,
  assertTargetEligible,
  assertCurrentIsAccidentalMainDrift,
  restoreProdAlias,
} = require('../scripts/release/restore-prod-alias.cjs');
const { collectDriftAndProjectEvidence } = require('../scripts/release/app-diagnostics.cjs');

const BASELINE_ID = 'dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8';
const DRIFT_ID = 'dpl_4Kw3Ts9Ym9XhEFruckdENDhDi1u1';
const OFF_SHA = '3fc264e23d67a8ecb1611a6c8af04ad739f422da';
const MAIN_SHA = 'eee34ea6442381ef7af086d08f149445f347efb6';
const PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';

function sampleState() {
  return {
    production_project: PROJECT,
    vercel_team: TEAM,
    production_deployment: BASELINE_ID,
    runtime_sha: OFF_SHA,
    production_origin: 'https://vdsen-ecosistema.vercel.app',
    numeric_apply_enabled: false,
  };
}

function sampleTargetDep(overrides = {}) {
  return {
    id: BASELINE_ID,
    projectId: PROJECT,
    teamId: TEAM,
    readyState: 'READY',
    target: 'production',
    createdAt: 1762909500000,
    meta: { githubCommitSha: OFF_SHA, githubCommitRef: 'codex/client-app-next' },
    ...overrides,
  };
}

function sampleDriftDep(overrides = {}) {
  return {
    id: DRIFT_ID,
    projectId: PROJECT,
    teamId: TEAM,
    readyState: 'READY',
    target: 'production',
    createdAt: 1762921142000,
    meta: { githubCommitSha: MAIN_SHA, githubCommitRef: 'main' },
    ...overrides,
  };
}

test('restoreProdAlias succeeds on accidental main drift and verifies smoke', async () => {
  let aliasState = DRIFT_ID;
  let revertCalledWith = null;
  let written = null;
  const res = await restoreProdAlias({
    state: sampleState(),
    env: {
      CLIENT_APP_RELEASE_ENABLED: 'true',
      TARGET_DEPLOYMENT: BASELINE_ID,
      EXPECTED_CURRENT_DEPLOYMENT: DRIFT_ID,
      GITHUB_RUN_ID: '99999',
    },
    getMainSha: () => MAIN_SHA,
    currentApp: async () => aliasState,
    deployment: async (_s, id) => (id === DRIFT_ID ? sampleDriftDep() : sampleTargetDep()),
    revertApp: async (_s, id) => { revertCalledWith = id; aliasState = id; return id; },
    httpServedSurface: () => ['vdsen-cliente.html'],
    verifyPublicBytes: async (_s, sha, paths) => {
      assert.equal(sha, OFF_SHA);
      return paths;
    },
    writeResult: (r) => { written = r; },
  });
  assert.equal(revertCalledWith, BASELINE_ID);
  assert.equal(res.status, 'RESTORED_AND_VERIFIED');
  assert.equal(res.alias_before, DRIFT_ID);
  assert.equal(res.alias_after, BASELINE_ID);
  assert.equal(res.firestore_mutated, false);
  assert.equal(res.numeric_apply_enabled, false);
  assert.equal(res.new_deployment_created, false);
  assert.equal(written.verified_public_paths_count, 1);
});

test('restoreProdAlias rejects concurrent alias change before mutating', async () => {
  let calls = 0;
  let mutated = false;
  await assert.rejects(
    () => restoreProdAlias({
      state: sampleState(),
      env: {
        CLIENT_APP_RELEASE_ENABLED: 'true',
        TARGET_DEPLOYMENT: BASELINE_ID,
        EXPECTED_CURRENT_DEPLOYMENT: DRIFT_ID,
      },
      getMainSha: () => MAIN_SHA,
      currentApp: async () => (++calls === 1 ? DRIFT_ID : 'dpl_OtherConcurrent123'),
      deployment: async (_s, id) => (id === DRIFT_ID ? sampleDriftDep() : sampleTargetDep()),
      revertApp: async () => { mutated = true; },
      writeResult: () => {},
    }),
    /CONCURRENT_ALIAS_CHANGE/
  );
  assert.equal(mutated, false);
});

test('assertCurrentIsAccidentalMainDrift refuses overwriting non-main deployment', () => {
  assert.throws(
    () => assertCurrentIsAccidentalMainDrift(
      sampleDriftDep({ meta: { githubCommitSha: OFF_SHA, githubCommitRef: 'codex/client-app-next' } }),
      DRIFT_ID,
      MAIN_SHA
    ),
    /REFUSING_OVERWRITE_NON_MAIN_DEPLOYMENT/
  );
});

test('assertTargetEligible refuses non-READY or wrong-SHA target', () => {
  assert.throws(
    () => assertTargetEligible(sampleTargetDep({ readyState: 'ERROR' }), sampleState()),
    /TARGET_NOT_READY/
  );
  assert.throws(
    () => assertTargetEligible(sampleTargetDep({ meta: { githubCommitSha: '0'.repeat(40) } }), sampleState()),
    /TARGET_RUNTIME_SHA_MISMATCH/
  );
});

test('validateStateManifest rejects numeric_apply_enabled != false', () => {
  assert.throws(
    () => validateStateManifest({ ...sampleState(), numeric_apply_enabled: true }),
    /NUMERIC_APPLY_MUST_BE_FALSE/
  );
});

test('collectDriftAndProjectEvidence captures alias, deployments, and project git config safely', async () => {
  const s = sampleState();
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('/v4/aliases/')) {
      return { status: 200, json: async () => ({ alias: 'vdsen-ecosistema.vercel.app', deployment: { id: DRIFT_ID }, projectId: PROJECT, createdAt: 1762921142000 }) };
    }
    if (u.includes('/v13/deployments/' + DRIFT_ID)) {
      return { status: 200, json: async () => sampleDriftDep() };
    }
    if (u.includes('/v13/deployments/' + BASELINE_ID)) {
      return { status: 200, json: async () => sampleTargetDep() };
    }
    if (u.includes('/v13/deployments/dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K')) {
      return { status: 200, json: async () => ({ id: 'dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K', projectId: PROJECT, teamId: TEAM, readyState: 'READY', target: 'production', meta: { githubCommitRef: 'codex/client-app-next', githubCommitSha: '21dc0e2b211facfb0df9f3079c58488c2f86952c' } }) };
    }
    if (u.includes('/v9/projects/' + PROJECT)) {
      return { status: 200, json: async () => ({ id: PROJECT, accountId: TEAM, autoAssignCustomDomains: true, link: { type: 'github', repo: 'vdsenasesoria-svg/vdsen-ecosistema', productionBranch: 'main' } }) };
    }
    return { status: 404 };
  };
  const ev = await collectDriftAndProjectEvidence(s, 'tok', { fetch: mockFetch });
  assert.equal(ev.alias_live.deploymentId, DRIFT_ID);
  assert.equal(ev.live_deployment.githubCommitRef, 'main');
  assert.equal(ev.live_deployment.githubCommitSha, MAIN_SHA);
  assert.equal(ev.baseline_deployment.readyState, 'READY');
  assert.equal(ev.project_git_config.productionBranch, 'main');
});
