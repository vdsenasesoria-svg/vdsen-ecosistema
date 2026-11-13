'use strict';
// App-only production alias restoration (T782).
//
// Restores the Vercel production alias (vdsen-ecosistema.vercel.app) back to the
// accredited OFF baseline deployment (dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8) when
// production was overwritten by an accidental `main` branch auto-deploy.
//
// Strict invariants:
//   - No Firestore reads/writes, no rules changes, no Numeric Apply changes.
//   - No new Vercel deployments (`vercel deploy` is never invoked).
//   - Never overwrites a legitimate newer `codex/client-app-next` release.
//   - Rejects concurrent alias changes (double-read before mutating).
//   - Verifies post-mutation alias convergence and public byte smoke test.
//   - Fail-closed on any unexpected identity, status, or error; never prints tokens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { json, git } = require('./lib.cjs');
const appLive = require('./app-live.cjs');

const EXPECTED_PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const EXPECTED_TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';
const EXPECTED_OFF_BASELINE = 'dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8';
const EXPECTED_OFF_SHA = '3fc264e23d67a8ecb1611a6c8af04ad739f422da';
const EXPECTED_ORIGIN = 'https://vdsen-ecosistema.vercel.app';

function validateStateManifest(s) {
  assert.ok(s && typeof s === 'object', 'STATE_MANIFEST_MISSING');
  assert.equal(s.production_project, EXPECTED_PROJECT, 'PROJECT_IDENTITY_MISMATCH');
  assert.equal(s.vercel_team, EXPECTED_TEAM, 'TEAM_IDENTITY_MISMATCH');
  assert.equal(s.production_deployment, EXPECTED_OFF_BASELINE, 'BASELINE_DEPLOYMENT_MISMATCH');
  assert.equal(s.runtime_sha, EXPECTED_OFF_SHA, 'BASELINE_RUNTIME_SHA_MISMATCH');
  assert.equal(s.production_origin, EXPECTED_ORIGIN, 'PRODUCTION_ORIGIN_MISMATCH');
  assert.equal(s.numeric_apply_enabled, false, 'NUMERIC_APPLY_MUST_BE_FALSE');
  return s;
}

function assertTargetEligible(targetDep, s) {
  assert.ok(targetDep && typeof targetDep === 'object', 'TARGET_DEPLOYMENT_MISSING');
  const id = targetDep.id || targetDep.uid;
  assert.equal(id, s.production_deployment, 'TARGET_DEPLOYMENT_ID_MISMATCH');
  assert.equal(targetDep.projectId, s.production_project, 'TARGET_PROJECT_MISMATCH');
  assert.equal(targetDep.teamId || targetDep.ownerId, s.vercel_team, 'TARGET_TEAM_MISMATCH');
  assert.equal(targetDep.readyState, 'READY', 'TARGET_NOT_READY');
  assert.equal(targetDep.target, 'production', 'TARGET_NOT_PRODUCTION');
  const sha = targetDep.meta && targetDep.meta.githubCommitSha;
  assert.equal(sha, s.runtime_sha, 'TARGET_RUNTIME_SHA_MISMATCH');
  return {
    id,
    projectId: targetDep.projectId,
    teamId: targetDep.teamId || targetDep.ownerId,
    readyState: targetDep.readyState,
    target: targetDep.target,
    githubCommitSha: sha,
    githubCommitRef: targetDep.meta && targetDep.meta.githubCommitRef ? targetDep.meta.githubCommitRef : null,
    createdAt: targetDep.createdAt || targetDep.created || null,
  };
}

function assertCurrentIsAccidentalMainDrift(currentDep, expectedCurrentId, mainSha) {
  assert.ok(currentDep && typeof currentDep === 'object', 'CURRENT_DEPLOYMENT_MISSING');
  const id = currentDep.id || currentDep.uid;
  assert.equal(id, expectedCurrentId, 'CURRENT_DEPLOYMENT_ID_MISMATCH');
  assert.equal(currentDep.projectId, EXPECTED_PROJECT, 'CURRENT_PROJECT_MISMATCH');
  assert.equal(currentDep.teamId || currentDep.ownerId, EXPECTED_TEAM, 'CURRENT_TEAM_MISMATCH');
  const meta = currentDep.meta || {};
  assert.equal(meta.githubCommitRef, 'main', 'REFUSING_OVERWRITE_NON_MAIN_DEPLOYMENT');
  assert.match(String(mainSha || ''), /^[0-9a-f]{40}$/, 'MAIN_SHA_INVALID');
  assert.equal(meta.githubCommitSha, mainSha, 'REFUSING_OVERWRITE_UNKNOWN_COMMIT');
  return {
    id,
    githubCommitSha: meta.githubCommitSha,
    githubCommitRef: meta.githubCommitRef,
    readyState: currentDep.readyState || null,
    target: currentDep.target || null,
    createdAt: currentDep.createdAt || currentDep.created || null,
  };
}

async function restoreProdAlias(opts = {}) {
  const env = opts.env || process.env;
  assert.equal(env.CLIENT_APP_RELEASE_ENABLED, 'true', 'CLIENT_APP_RELEASE_ENABLED_NOT_TRUE');

  const s = validateStateManifest(opts.state || json('.release/vdsen-client.json'));
  const targetId = String(env.TARGET_DEPLOYMENT || '').trim();
  const expectedCurrentId = String(env.EXPECTED_CURRENT_DEPLOYMENT || '').trim();
  assert.equal(targetId, s.production_deployment, 'TARGET_INPUT_MISMATCH');
  assert.match(expectedCurrentId, /^dpl_[A-Za-z0-9]+$/, 'EXPECTED_CURRENT_INPUT_INVALID');
  assert.notEqual(expectedCurrentId, targetId, 'ALIAS_ALREADY_ON_TARGET');

  const currentAppFn = opts.currentApp || appLive.currentApp;
  const deploymentFn = opts.deployment || appLive.deployment;
  const revertAppFn = opts.revertApp || appLive.revertApp;
  const verifyBytesFn = opts.verifyPublicBytes || ((st, sha, paths) => appLive.verifyPublicBytes(st, sha, paths));
  const httpSurfaceFn = opts.httpServedSurface || appLive.httpServedSurface;
  const getMainShaFn = opts.getMainSha || (() => git('ls-remote', 'origin', 'refs/heads/main').trim().split(/\s/)[0]);
  const writeResultFn = opts.writeResult || ((out) => {
    fs.mkdirSync('release-output', { recursive: true });
    fs.writeFileSync('release-output/alias-restore-result.json', JSON.stringify(out, null, 2) + '\n');
  });

  // 1. Live read #1 + identity/eligibility checks
  const liveBefore1 = await currentAppFn(s);
  assert.equal(liveBefore1, expectedCurrentId, 'LIVE_ALIAS_MISMATCH_BEFORE');

  const mainSha = getMainShaFn();
  const currentDep = await deploymentFn(s, expectedCurrentId);
  const currentMeta = assertCurrentIsAccidentalMainDrift(currentDep, expectedCurrentId, mainSha);

  const targetDep = await deploymentFn(s, targetId);
  const targetMeta = assertTargetEligible(targetDep, s);

  // 2. Live read #2 immediately before mutating (reject concurrent change)
  const liveBefore2 = await currentAppFn(s);
  assert.equal(liveBefore2, liveBefore1, 'CONCURRENT_ALIAS_CHANGE');

  const report = {
    schema: 'vdsen-alias-restore-v1',
    run_id: env.GITHUB_RUN_ID || 'local',
    project: s.production_project,
    team: s.vercel_team,
    origin: s.production_origin,
    alias_before: liveBefore2,
    current_deployment_meta: currentMeta,
    target_deployment: targetId,
    target_deployment_meta: targetMeta,
    firestore_mutated: false,
    numeric_apply_enabled: false,
    new_deployment_created: false,
    mutation_attempted: false,
    alias_after: null,
    verified_public_paths_count: 0,
    status: 'PREFLIGHT_VERIFIED',
  };

  try {
    report.mutation_attempted = true;
    await revertAppFn(s, targetId);
    const liveAfter = await currentAppFn(s);
    assert.equal(liveAfter, targetId, 'ALIAS_DID_NOT_CONVERGE_TO_TARGET');
    report.alias_after = liveAfter;

    const verifiedPaths = await verifyBytesFn(s, s.runtime_sha, httpSurfaceFn());
    report.verified_public_paths_count = verifiedPaths.length;
    report.status = 'RESTORED_AND_VERIFIED';
    writeResultFn(report);
    return report;
  } catch (err) {
    try {
      report.alias_after = await currentAppFn(s);
    } catch (_) {
      report.alias_after = 'UNREADABLE';
    }
    report.status = 'RESTORE_FAILED';
    report.error_message = String(err && err.message ? err.message : err).slice(0, 200);
    writeResultFn(report);
    throw err;
  }
}

if (require.main === module) {
  restoreProdAlias().then((r) => {
    console.log('ALIAS RESTORE PASS: ' + r.alias_before + ' -> ' + r.alias_after + ' (' + r.verified_public_paths_count + ' paths verified)');
  }).catch((e) => {
    console.error('ALIAS RESTORE FAILED: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  });
}

module.exports = {
  validateStateManifest,
  assertTargetEligible,
  assertCurrentIsAccidentalMainDrift,
  restoreProdAlias,
};
