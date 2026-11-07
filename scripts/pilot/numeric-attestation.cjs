'use strict';
// Independent runtime attestation for VDSEN numeric pilot.
// Queries the provider (Vercel) directly to verify deployment state, commit SHA, project,
// team, operation metadata, and absence of CRON. Reports BLOCKED if provider credentials
// or environment evidence are unavailable.
// Rejects missing, ambiguous, or contradictory provider attributes without heuristics.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../../api/_numericPilotContract');

const DEFAULT_PROJECT_ID = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const DEFAULT_TEAM_ID = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';
const MAX_ATTESTATION_AGE_MS = 15 * 60 * 1000; // 15 minutes max validity

// Trusted Attestation Registry (in-process memory boundary)
// NOTE: WeakSet and WeakMap provide in-process isolation during the lifetime of a single
// Node.js process to guarantee that an attestation passed to reserveOperation() was genuinely
// produced by attestRuntime(). They DO NOT provide cross-process or durable persistent storage;
// cross-process and post-restart uniqueness is enforced durably by Firestore document keys
// under releaseControl/numericPilot/operations/{operationId}.
// The fingerprint is a SHA-256 digest for in-memory tamper detection, NOT an asymmetric
// cryptographic signature.
const _trustedAttestations = new WeakSet();
const _attestationRecords = new WeakMap();
const _consumedAttestationIds = new Set();

function isProductionTarget() {
  const gcp = process.env.GCP_PROJECT_ID;
  const gcloud = process.env.GCLOUD_PROJECT;
  const googleCloud = process.env.GOOGLE_CLOUD_PROJECT;
  const isProdProject = gcp === 'vdsen-ecosistema' || gcloud === 'vdsen-ecosistema' || googleCloud === 'vdsen-ecosistema';
  const isProdEnv = process.env.NODE_ENV === 'production' || process.env.GITHUB_ENVIRONMENT === 'Production';
  return Boolean(isProdProject || isProdEnv);
}

function isLiveTarget() {
  if (isProductionTarget()) return true;
  const gcp = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
  if (gcp && gcp !== 'undefined' && !gcp.startsWith('demo-')) {
    // Non-demo cloud project configured (e.g. staging or real GCP project)
    return true;
  }
  return false;
}

function isAccreditedDemoEnvironment(db = null) {
  if (isLiveTarget()) return false;
  if (isProductionTarget()) return false;
  const emuHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (!emuHost || typeof emuHost !== 'string' || emuHost.trim().length === 0) return false;
  const hostTrimmed = emuHost.trim();
  if (!/^((127\.0\.0\.1)|(localhost)|(0\.0\.0\.0)):[0-9]+$/.test(hostTrimmed)) {
    return false;
  }
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || '';
  if (typeof project !== 'string' || project === '' || project === 'undefined' || !project.startsWith('demo-')) {
    return false;
  }
  // Validate Firestore adapter isolation when db instance is supplied
  if (db && typeof db === 'object') {
    if (db._settings && db._settings.host) {
      const dbHost = db._settings.host;
      if (!dbHost.includes('127.0.0.1') && !dbHost.includes('localhost') && !dbHost.includes('0.0.0.0')) {
        return false;
      }
    }
    if (db.formattedName && db.formattedName.includes('vdsen-ecosistema') && !db.formattedName.includes('demo-')) {
      return false;
    }
  }
  return true;
}

function sealAttestation(record) {
  if (!record || typeof record !== 'object') return;
  _trustedAttestations.add(record);
  _attestationRecords.set(record, {
    operationId: record.operationId,
    runtimeSha: record.runtimeSha,
    deploymentId: record.deploymentId,
    attestedAt: record.attestedAt,
    fingerprint: hash(`${record.operationId}:${record.runtimeSha}:${record.deploymentId}:${record.attestedAt}`)
  });
  Object.freeze(record);
}

function verifyAttestationAuthenticity(record, checkNow = null) {
  if (!record || typeof record !== 'object') {
    return { valid: false, reason: 'ATTESTATION_MISSING', message: 'Attestation record must be an object' };
  }
  if (!_trustedAttestations.has(record)) {
    return {
      valid: false,
      reason: 'ATTESTATION_UNVERIFIED_SOURCE',
      message: 'Attestation record was not produced by an accredited attestRuntime() execution; caller-supplied objects are strictly rejected'
    };
  }
  const sealed = _attestationRecords.get(record);
  if (!sealed) {
    return { valid: false, reason: 'ATTESTATION_UNTRUSTED', message: 'Attestation record lacks sealed provenance metadata' };
  }
  if (_consumedAttestationIds.has(record.operationId)) {
    return { valid: false, reason: 'ATTESTATION_ALREADY_CONSUMED', message: `Attestation for operation "${record.operationId}" was already consumed` };
  }
  const currentTime = (typeof checkNow === 'number' && Number.isFinite(checkNow))
    ? checkNow
    : (typeof checkNow === 'string' && Number.isFinite(Date.parse(checkNow)) ? Date.parse(checkNow) : Date.now());
  const age = currentTime - Date.parse(record.attestedAt);
  if (age < 0 || age > MAX_ATTESTATION_AGE_MS) {
    return { valid: false, reason: 'ATTESTATION_EXPIRED', message: `Attestation record expired (age: ${(age / 1000).toFixed(1)}s, max: 900s)` };
  }
  const currentFingerprint = hash(`${record.operationId}:${record.runtimeSha}:${record.deploymentId}:${record.attestedAt}`);
  if (currentFingerprint !== sealed.fingerprint ||
      record.operationId !== sealed.operationId ||
      record.runtimeSha !== sealed.runtimeSha ||
      record.deploymentId !== sealed.deploymentId) {
    return { valid: false, reason: 'ATTESTATION_TAMPERED', message: 'Attestation record properties do not match the sealed provider record' };
  }
  return { valid: true };
}

function consumeAttestation(record) {
  if (record && record.operationId) {
    _consumedAttestationIds.add(record.operationId);
  }
}

function _clearConsumedAttestationsForTesting() {
  if (isAccreditedDemoEnvironment()) {
    _consumedAttestationIds.clear();
  }
}

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
 * @param {string} [opts.expectedAlias] - Expected production alias domain
 * @param {string} [opts.aliasTargetDeployment] - Current live deployment serving the alias
 * @param {string} [opts.vercelToken] - Vercel API token
 * @param {string} [opts.projectId] - Expected Vercel project ID
 * @param {string} [opts.teamId] - Expected Vercel team ID
 * @param {number} [opts.now] - Current epoch millis
 * @param {Function} [opts.fetcher] - Custom fetch implementation for isolation/mocking
 * @returns {Promise<object>} Attestation record
 */
async function attestRuntime(opts) {
  opts = opts || {};
  // P0 Mock/Clock Provider Boundary: Custom fetcher or injected clock are ONLY permitted
  // when isAccreditedDemoEnvironment() is unequivocally true. In ANY other context, reject.
  if (opts.fetcher && !isAccreditedDemoEnvironment()) {
    throw new Error('PROVIDER_INJECTION_REJECTED: Custom fetcher injection is strictly forbidden outside an accredited demo emulator environment');
  }
  const hasInjectedClock = opts.now !== undefined || opts.dynamicClock !== undefined || opts.clock !== undefined || opts.currentTime !== undefined;
  if (hasInjectedClock && !isAccreditedDemoEnvironment()) {
    throw new Error('CLOCK_TAMPERING_REJECTED: External clock injection is strictly forbidden outside an accredited demo emulator environment');
  }
  if (opts.dynamicClock || opts.clock || opts.currentTime) {
    throw new Error('CLOCK_TAMPERING_REJECTED: Unauthorized temporal option key rejected');
  }
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

  if (!opts.expectedAlias || typeof opts.expectedAlias !== 'string') {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'BLOCKED',
      reason: 'ALIAS_EVIDENCE_MISSING',
      message: 'Expected production alias domain is mandatory for operational attestation.'
    };
  }

  if (!opts.deploymentId || (!/^dpl_[A-Za-z0-9_]+$/.test(opts.deploymentId) && !/^demo-dpl-[A-Za-z0-9-]+$/.test(opts.deploymentId))) {
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

  // 4. Strict Provider Evidence Verification (No Defaults, No Loose Fallbacks)
  const checks = [];

  // Deployment ID Verification
  if (!deploymentData || typeof deploymentData !== 'object' || !deploymentData.id) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'DEPLOYMENT_ID_MISSING',
      message: 'Provider response did not contain a deployment ID.'
    };
  }
  if (deploymentData.id !== opts.deploymentId) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'DEPLOYMENT_ID_MISMATCH',
      expected: opts.deploymentId,
      actual: deploymentData.id
    };
  }
  checks.push({ check: 'DEPLOYMENT_ID', expected: opts.deploymentId, actual: deploymentData.id, pass: true });

  // Project ID (must be explicitly provided by Vercel response)
  const providerProjectId = deploymentData.projectId || (deploymentData.project && deploymentData.project.id);
  if (!providerProjectId) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'PROJECT_ID_MISSING',
      message: 'Provider deployment response lacks projectId.'
    };
  }
  if (providerProjectId !== projectId) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'PROJECT_MISMATCH',
      expected: projectId,
      actual: providerProjectId
    };
  }
  checks.push({ check: 'PROJECT_ID', expected: projectId, actual: providerProjectId, pass: true });

  // Team ID (must be explicitly provided by Vercel response)
  const providerTeamId = deploymentData.teamId || (deploymentData.team && deploymentData.team.id);
  if (!providerTeamId) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'TEAM_ID_MISSING',
      message: 'Provider deployment response lacks teamId.'
    };
  }
  if (providerTeamId !== teamId) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'TEAM_MISMATCH',
      expected: teamId,
      actual: providerTeamId
    };
  }
  checks.push({ check: 'TEAM_ID', expected: teamId, actual: providerTeamId, pass: true });

  // Target Environment (must be explicitly provided; no defaulting)
  if (!deploymentData.target) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'TARGET_MISSING',
      message: 'Provider deployment response lacks target environment.'
    };
  }
  if (deploymentData.target !== 'production') {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'TARGET_NOT_PRODUCTION',
      expected: 'production',
      actual: deploymentData.target
    };
  }
  checks.push({ check: 'TARGET_ENVIRONMENT', expected: 'production', actual: deploymentData.target, pass: true });

  // Readiness State (must be explicitly provided)
  const readyState = deploymentData.readyState || deploymentData.state;
  if (!readyState) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'DEPLOYMENT_STATE_MISSING',
      message: 'Provider deployment response lacks readyState/state.'
    };
  }
  if (readyState !== 'READY') {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'DEPLOYMENT_NOT_READY',
      expected: 'READY',
      actual: readyState
    };
  }
  checks.push({ check: 'DEPLOYMENT_READY', expected: 'READY', actual: readyState, pass: true });

  // Commit SHA (must be explicitly present)
  const meta = deploymentData.meta || {};
  const actualSha = meta.githubCommitSha || (deploymentData.gitSource && deploymentData.gitSource.sha) || meta.commitSha;
  if (!actualSha) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'COMMIT_SHA_MISSING',
      message: 'Provider deployment response lacks commit SHA evidence.'
    };
  }
  if (actualSha !== opts.expectedSha) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'RUNTIME_SHA_MISMATCH',
      expected: opts.expectedSha,
      actual: actualSha
    };
  }
  checks.push({ check: 'COMMIT_SHA', expected: opts.expectedSha, actual: actualSha, pass: true });

  // Operation ID in Metadata (MANDATORY: cannot be absent)
  const actualOpId = meta.vdsenPilotOperation;
  if (!actualOpId) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'OPERATION_METADATA_MISSING',
      message: 'Deployment lacks vdsenPilotOperation metadata; absence cannot be accepted as valid.'
    };
  }
  if (actualOpId !== opts.expectedOperationId) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'OPERATION_ID_MISMATCH',
      expected: opts.expectedOperationId,
      actual: actualOpId
    };
  }
  checks.push({ check: 'OPERATION_ID', expected: opts.expectedOperationId, actual: actualOpId, pass: true });

  // Environment Variables Evidence for CRON_SECRET absence
  const hasEnvNames = Array.isArray(deploymentData.envNames);
  const hasEnvList = Array.isArray(deploymentData.env);
  if (!hasEnvNames && !hasEnvList) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'BLOCKED',
      reason: 'ENV_EVIDENCE_MISSING',
      message: 'Provider response does not contain envNames or env array; cannot verify absence of CRON_SECRET.'
    };
  }

  const envKeys = hasEnvNames ? deploymentData.envNames : deploymentData.env.map(e => e && e.key);
  const hasCron = envKeys.includes('CRON_SECRET');
  if (hasCron) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'CRON_SECRET_DETECTED',
      message: 'CRON_SECRET detected in deployment variables; numeric pilot strictly forbids CRON.'
    };
  }
  checks.push({ check: 'CRON_FORBIDDEN', expected: false, actual: hasCron, pass: true });

  // Target Alias Correspondence (MANDATORY)
  const rawAliases = deploymentData.alias !== undefined ? deploymentData.alias : deploymentData.aliases;
  if (!rawAliases && !deploymentData.url) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'BLOCKED',
      reason: 'ALIAS_EVIDENCE_INSUFFICIENT',
      message: 'Provider deployment response lacks alias evidence (no alias or aliases list).'
    };
  }

  const aliases = Array.isArray(deploymentData.alias) ? deploymentData.alias
    : (Array.isArray(deploymentData.aliases) ? deploymentData.aliases
    : (deploymentData.url ? [deploymentData.url] : []));

  const aliasMatched = aliases.includes(opts.expectedAlias) || deploymentData.url === opts.expectedAlias;
  if (!aliasMatched) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'ALIAS_MISMATCH',
      expected: opts.expectedAlias,
      actual: aliases,
      message: 'Deployment does not correspond to expected target alias.'
    };
  }
  checks.push({ check: 'ALIAS_CORRESPONDENCE', expected: opts.expectedAlias, actual: aliases, pass: true });

  if (opts.aliasTargetDeployment && opts.aliasTargetDeployment !== deploymentData.id) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'ALIAS_TARGET_DEPLOYMENT_MISMATCH',
      expected: opts.aliasTargetDeployment,
      actual: deploymentData.id,
      message: 'Target alias points to a different deployment than requested.'
    };
  }

  // Step 4b: Independent Live Alias Destination Verification
  // The presence of an alias in the deployment response does not prove it currently resolves there.
  // Query Vercel's official alias endpoint: GET /v2/aliases/:alias?teamId=:teamId
  let aliasData;
  try {
    const aliasUrl = 'https://api.vercel.com/v2/aliases/' + encodeURIComponent(opts.expectedAlias) + '?teamId=' + teamId;
    const aliasRes = await fetchFn(aliasUrl, {
      headers: {
        authorization: 'Bearer ' + token,
        'user-agent': 'vdsen-numeric-attestation/1.0'
      },
      redirect: 'error'
    });

    if (aliasRes.status === 401 || aliasRes.status === 403) {
      return {
        schema: 'vdsen-numeric-runtime-attestation-v1',
        attested: false,
        status: 'BLOCKED',
        reason: 'ALIAS_PROVIDER_AUTH_FAILED',
        httpStatus: aliasRes.status,
        message: 'Provider denied permission to resolve live alias target (GET /v2/aliases/:alias). Required permission or credential missing.'
      };
    }

    if (aliasRes.status === 404) {
      return {
        schema: 'vdsen-numeric-runtime-attestation-v1',
        attested: false,
        status: 'BLOCKED',
        reason: 'ALIAS_DESTINATION_UNKNOWN',
        message: 'Live alias "' + opts.expectedAlias + '" was not found in provider project; destination is unknown.'
      };
    }

    if (aliasRes.status !== 200) {
      return {
        schema: 'vdsen-numeric-runtime-attestation-v1',
        attested: false,
        status: 'BLOCKED',
        reason: 'ALIAS_PROVIDER_ERROR',
        httpStatus: aliasRes.status,
        message: 'Provider returned HTTP ' + aliasRes.status + ' when querying live alias target.'
      };
    }

    aliasData = await aliasRes.json();
  } catch (err) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'BLOCKED',
      reason: 'ALIAS_QUERY_PROVIDER_ERROR',
      message: 'Failed to query provider live alias: ' + err.message
    };
  }

  if (!aliasData || typeof aliasData !== 'object') {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'BLOCKED',
      reason: 'ALIAS_CONTRADICTORY_EVIDENCE',
      message: 'Provider returned non-object alias data.'
    };
  }

  const liveTargetDeploymentId = aliasData.deploymentId || (aliasData.deployment && aliasData.deployment.id);
  if (!liveTargetDeploymentId) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'BLOCKED',
      reason: 'ALIAS_DESTINATION_UNKNOWN',
      message: 'Provider alias record lacks target deploymentId; effective destination cannot be determined.'
    };
  }

  if (aliasData.alias && aliasData.alias !== opts.expectedAlias) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'BLOCKED',
      reason: 'ALIAS_CONTRADICTORY_EVIDENCE',
      expected: opts.expectedAlias,
      actual: aliasData.alias,
      message: 'Provider alias query returned conflicting alias name.'
    };
  }

  if (liveTargetDeploymentId !== opts.deploymentId) {
    return {
      schema: 'vdsen-numeric-runtime-attestation-v1',
      attested: false,
      status: 'REJECTED',
      reason: 'ALIAS_LIVE_TARGET_MISMATCH',
      expectedDeployment: opts.deploymentId,
      actualTargetDeployment: liveTargetDeploymentId,
      message: 'Live alias "' + opts.expectedAlias + '" currently routes to deployment "' + liveTargetDeploymentId + '", not candidate "' + opts.deploymentId + '".'
    };
  }

  checks.push({
    check: 'ALIAS_LIVE_TARGET_CORRESPONDENCE',
    expectedDeployment: opts.deploymentId,
    actualTargetDeployment: liveTargetDeploymentId,
    alias: opts.expectedAlias,
    pass: true
  });

  // Window Hashes Validation in Metadata (if present)
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
  const record = {
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
    target: deploymentData.target,
    cronConfigured: false,
    checks: checks,
    attestedAt: new Date(now).toISOString()
  };

  sealAttestation(record);
  return record;
}

module.exports = {
  attestRuntime,
  verifyAttestationAuthenticity,
  consumeAttestation,
  _clearConsumedAttestationsForTesting,
  isProductionTarget,
  isLiveTarget,
  isAccreditedDemoEnvironment,
  DEFAULT_PROJECT_ID,
  DEFAULT_TEAM_ID,
  MAX_ATTESTATION_AGE_MS
};
