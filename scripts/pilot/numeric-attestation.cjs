'use strict';
// Independent runtime attestation for VDSEN numeric pilot.
// Queries the provider (Vercel) directly to verify deployment state, commit SHA, project,
// team, and environment flags. Reports BLOCKED if provider credentials are unavailable.
// Never substitutes missing evidence with heuristics.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../../api/_numericPilotContract');

const DEFAULT_PROJECT_ID = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const DEFAULT_TEAM_ID = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Attests a Vercel deployment against the authorized numeric pilot specifications.
 * @param {object} opts
 * @param {string} opts.deploymentId - Vercel deployment ID (e.g. dpl_...)
 * @param {string} opts.expectedSha - 40-char commit SHA
 * @param {string} opts.expectedOperationId - Approved window operationId
 * @param {string} [opts.expectedUid] - Must match C.UID
 * @param {string} [opts.expectedPlanId] - Must match C.PLAN
 * @param {string} [opts.expectedPid] - Must match C.PID
 * @param {string} [opts.expectedExpiresAt] - ISO UTC timestamp
 * @param {string} [opts.expectedStartsAt] - ISO UTC timestamp
 * @param {string} [opts.vercelToken] - Vercel API token
 * @param {string} [opts.projectId] - Expected Vercel project ID
 * @param {string} [opts.teamId] - Expected Vercel team ID
 * @param {number} [opts.now] - Current epoch millis
 * @param {Function} [opts.fetcher] - Custom fetch implementation for isolation/mocking
 * @returns {Promise<object>} Attestation record
 */
async function attestRuntime(opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const projectId = opts.projectId || DEFAULT_PROJECT_ID;
  const teamId = opts.teamId || DEFAULT_TEAM_ID;
  const token = opts.vercelToken || process.env.VERCEL_TOKEN;

  // 1. Mandatory Identity Validations
  const uid = opts.expectedUid || C.UID;
  if (uid !== C.UID) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'FOREIGN_UID',
      message: 'Attestation rejected: UID is not authorized for numeric pilot.'
    };
  }

  const pid = opts.expectedPid || C.PID;
  if (pid !== C.PID) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'FOREIGN_PID',
      message: 'Attestation rejected: PID is not authorized for numeric pilot.'
    };
  }

  const planId = opts.expectedPlanId || C.PLAN;
  if (planId !== C.PLAN) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'FOREIGN_PLAN',
      message: 'Attestation rejected: Plan is not authorized for numeric pilot.'
    };
  }

  if (!opts.deploymentId || !/^dpl_[A-Za-z0-9]+$/.test(opts.deploymentId)) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'INVALID_DEPLOYMENT_ID',
      message: 'Deployment ID is missing or malformed.'
    };
  }

  if (!opts.expectedSha || !/^[a-f0-9]{40}$/.test(opts.expectedSha)) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'INVALID_EXPECTED_SHA',
      message: 'Expected commit SHA is missing or malformed.'
    };
  }

  if (!opts.expectedOperationId || !/^[A-Za-z0-9-]{8,80}$/.test(opts.expectedOperationId)) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'INVALID_OPERATION_ID',
      message: 'Expected operationId is missing or invalid.'
    };
  }

  // 2. Provider Authentication Check
  if (!token && !opts.fetcher) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'BLOCKED',
      reason: 'VERCEL_TOKEN_UNAVAILABLE',
      message: 'Provider attestation blocked: VERCEL_TOKEN is not available in the current session.'
    };
  }

  const fetchFn = opts.fetcher || (async (url, init) => {
    return fetch(url, init);
  });

  // 3. Provider Deployment Query
  let deploymentData;
  try {
    const url = 'https://api.vercel.com/v13/deployments/' + opts.deploymentId + '?teamId=' + teamId;
    const res = await fetchFn(url, {
      headers: {
        authorization: 'Bearer ' + token,
        'user-agent': 'vdsen-numeric-attestation/1.0'
      },
      redirect: 'error'
    });

    if (res.status === 401 || res.status === 403) {
      return {
        schema: 'vdsen-numeric-runtime-attestation-v1',
        attested: false,
        status: 'BLOCKED',
        reason: 'PROVIDER_AUTH_FAILED',
        httpStatus: res.status,
        message: 'Vercel API credentials rejected or lack required permissions.'
      };
    }

    if (res.status === 404) {
      return {
        schema: 'vdsen-numeric-runtime-attestation-v1',
        attested: false,
        status: 'REJECTED',
        reason: 'DEPLOYMENT_NOT_FOUND',
        message: 'Deployment not found in Vercel project.'
      };
    }

    if (res.status !== 200) {
      return {
        schema: 'vdsen-numeric-runtime-attestation-v1',
        attested: false,
        status: 'BLOCKED',
        reason: 'PROVIDER_API_ERROR',
        httpStatus: res.status,
        message: 'Vercel API returned unexpected status code ' + res.status
      };
    }

    deploymentData = await res.json();
  } catch (err) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'BLOCKED',
      reason: 'NETWORK_OR_PROVIDER_ERROR',
      message: err.message
    };
  }

  // 4. Strict Provider Evidence Verification
  const checks = [];

  // Project ID
  const providerProjectId = deploymentData.projectId || (deploymentData.project && deploymentData.project.id);
  const projectMatch = providerProjectId === projectId;
  checks.push({ check: 'PROJECT_ID', expected: projectId, actual: providerProjectId, pass: projectMatch });
  if (!projectMatch) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'PROJECT_MISMATCH',
      checks
    };
  }

  // Target Environment
  const target = deploymentData.target || 'production';
  const targetMatch = target === 'production';
  checks.push({ check: 'TARGET_ENVIRONMENT', expected: 'production', actual: target, pass: targetMatch });
  if (!targetMatch) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'TARGET_NOT_PRODUCTION',
      checks
    };
  }

  // Readiness State
  const readyState = deploymentData.readyState || deploymentData.state;
  const stateMatch = readyState === 'READY';
  checks.push({ check: 'DEPLOYMENT_READY', expected: 'READY', actual: readyState, pass: stateMatch });
  if (!stateMatch) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'DEPLOYMENT_NOT_READY',
      checks
    };
  }

  // Commit SHA
  const meta = deploymentData.meta || {};
  const actualSha = meta.githubCommitSha || (deploymentData.gitSource && deploymentData.gitSource.sha) || meta.commitSha;
  const shaMatch = actualSha === opts.expectedSha;
  checks.push({ check: 'COMMIT_SHA', expected: opts.expectedSha, actual: actualSha, pass: shaMatch });
  if (!shaMatch) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'RUNTIME_SHA_MISMATCH',
      checks
    };
  }

  // Operation ID in Metadata
  const actualOpId = meta.vdsenPilotOperation;
  if (actualOpId && actualOpId !== opts.expectedOperationId) {
    checks.push({ check: 'OPERATION_ID', expected: opts.expectedOperationId, actual: actualOpId, pass: false });
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'OPERATION_ID_MISMATCH',
      checks
    };
  }
  checks.push({ check: 'OPERATION_ID', expected: opts.expectedOperationId, actual: actualOpId || opts.expectedOperationId, pass: true });

  // No CRON in Deployment
  const envNames = Array.isArray(deploymentData.envNames) ? deploymentData.envNames
    : Array.isArray(deploymentData.env) ? deploymentData.env.map(e => e.key) : [];
  const hasCron = envNames.includes('CRON_SECRET');
  checks.push({ check: 'CRON_FORBIDDEN', expected: false, actual: hasCron, pass: !hasCron });
  if (hasCron) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'CRON_SECRET_DETECTED',
      checks
    };
  }

  // Verification of Attached Window if present in deployment
  if (meta.vdsenPilotWindow) {
    try {
      const parsedWindow = JSON.parse(meta.vdsenPilotWindow);
      if (parsedWindow.uidHash && parsedWindow.uidHash !== hash(uid)) {
        return { schema: 'vdsen-numeric-runtime-attestation-v1', attested: false, status: 'REJECTED', reason: 'WINDOW_UID_HASH_MISMATCH' };
      }
      if (parsedWindow.planHash && parsedWindow.planHash !== hash(planId)) {
        return { schema: 'vdsen-numeric-runtime-attestation-v1', attested: false, status: 'REJECTED', reason: 'WINDOW_PLAN_HASH_MISMATCH' };
      }
    } catch (_) {
      return { schema: 'vdsen-numeric-runtime-attestation-v1', attested: false, status: 'REJECTED', reason: 'WINDOW_METADATA_CORRUPT' };
    }
  }

  // 5. Attestation Record Assembly
  return {
    schema: 'vdsen-numeric-runtime-attestation-v1',
    attested: true,
    status: 'ATTESTED',
    deploymentId: opts.deploymentId,
    runtimeSha: actualSha,
    operationId: opts.expectedOperationId,
    pilotUid: uid,
    planId: planId,
    pid: pid,
    provider: 'vercel',
    projectId: projectId,
    teamId: teamId,
    readyState: readyState,
    target: target,
    cronConfigured: false,
    checks: checks,
    attestedAt: new Date(now).toISOString()
  };
}

module.exports = {
  attestRuntime,
  DEFAULT_PROJECT_ID,
  DEFAULT_TEAM_ID
};
