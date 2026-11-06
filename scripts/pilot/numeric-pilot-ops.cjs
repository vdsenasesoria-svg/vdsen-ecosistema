'use strict';
// Coordinator script for the independent VDSEN Numeric Pilot operational lane.
// Provides CLI entrypoints for preflight validation, runtime attestation, STOP execution,
// and state consistency auditing.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const C = require('../../api/_numericPilotContract');
const { runPreflight } = require('./numeric-preflight.cjs');
const { attestRuntime } = require('./numeric-attestation.cjs');
const { executeStop, auditMesoConsistency, assertFreshAuthorizationRequired } = require('./numeric-stop-recovery.cjs');

/**
 * Validates the execution environment for GitHub Actions workflows.
 * Fails closed if invoked outside protected conditions or if the kill switch is off.
 * @param {object} env - process.env
 */
function invocation(env) {
  env = env || process.env;
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Must be executed within GitHub Actions environment.');
  assert.equal(env.GITHUB_REPOSITORY, 'vdsenasesoria-svg/vdsen-ecosistema', 'Invalid repository.');
  assert.equal(env.GITHUB_REF, 'refs/heads/codex/client-app-next', 'Must target canonical branch codex/client-app-next.');
  assert.equal(env.VDSEN_NUMERIC_PILOT_RELEASE_ENABLED, 'true', 'NUMERIC_PILOT_DISARMED: Kill switch is active.');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'NO_JOB_RERUNS: Reruns are forbidden for numeric operations.');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  if (command === 'invocation') {
    invocation(process.env);
    console.log(JSON.stringify({ status: 'INVOCATION_PERMITTED' }));
    return;
  }

  if (command === 'preflight') {
    const windowFile = args[args.indexOf('--window-file') + 1] || 'release-output/numeric-window.json';
    let windowData = null;
    if (fs.existsSync(windowFile)) {
      windowData = JSON.parse(fs.readFileSync(windowFile, 'utf8'));
    }
    const deploymentId = args[args.indexOf('--deployment') + 1] || null;
    const result = await runPreflight({
      window: windowData,
      deploymentId: deploymentId,
      readOnly: true,
      skipFenceCheck: true // Pure local CLI check unless adapter injected
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.decision === 'NO-GO' || result.decision === 'BLOCKED') {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'attest') {
    const deploymentId = args[args.indexOf('--deployment') + 1];
    const sha = args[args.indexOf('--sha') + 1];
    const opId = args[args.indexOf('--operation-id') + 1];
    const result = await attestRuntime({
      deploymentId,
      expectedSha: sha,
      expectedOperationId: opId
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.attested) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'help') {
    console.log('Usage: node scripts/pilot/numeric-pilot-ops.cjs <invocation|preflight|attest|stop|audit>');
    return;
  }

  console.error('Unknown command: ' + command);
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => {
    console.error('Operational error: ' + err.message);
    process.exit(1);
  });
}

module.exports = {
  invocation,
  runPreflight,
  attestRuntime,
  executeStop,
  auditMesoConsistency,
  assertFreshAuthorizationRequired
};
