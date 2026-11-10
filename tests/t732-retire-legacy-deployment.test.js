'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  LEGACY_ARMED_DEPLOYMENT,
  PROTECTED_PROD_DEPLOYMENT,
  PROTECTED_ROLLBACK_DEPLOYMENT,
  EXPECTED_PROJECT,
  EXPECTED_TEAM,
  preflight,
  executeSingleDelete,
  verifyPostRetirement,
  retireLegacyDeployment,
} = require('../scripts/release/retire-legacy-deployment.cjs');

const MOCK_STATE = Object.freeze({
  production_deployment: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
  rollback_deployment: 'dpl_AuykDuRaXejkbUzFNjFz6XocNPZt',
  production_project: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
  vercel_team: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
  runtime_sha: 'ec3b30f99d095c90fc8e1d54cf05366a0427205a',
  production_origin: 'https://vdsen-ecosistema.vercel.app',
});

const VALID_PROD_BODY = Object.freeze({
  id: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
  projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
  teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
  meta: { githubCommitSha: 'ec3b30f99d095c90fc8e1d54cf05366a0427205a' },
});

const VALID_ROLLBACK_BODY = Object.freeze({
  id: 'dpl_AuykDuRaXejkbUzFNjFz6XocNPZt',
  projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
  teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
});

const VALID_LEGACY_BODY = Object.freeze({
  id: 'dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K',
  projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
  teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
});

const VALID_ALIAS_BODY = Object.freeze({
  deploymentId: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
});

function createMockFetch(router) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const res = router(url, options, calls.length);
    if (!res) throw new Error('Unmatched fetch route for ' + (options && options.method || 'GET') + ' ' + url);
    if (res.error) throw res.error;
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      json: async () => res.body || {},
      text: async () => JSON.stringify(res.body || {}),
    };
  };
  fn.calls = calls;
  return fn;
}

test('T732 Invariants: constants and identifiers match immutable requirements', () => {
  assert.equal(LEGACY_ARMED_DEPLOYMENT, 'dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K');
  assert.equal(PROTECTED_PROD_DEPLOYMENT, 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H');
  assert.equal(PROTECTED_ROLLBACK_DEPLOYMENT, 'dpl_AuykDuRaXejkbUzFNjFz6XocNPZt');
  assert.equal(EXPECTED_PROJECT, 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN');
  assert.equal(EXPECTED_TEAM, 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8');
});

test('T732 Preflight: passes when production, rollback, legacy and alias check are valid', async () => {
  const mockFetch = createMockFetch((url, opts) => {
    if (url.includes(PROTECTED_PROD_DEPLOYMENT)) return { status: 200, body: VALID_PROD_BODY };
    if (url.includes(PROTECTED_ROLLBACK_DEPLOYMENT)) return { status: 200, body: VALID_ROLLBACK_BODY };
    if (url.includes(LEGACY_ARMED_DEPLOYMENT)) return { status: 200, body: VALID_LEGACY_BODY };
    if (url.includes('/v4/aliases/')) return { status: 200, body: VALID_ALIAS_BODY };
    return null;
  });

  const res = await preflight(MOCK_STATE, 'mock-token', LEGACY_ARMED_DEPLOYMENT, { fetch: mockFetch });
  assert.equal(res.ok, true);
  assert.equal(res.prodCheck.status, 200);
  assert.equal(res.rollbackCheck.status, 200);
  assert.equal(res.legacyCheck.status, 200);
});

test('T732 Preflight: blocks if target is already 404 (already retired)', async () => {
  const mockFetch = createMockFetch((url) => {
    if (url.includes(PROTECTED_PROD_DEPLOYMENT)) return { status: 200, body: VALID_PROD_BODY };
    if (url.includes(PROTECTED_ROLLBACK_DEPLOYMENT)) return { status: 200, body: VALID_ROLLBACK_BODY };
    if (url.includes(LEGACY_ARMED_DEPLOYMENT)) return { status: 404, body: { error: 'not_found' } };
    return null;
  });

  const res = await preflight(MOCK_STATE, 'mock-token', LEGACY_ARMED_DEPLOYMENT, { fetch: mockFetch });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'LEGACY_ALREADY_RETIRED');
});

test('T732 Preflight: blocks if production deployment fails (HTTP 403 / 500 / mismatch)', async () => {
  const mockFetch = createMockFetch((url) => {
    if (url.includes(PROTECTED_PROD_DEPLOYMENT)) return { status: 403 };
    return null;
  });

  const res = await preflight(MOCK_STATE, 'mock-token', LEGACY_ARMED_DEPLOYMENT, { fetch: mockFetch });
  assert.equal(res.ok, false);
  assert.ok(res.reason.includes('PROD_DEPLOYMENT_HTTP_403'));
});

test('T732 Preflight: blocks if rollback deployment fails', async () => {
  const mockFetch = createMockFetch((url) => {
    if (url.includes(PROTECTED_PROD_DEPLOYMENT)) return { status: 200, body: VALID_PROD_BODY };
    if (url.includes(PROTECTED_ROLLBACK_DEPLOYMENT)) return { status: 404 };
    return null;
  });

  const res = await preflight(MOCK_STATE, 'mock-token', LEGACY_ARMED_DEPLOYMENT, { fetch: mockFetch });
  assert.equal(res.ok, false);
  assert.ok(res.reason.includes('ROLLBACK_DEPLOYMENT_HTTP_404'));
});

test('T732 Preflight: blocks if legacy deployment is pointed by active production alias', async () => {
  const mockFetch = createMockFetch((url) => {
    if (url.includes(PROTECTED_PROD_DEPLOYMENT)) return { status: 200, body: VALID_PROD_BODY };
    if (url.includes(PROTECTED_ROLLBACK_DEPLOYMENT)) return { status: 200, body: VALID_ROLLBACK_BODY };
    if (url.includes(LEGACY_ARMED_DEPLOYMENT)) return { status: 200, body: VALID_LEGACY_BODY };
    if (url.includes('/v4/aliases/')) return { status: 200, body: { deploymentId: LEGACY_ARMED_DEPLOYMENT } };
    return null;
  });

  const res = await preflight(MOCK_STATE, 'mock-token', LEGACY_ARMED_DEPLOYMENT, { fetch: mockFetch });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'LEGACY_DEPLOYMENT_HAS_ACTIVE_PRODUCTION_ALIAS');
});

test('T732 Security: executeSingleDelete prohibits deleting protected baselines or unauthorized IDs', async () => {
  await assert.rejects(
    () => executeSingleDelete(PROTECTED_PROD_DEPLOYMENT, MOCK_STATE, 'token'),
    /SECURITY_VIOLATION.*dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H/
  );
  await assert.rejects(
    () => executeSingleDelete(PROTECTED_ROLLBACK_DEPLOYMENT, MOCK_STATE, 'token'),
    /SECURITY_VIOLATION.*dpl_AuykDuRaXejkbUzFNjFz6XocNPZt/
  );
  await assert.rejects(
    () => executeSingleDelete('dpl_arbitrary_xyz', MOCK_STATE, 'token'),
    /SECURITY_VIOLATION.*dpl_arbitrary_xyz/
  );
});

test('T732 Full Flow: successful preflight + single DELETE + post-verification -> LEGACY_RETIRED_VERIFIED', async () => {
  let isDeleted = false;
  const mockFetch = createMockFetch((url, opts) => {
    if (opts && opts.method === 'DELETE') {
      if (url.includes(LEGACY_ARMED_DEPLOYMENT)) {
        isDeleted = true;
        return { status: 200, body: { state: 'DELETED' } };
      }
      return { status: 400 };
    }
    // GET requests
    if (url.includes(PROTECTED_PROD_DEPLOYMENT)) return { status: 200, body: VALID_PROD_BODY };
    if (url.includes(PROTECTED_ROLLBACK_DEPLOYMENT)) return { status: 200, body: VALID_ROLLBACK_BODY };
    if (url.includes(LEGACY_ARMED_DEPLOYMENT)) {
      if (isDeleted) return { status: 404, body: { error: 'not_found' } };
      return { status: 200, body: VALID_LEGACY_BODY };
    }
    if (url.includes('/v4/aliases/')) return { status: 200, body: VALID_ALIAS_BODY };
    return null;
  });

  const result = await retireLegacyDeployment(MOCK_STATE, 'mock-secret-token', {
    fetch: mockFetch,
    targetId: LEGACY_ARMED_DEPLOYMENT,
  });

  assert.equal(result.verdict, 'LEGACY_RETIRED_VERIFIED');
  assert.equal(result.target, LEGACY_ARMED_DEPLOYMENT);
  assert.equal(result.delete_status, 200);
  assert.equal(result.post_verification.control_before.valid, true);
  assert.equal(result.post_verification.rollback_check.valid, true);
  assert.equal(result.post_verification.legacy_check.retired, true);
  assert.equal(result.post_verification.legacy_check.status, 404);
  assert.equal(result.post_verification.control_after.valid, true);

  // Exactly one DELETE was executed
  const deleteCalls = mockFetch.calls.filter(c => c.options && c.options.method === 'DELETE');
  assert.equal(deleteCalls.length, 1);
  assert.ok(deleteCalls[0].url.includes('/v13/deployments/dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K'));
});

test('T732 Full Flow: post-verification returns UNCERTAIN if legacy does not return 404', async () => {
  const mockFetch = createMockFetch((url, opts) => {
    if (opts && opts.method === 'DELETE') {
      return { status: 200, body: { state: 'DELETED' } };
    }
    // GET requests: legacy STILL returns 200 even after delete
    if (url.includes(PROTECTED_PROD_DEPLOYMENT)) return { status: 200, body: VALID_PROD_BODY };
    if (url.includes(PROTECTED_ROLLBACK_DEPLOYMENT)) return { status: 200, body: VALID_ROLLBACK_BODY };
    if (url.includes(LEGACY_ARMED_DEPLOYMENT)) return { status: 200, body: VALID_LEGACY_BODY };
    if (url.includes('/v4/aliases/')) return { status: 200, body: VALID_ALIAS_BODY };
    return null;
  });

  const result = await retireLegacyDeployment(MOCK_STATE, 'mock-secret-token', {
    fetch: mockFetch,
    targetId: LEGACY_ARMED_DEPLOYMENT,
  });

  assert.equal(result.verdict, 'UNCERTAIN');
  assert.equal(result.reason, 'POST_VERIFICATION_FAILED');
  assert.equal(result.post_verification.legacy_check.retired, false);
});

test('T732 Security: result and artifacts never leak token or Authorization header', async () => {
  const SECRET = 'TOP_SECRET_VERCEL_TOKEN_XYZ';
  let isDeleted = false;
  const mockFetch = createMockFetch((url, opts) => {
    if (opts && opts.method === 'DELETE') { isDeleted = true; return { status: 200 }; }
    if (url.includes(PROTECTED_PROD_DEPLOYMENT)) return { status: 200, body: VALID_PROD_BODY };
    if (url.includes(PROTECTED_ROLLBACK_DEPLOYMENT)) return { status: 200, body: VALID_ROLLBACK_BODY };
    if (url.includes(LEGACY_ARMED_DEPLOYMENT)) return isDeleted ? { status: 404 } : { status: 200, body: VALID_LEGACY_BODY };
    if (url.includes('/v4/aliases/')) return { status: 200, body: VALID_ALIAS_BODY };
    return null;
  });

  const result = await retireLegacyDeployment(MOCK_STATE, SECRET, { fetch: mockFetch });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(SECRET), 'Token must never appear in result');
  assert.ok(!serialized.includes('Authorization'), 'Authorization header must not appear');
  assert.ok(!serialized.includes('Bearer'), 'Bearer must not appear');
});

test('T732 Workflow: vdsen-retire-legacy-deployment.yml adheres to strict security standards', () => {
  const wf = fs.readFileSync('.github/workflows/vdsen-retire-legacy-deployment.yml', 'utf8');
  assert.ok(wf.includes('environment: Production'), 'Must use environment Production');
  assert.ok(wf.includes('secrets.VERCEL_TOKEN'), 'Must use VERCEL_TOKEN');
  assert.ok(!wf.includes('credentials_json:'), 'Must not use credentials_json');
  assert.ok(wf.includes('confirm_deployment_id'), 'Must require confirmation input');
  assert.ok(wf.includes('dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K'), 'Must hardcode target confirmation ID');
  assert.ok(!/id-token:\s*write/.test(wf), 'Must not request write permissions');
});
