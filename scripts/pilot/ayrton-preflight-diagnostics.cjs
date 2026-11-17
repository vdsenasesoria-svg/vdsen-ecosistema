'use strict';
// Read-only diagnostics for Ayrton ARM_PREFLIGHT and failed-run reconciliation admissibility.
// Preserves the exact real preflight checks separately and reports only check names and safe codes.
// Never prints tokens, env values, UIDs, or Firestore document contents.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const A = require('../release/app-live.cjs');
const G = require('../release/numeric-guard.cjs');
const R = require('./ayrton-runtime.cjs');
const W = require('./ayrton-window.cjs');
const B = require('./off-baseline.cjs');

async function runCheck(name, fn) {
  try {
    await fn();
    return { check: name, status: 'PASS', code: 'PASS' };
  } catch (err) {
    return { check: name, status: 'FAIL', code: R.classifyDiagnosticCode(err) };
  }
}

async function runAyrtonPreflightDiagnostics(opts = {}) {
  const s = opts.state || JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
  const runtimeSha = opts.runtimeSha || s.runtime_sha;
  const baseline = opts.baseline || {
    runtimeSha: s.runtime_sha,
    deployment: s.production_deployment,
    officialReleaseRun: String(s.app_release.source_release_run),
  };
  const io = opts.io || R.adapters(s);
  const git = opts.git || ((...args) => execFileSync('git', args, { encoding: 'utf8' }).trim());
  const assertLegacyRetiredFn = opts.assertLegacyRetired || W.assertLegacyRetired;
  const downloadBaselineFn = opts.downloadBaseline || B.download;
  const gatherRecFn = opts.gatherReconciliationEvidence || R.gatherReconciliationEvidence;

  const checks = [];

  checks.push(await runCheck('SOURCE', async () => {
    git('merge-base', '--is-ancestor', runtimeSha, 'HEAD');
    const dp = require('../release/deployed-product.cjs');
    dp.verify(runtimeSha, dp.MANIFEST);
    git('diff', '--exit-code', runtimeSha, 'HEAD', '--', 'api',
      'assets/progression-application-consumer.js',
      'assets/progression-auto-apply-shadow.js',
      'assets/progression-effective-prescription.js',
      'assets/progression-equipment-resolver.js',
      'assets/progression-magnitude-policy.js',
      'firestore.rules', 'firestore.indexes.json', 'package.json', 'package-lock.json');
    G.assertContractCoverage(G.discoverRuntimeEnvNames(runtimeSha, git));
    assert.ok(git('show', runtimeSha + ':api/autonomous-progression-trigger.js').includes('vdsen-progression-runtime-v1'), 'PROBE_NOT_IN_RUNTIME');
    const main = git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0];
    R.assertAuthorizedMainSha(main);
  }));

  checks.push(await runCheck('LEGACY', async () => {
    await assertLegacyRetiredFn(s);
  }));

  checks.push(await runCheck('BASELINE', async () => {
    if (opts.ensureBaselineArtifacts !== false && !fs.existsSync('release-output/off-baseline/official-run.json')) {
      downloadBaselineFn(s, baseline);
    }
    await io.validateBaseline(baseline);
  }));

  checks.push(await runCheck('ALIAS', async () => {
    assert.equal(await io.current(), baseline.deployment, 'BASELINE_MOVED');
  }));

  if (opts.window && (opts.hasFirestoreToken || process.env.GOOGLE_ACCESS_TOKEN)) {
    checks.push(await runCheck('FENCES', async () => {
      const snap = await io.snapshot(opts.window);
      R.closed(opts.window, snap);
    }));
  } else {
    checks.push({ check: 'FENCES', status: 'SKIPPED', code: 'SKIPPED_NO_FIRESTORE_SCOPE' });
  }

  checks.push(await runCheck('NUMERIC_GUARD', async () => {
    const before = await io.offProof();
    G.assertDisarmedEvidence(before);
    G.assertFresh(before);
  }));

  const operationId = opts.operationId || 'op-diag-readonly-check';
  checks.push(await runCheck('DEPLOYMENTS', async () => {
    await io.assertNoPriorOperation(operationId);
  }));

  let reconciliation = null;
  if (opts.reconcileCheckRunId) {
    try {
      const ev = await gatherRecFn(s, String(opts.reconcileCheckRunId));
      reconciliation = {
        runId: ev.runId,
        admissible: ev.evidenceVerified === true && ev.stagedDeploymentsCount === 0 && ev.priorRunMutations === 0 && ev.currentAlias === ev.baselineDeployment,
        phaseProven: ev.phaseProven,
        stagedDeploymentsCount: ev.stagedDeploymentsCount,
        priorRunMutations: ev.priorRunMutations,
        baselineMatchesAlias: ev.currentAlias === ev.baselineDeployment,
        code: 'PASS',
      };
    } catch (err) {
      reconciliation = {
        runId: String(opts.reconcileCheckRunId),
        admissible: false,
        code: R.classifyDiagnosticCode(err),
      };
    }
  }

  const failed = checks.filter(c => c.status === 'FAIL');
  return {
    schema: 'vdsen-ayrton-preflight-diagnostics-v1',
    runtime_sha: runtimeSha,
    baseline_deployment: baseline.deployment,
    checks,
    reconciliation,
    overall: failed.length === 0 && (!reconciliation || reconciliation.admissible) ? 'PASS' : 'FAIL',
  };
}

if (require.main === module) {
  (async () => {
    const report = await runAyrtonPreflightDiagnostics({
      runtimeSha: process.env.APP_RUNTIME_SHA || undefined,
      operationId: process.env.AYRTON_OPERATION_ID || undefined,
      reconcileCheckRunId: process.env.RECONCILE_CHECK_RUN_ID || undefined,
    });
    fs.mkdirSync('release-output', { recursive: true });
    fs.writeFileSync(path.join('release-output', 'ayrton-preflight-diagnostics.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.overall !== 'PASS') process.exitCode = 1;
  })().catch(err => {
    console.error(JSON.stringify({ schema: 'vdsen-ayrton-preflight-diagnostics-v1', overall: 'FAIL', code: R.classifyDiagnosticCode(err) }));
    process.exitCode = 1;
  });
}

module.exports = { runAyrtonPreflightDiagnostics, runCheck };
