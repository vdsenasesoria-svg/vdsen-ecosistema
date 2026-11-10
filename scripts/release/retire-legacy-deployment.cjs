'use strict';
// Controlled retirement of the legacy armed deployment (T732).
//
// Strictly deletes exactly ONE single deployment (dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K)
// after exhaustive preflight of production and rollback baselines, followed by
// authoritative post-verification.
//
// Safety:
//   - never prints a token, Authorization header, or sensitive response body
//   - exactly one single DELETE request; never retried on uncertainty
//   - fails closed on any preflight failure, identity mismatch, or missing fence verification
const fs = require('node:fs');
const path = require('node:path');
const { json } = require('./lib.cjs');
const P = require('../pilot/window-protocol.cjs');

const LEGACY_ARMED_DEPLOYMENT = P.LEGACY_ARMED_DEPLOYMENT; // 'dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K'
const PROTECTED_PROD_DEPLOYMENT = 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H';
const PROTECTED_ROLLBACK_DEPLOYMENT = 'dpl_AuykDuRaXejkbUzFNjFz6XocNPZt';
const EXPECTED_PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const EXPECTED_TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';

function state() { return json('.release/vdsen-client.json'); }

function deploymentUrl(deploymentId, s) {
  return 'https://api.vercel.com/v13/deployments/' + encodeURIComponent(deploymentId) + '?teamId=' + encodeURIComponent(s.vercel_team);
}

function aliasUrl(hostname, s) {
  return 'https://api.vercel.com/v4/aliases/' + encodeURIComponent(hostname) + '?teamId=' + encodeURIComponent(s.vercel_team);
}

async function requestDeployment(deploymentId, s, token, customFetch = fetch) {
  if (!deploymentId || typeof deploymentId !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) {
    return { status: 'INVALID_ID', ok: false, error: 'Invalid deployment ID format' };
  }
  const url = deploymentUrl(deploymentId, s);
  try {
    const r = await customFetch(url, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (r.status === 200) {
      let data = null;
      try {
        if (typeof r.json === 'function') data = await r.json();
        else if (typeof r.text === 'function') data = JSON.parse(await r.text());
      } catch (e) {
        return { status: 'INVALID_JSON', ok: false };
      }
      return { status: 200, ok: true, data };
    }
    return { status: r.status, ok: false };
  } catch (err) {
    return { status: 'NETWORK', ok: false, error: (err && err.message ? err.message : String(err)).slice(0, 120) };
  }
}

async function requestAlias(hostname, s, token, customFetch = fetch) {
  const url = aliasUrl(hostname, s);
  try {
    const r = await customFetch(url, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (r.status === 200) {
      let data = null;
      try {
        if (typeof r.json === 'function') data = await r.json();
        else if (typeof r.text === 'function') data = JSON.parse(await r.text());
      } catch (e) {
        return { status: 'INVALID_JSON', ok: false };
      }
      return { status: 200, ok: true, data };
    }
    return { status: r.status, ok: false };
  } catch (err) {
    return { status: 'NETWORK', ok: false, error: (err && err.message ? err.message : String(err)).slice(0, 120) };
  }
}

async function executeSingleDelete(deploymentId, s, token, customFetch = fetch) {
  // Hard invariant: never delete production or rollback baselines
  if (deploymentId === PROTECTED_PROD_DEPLOYMENT || deploymentId === PROTECTED_ROLLBACK_DEPLOYMENT) {
    throw new Error('SECURITY_VIOLATION: Attempted to delete protected baseline deployment ' + deploymentId);
  }
  if (deploymentId !== LEGACY_ARMED_DEPLOYMENT) {
    throw new Error('SECURITY_VIOLATION: Attempted to delete unauthorized deployment ' + deploymentId);
  }

  const url = deploymentUrl(deploymentId, s);
  try {
    const r = await customFetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer ' + token,
      },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    return { status: r.status, ok: r.status === 200 || r.status === 204 };
  } catch (err) {
    return { status: 'NETWORK', ok: false, error: (err && err.message ? err.message : String(err)).slice(0, 120) };
  }
}

async function preflight(s, token, targetId, opts = {}) {
  const customFetch = opts.fetch || fetch;

  // 1. Contract checks
  if (targetId !== LEGACY_ARMED_DEPLOYMENT) {
    return { ok: false, reason: 'TARGET_NOT_LEGACY_ARMED_DEPLOYMENT' };
  }
  if (s.production_deployment !== PROTECTED_PROD_DEPLOYMENT) {
    return { ok: false, reason: 'PRODUCTION_DEPLOYMENT_MISMATCH' };
  }
  if (s.rollback_deployment !== PROTECTED_ROLLBACK_DEPLOYMENT) {
    return { ok: false, reason: 'ROLLBACK_DEPLOYMENT_MISMATCH' };
  }
  if (s.production_project !== EXPECTED_PROJECT || s.vercel_team !== EXPECTED_TEAM) {
    return { ok: false, reason: 'PROJECT_OR_TEAM_MISMATCH' };
  }

  // 2. Production current check: HTTP 200, project, team, SHA
  const prodCheck = await requestDeployment(s.production_deployment, s, token, customFetch);
  if (!prodCheck.ok || prodCheck.status !== 200) {
    return { ok: false, reason: 'PROD_DEPLOYMENT_HTTP_' + prodCheck.status, detail: prodCheck };
  }
  const prodData = prodCheck.data || {};
  const prodId = prodData.id || prodData.uid;
  const prodProject = prodData.projectId;
  const prodTeam = prodData.teamId || prodData.ownerId;
  const prodSha = prodData.meta && prodData.meta.githubCommitSha;
  if (prodId !== s.production_deployment || prodProject !== s.production_project || prodTeam !== s.vercel_team) {
    return { ok: false, reason: 'PROD_DEPLOYMENT_IDENTITY_MISMATCH' };
  }
  if (prodSha && prodSha !== s.runtime_sha) {
    return { ok: false, reason: 'PROD_DEPLOYMENT_SHA_MISMATCH' };
  }

  // 3. Rollback OFF check: HTTP 200, project, team
  const rollbackCheck = await requestDeployment(s.rollback_deployment, s, token, customFetch);
  if (!rollbackCheck.ok || rollbackCheck.status !== 200) {
    return { ok: false, reason: 'ROLLBACK_DEPLOYMENT_HTTP_' + rollbackCheck.status, detail: rollbackCheck };
  }
  const rbData = rollbackCheck.data || {};
  const rbId = rbData.id || rbData.uid;
  const rbProject = rbData.projectId;
  const rbTeam = rbData.teamId || rbData.ownerId;
  if (rbId !== s.rollback_deployment || rbProject !== s.production_project || rbTeam !== s.vercel_team) {
    return { ok: false, reason: 'ROLLBACK_DEPLOYMENT_IDENTITY_MISMATCH' };
  }

  // 4. Legacy deployment check: HTTP 200, project, team
  const legacyCheck = await requestDeployment(targetId, s, token, customFetch);
  if (legacyCheck.status === 404) {
    return { ok: false, reason: 'LEGACY_ALREADY_RETIRED' };
  }
  if (!legacyCheck.ok || legacyCheck.status !== 200) {
    return { ok: false, reason: 'LEGACY_DEPLOYMENT_HTTP_' + legacyCheck.status, detail: legacyCheck };
  }
  const legData = legacyCheck.data || {};
  const legId = legData.id || legData.uid;
  const legProject = legData.projectId;
  const legTeam = legData.teamId || legData.ownerId;
  if (legId !== targetId || legProject !== s.production_project || legTeam !== s.vercel_team) {
    return { ok: false, reason: 'LEGACY_DEPLOYMENT_IDENTITY_MISMATCH' };
  }

  // 5. Active alias check: legacy must not be pointed by production alias
  let aliasHost = '';
  try { aliasHost = new URL(s.production_origin).hostname; } catch (e) { aliasHost = 'vdsen-ecosistema.vercel.app'; }
  const aliasCheck = await requestAlias(aliasHost, s, token, customFetch);
  if (aliasCheck.ok && aliasCheck.data) {
    const aliasDeployment = aliasCheck.data.deploymentId || aliasCheck.data.deployment;
    if (aliasDeployment === targetId) {
      return { ok: false, reason: 'LEGACY_DEPLOYMENT_HAS_ACTIVE_PRODUCTION_ALIAS' };
    }
  }

  return {
    ok: true,
    prodCheck: { status: 200, id: prodId },
    rollbackCheck: { status: 200, id: rbId },
    legacyCheck: { status: 200, id: legId },
  };
}

async function verifyPostRetirement(s, token, targetId, opts = {}) {
  const customFetch = opts.fetch || fetch;

  // 1. Confirm production actual HTTP 200
  const c1 = await requestDeployment(s.production_deployment, s, token, customFetch);
  const c1Valid = c1.status === 200 && (c1.data.id || c1.data.uid) === s.production_deployment;

  // 2. Confirm rollback OFF HTTP 200
  const rb = await requestDeployment(s.rollback_deployment, s, token, customFetch);
  const rbValid = rb.status === 200 && (rb.data.id || rb.data.uid) === s.rollback_deployment;

  // 3. Confirm deployment legado HTTP 404
  const leg = await requestDeployment(targetId, s, token, customFetch);
  const legRetired = leg.status === 404;

  // 4. Confirm production actual HTTP 200 again
  const c2 = await requestDeployment(s.production_deployment, s, token, customFetch);
  const c2Valid = c2.status === 200 && (c2.data.id || c2.data.uid) === s.production_deployment;

  const allPassed = c1Valid && rbValid && legRetired && c2Valid;

  return {
    verified: allPassed,
    control_before: { status: c1.status, valid: c1Valid },
    rollback_check: { status: rb.status, valid: rbValid },
    legacy_check: { status: leg.status, retired: legRetired },
    control_after: { status: c2.status, valid: c2Valid },
  };
}

async function retireLegacyDeployment(s, token, opts = {}) {
  const targetId = opts.targetId || LEGACY_ARMED_DEPLOYMENT;
  const customFetch = opts.fetch || fetch;

  if (!token) {
    return {
      verdict: 'BLOCKED',
      reason: 'NO_VERCEL_TOKEN',
      target: targetId,
    };
  }

  // Preflight
  const pre = await preflight(s, token, targetId, { fetch: customFetch });
  if (!pre.ok) {
    return {
      verdict: 'BLOCKED',
      reason: pre.reason,
      preflight: pre,
      target: targetId,
    };
  }

  // Single DELETE execution
  const del = await executeSingleDelete(targetId, s, token, customFetch);
  if (!del.ok) {
    return {
      verdict: 'UNCERTAIN',
      reason: 'DELETE_REQUEST_FAILED',
      delete_result: del,
      target: targetId,
    };
  }

  // Post-verification
  const post = await verifyPostRetirement(s, token, targetId, { fetch: customFetch });
  if (post.verified) {
    return {
      verdict: 'LEGACY_RETIRED_VERIFIED',
      target: targetId,
      preflight: { status: 'PASS' },
      delete_status: del.status,
      post_verification: post,
    };
  }

  return {
    verdict: 'UNCERTAIN',
    reason: 'POST_VERIFICATION_FAILED',
    target: targetId,
    post_verification: post,
  };
}

async function main() {
  const s = state();
  const token = process.env.VERCEL_TOKEN;
  const inputConfirm = process.env.CONFIRM_DEPLOYMENT_ID || process.argv[2];

  if (inputConfirm !== LEGACY_ARMED_DEPLOYMENT) {
    console.error('ERROR: CONFIRM_DEPLOYMENT_ID must match exactly ' + LEGACY_ARMED_DEPLOYMENT);
    process.exit(1);
  }

  console.log('Initiating controlled retirement of legacy deployment: ' + LEGACY_ARMED_DEPLOYMENT);
  const result = await retireLegacyDeployment(s, token);

  const lines = [
    '## Legacy Armed Deployment Controlled Retirement (T732)',
    '',
    '| Item | Value |',
    '|---|---|',
    '| Target deployment | `' + result.target + '` |',
    '| Verdict | **' + result.verdict + '** |',
    '| Reason | ' + (result.reason || 'SUCCESS') + ' |',
  ];

  if (result.post_verification) {
    lines.push(
      '',
      '### Post-verification checks',
      '',
      '| Check | HTTP Status | Valid / Retired |',
      '|---|---|---|',
      '| Production Control (Pre) | ' + result.post_verification.control_before.status + ' | ' + result.post_verification.control_before.valid + ' |',
      '| Rollback OFF Control | ' + result.post_verification.rollback_check.status + ' | ' + result.post_verification.rollback_check.valid + ' |',
      '| Legacy Deployment (Target) | ' + result.post_verification.legacy_check.status + ' | ' + result.post_verification.legacy_check.retired + ' |',
      '| Production Control (Post) | ' + result.post_verification.control_after.status + ' | ' + result.post_verification.control_after.valid + ' |'
    );
  }

  const summary = lines.join('\n');
  fs.mkdirSync('release-output', { recursive: true });
  fs.writeFileSync('release-output/legacy-retirement.json', JSON.stringify(result, null, 2) + '\n');
  try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n'); } catch (e) {}
  console.log(summary);

  if (result.verdict !== 'LEGACY_RETIRED_VERIFIED') {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL_RETIREMENT_ERROR:', (err && err.message ? err.message : String(err)));
    process.exit(1);
  });
}

module.exports = {
  LEGACY_ARMED_DEPLOYMENT,
  PROTECTED_PROD_DEPLOYMENT,
  PROTECTED_ROLLBACK_DEPLOYMENT,
  EXPECTED_PROJECT,
  EXPECTED_TEAM,
  preflight,
  executeSingleDelete,
  verifyPostRetirement,
  retireLegacyDeployment,
  requestDeployment,
  requestAlias,
};
