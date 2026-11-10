'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  fetchDeployment,
  validateControlDeployment,
  verifyLegacyDeploymentRetirement,
  LEGACY_ARMED_DEPLOYMENT,
  diagnose,
} = require('../scripts/release/app-diagnostics.cjs');
const P = require('../scripts/pilot/window-protocol.cjs');

const MOCK_STATE = Object.freeze({
  production_deployment: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
  production_project: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
  vercel_team: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
});

const VALID_CONTROL_BODY = Object.freeze({
  id: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
  projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
  teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
  readyState: 'READY',
  target: 'production',
});

function createMockFetch(responses) {
  let callIndex = 0;
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const current = responses[callIndex];
    callIndex++;
    if (!current) throw new Error('Unexpected extra fetch call to ' + url);
    if (current.error) throw current.error;
    return {
      status: current.status,
      ok: current.status >= 200 && current.status < 300,
      json: async () => current.body || {},
      text: async () => JSON.stringify(current.body || {}),
    };
  };
  fn.calls = calls;
  return fn;
}

test('T730 Contract: legacy armed deployment constant matches window-protocol.cjs', () => {
  assert.equal(LEGACY_ARMED_DEPLOYMENT, P.LEGACY_ARMED_DEPLOYMENT);
  assert.equal(LEGACY_ARMED_DEPLOYMENT, 'dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K');
});

test('T730 Scenario 1: Control 200 + legado 404 + control 200 -> RETIRED_VERIFIED', async () => {
  const mockFetch = createMockFetch([
    { status: 200, body: VALID_CONTROL_BODY },
    { status: 404, body: { error: { code: 'not_found' } } },
    { status: 200, body: VALID_CONTROL_BODY },
  ]);

  const result = await verifyLegacyDeploymentRetirement(MOCK_STATE, 'mock-secret-token-xyz', {
    fetch: mockFetch,
  });

  assert.equal(result.verdict, 'RETIRED_VERIFIED');
  assert.equal(result.legacy_deployment, 'dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K');
  assert.equal(result.control_deployment, 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H');
  assert.equal(result.control_before.status, 200);
  assert.equal(result.control_before.valid, true);
  assert.equal(result.legacy.status, 404);
  assert.equal(result.control_after.status, 200);
  assert.equal(result.control_after.valid, true);

  assert.equal(mockFetch.calls.length, 3);
  assert.ok(mockFetch.calls[0].url.includes('/v13/deployments/dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H'));
  assert.ok(mockFetch.calls[1].url.includes('/v13/deployments/dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K'));
  assert.ok(mockFetch.calls[2].url.includes('/v13/deployments/dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H'));
  for (const c of mockFetch.calls) {
    assert.equal(c.options.method, 'GET');
    assert.ok(c.url.includes('teamId=team_VZc5H7Q1DBIJ3g0mwrSBz1o8'));
    assert.equal(c.options.headers.Authorization, 'Bearer mock-secret-token-xyz');
  }
});

test('T730 Scenario 2: Control 200 + legado 200 + control 200 -> STILL_EXISTS', async () => {
  const mockFetch = createMockFetch([
    { status: 200, body: VALID_CONTROL_BODY },
    {
      status: 200,
      body: {
        id: 'dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K',
        projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
        teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
      },
    },
    { status: 200, body: VALID_CONTROL_BODY },
  ]);

  const result = await verifyLegacyDeploymentRetirement(MOCK_STATE, 'mock-secret-token-xyz', {
    fetch: mockFetch,
  });

  assert.equal(result.verdict, 'STILL_EXISTS');
  assert.equal(result.legacy_deployment, 'dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K');
  assert.equal(result.control_before.status, 200);
  assert.equal(result.legacy.status, 200);
  assert.equal(result.control_after.status, 200);
  assert.equal(mockFetch.calls.length, 3);
});

test('T730 Scenario 3: Control 403 + legado 404 -> UNVERIFIED (Never assumes retirement)', async () => {
  const mockFetch = createMockFetch([
    { status: 403, body: { error: { code: 'forbidden' } } },
    { status: 404, body: { error: { code: 'not_found' } } },
  ]);

  const result = await verifyLegacyDeploymentRetirement(MOCK_STATE, 'mock-secret-token-xyz', {
    fetch: mockFetch,
  });

  assert.equal(result.verdict, 'UNVERIFIED');
  assert.equal(result.reason, 'CONTROL_BEFORE_INVALID');
  assert.equal(result.control_before.status, 403);
  assert.equal(result.control_before.valid, false);
  // Must stop immediately when initial control fails
  assert.equal(mockFetch.calls.length, 1);
});

test('T730 Scenario 4: Control 404 + legado 404 -> UNVERIFIED (Scope/identity failure)', async () => {
  const mockFetch = createMockFetch([
    { status: 404, body: { error: { code: 'not_found' } } },
  ]);

  const result = await verifyLegacyDeploymentRetirement(MOCK_STATE, 'mock-secret-token-xyz', {
    fetch: mockFetch,
  });

  assert.equal(result.verdict, 'UNVERIFIED');
  assert.equal(result.reason, 'CONTROL_BEFORE_INVALID');
  assert.equal(result.control_before.status, 404);
  assert.equal(result.control_before.valid, false);
  assert.equal(mockFetch.calls.length, 1);
});

test('T730 Scenario 5: Error de red o timeout -> UNVERIFIED', async () => {
  const mockFetch = createMockFetch([
    { error: new Error('fetch failed: ETIMEDOUT') },
  ]);

  const result = await verifyLegacyDeploymentRetirement(MOCK_STATE, 'mock-secret-token-xyz', {
    fetch: mockFetch,
  });

  assert.equal(result.verdict, 'UNVERIFIED');
  assert.equal(result.reason, 'CONTROL_BEFORE_INVALID');
  assert.equal(result.control_before.status, 'NETWORK');
  assert.equal(result.control_before.valid, false);
  assert.equal(mockFetch.calls.length, 1);
});

test('T730 Scenario 6: Identidad de proyecto o equipo discordante -> UNVERIFIED', async () => {
  // 6a: Wrong projectId
  const mockFetchWrongProject = createMockFetch([
    {
      status: 200,
      body: {
        id: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
        projectId: 'prj_WRONG_PROJECT_123',
        teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
      },
    },
  ]);
  const resWrongProject = await verifyLegacyDeploymentRetirement(MOCK_STATE, 'mock-secret-token-xyz', {
    fetch: mockFetchWrongProject,
  });
  assert.equal(resWrongProject.verdict, 'UNVERIFIED');
  assert.equal(resWrongProject.reason, 'CONTROL_BEFORE_INVALID');
  assert.equal(mockFetchWrongProject.calls.length, 1);

  // 6b: Wrong teamId
  const mockFetchWrongTeam = createMockFetch([
    {
      status: 200,
      body: {
        id: 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H',
        projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
        teamId: 'team_FOREIGN_TEAM_999',
      },
    },
  ]);
  const resWrongTeam = await verifyLegacyDeploymentRetirement(MOCK_STATE, 'mock-secret-token-xyz', {
    fetch: mockFetchWrongTeam,
  });
  assert.equal(resWrongTeam.verdict, 'UNVERIFIED');
  assert.equal(resWrongTeam.reason, 'CONTROL_BEFORE_INVALID');
  assert.equal(mockFetchWrongTeam.calls.length, 1);

  // 6c: Wrong deployment ID in body
  const mockFetchWrongId = createMockFetch([
    {
      status: 200,
      body: {
        id: 'dpl_DIFFERENT_DEPLOYMENT_ID',
        projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
        teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
      },
    },
  ]);
  const resWrongId = await verifyLegacyDeploymentRetirement(MOCK_STATE, 'mock-secret-token-xyz', {
    fetch: mockFetchWrongId,
  });
  assert.equal(resWrongId.verdict, 'UNVERIFIED');
  assert.equal(resWrongId.reason, 'CONTROL_BEFORE_INVALID');
  assert.equal(mockFetchWrongId.calls.length, 1);
});

test('T730 Scenario 7: Control válido inicialmente, pero inválido al finalizar -> UNVERIFIED', async () => {
  const mockFetch = createMockFetch([
    { status: 200, body: VALID_CONTROL_BODY },
    { status: 404, body: { error: { code: 'not_found' } } },
    { status: 500, body: { error: { code: 'server_error' } } },
  ]);

  const result = await verifyLegacyDeploymentRetirement(MOCK_STATE, 'mock-secret-token-xyz', {
    fetch: mockFetch,
  });

  assert.equal(result.verdict, 'UNVERIFIED');
  assert.equal(result.reason, 'CONTROL_AFTER_INVALID');
  assert.equal(result.control_before.status, 200);
  assert.equal(result.control_before.valid, true);
  assert.equal(result.legacy.status, 404);
  assert.equal(result.control_after.status, 500);
  assert.equal(result.control_after.valid, false);
  assert.equal(mockFetch.calls.length, 3);
});

test('T730 Security: Comprobar ausencia de credenciales en objeto resultado y serialización', async () => {
  const SECRET_TOKEN = 'SUPER_SENSITIVE_VERCEL_TOKEN_99999';
  const mockFetch = createMockFetch([
    { status: 200, body: VALID_CONTROL_BODY },
    { status: 404, body: { error: { code: 'not_found' } } },
    { status: 200, body: VALID_CONTROL_BODY },
  ]);

  const result = await verifyLegacyDeploymentRetirement(MOCK_STATE, SECRET_TOKEN, {
    fetch: mockFetch,
  });

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(SECRET_TOKEN), 'Result object must never contain the token');
  assert.ok(!serialized.includes('Authorization'), 'Result object must never contain Authorization header');
  assert.ok(!serialized.includes('Bearer'), 'Result object must never contain Bearer string');
});

test('T730 Security: Sin token disponible retorna UNVERIFIED sin llamadas de red', async () => {
  const mockFetch = createMockFetch([]);
  const result = await verifyLegacyDeploymentRetirement(MOCK_STATE, '', { fetch: mockFetch });
  assert.equal(result.verdict, 'UNVERIFIED');
  assert.equal(result.reason, 'NO_TOKEN');
  assert.equal(mockFetch.calls.length, 0);
});

test('T730 Security: Rechazo de IDs de deployment arbitrarios o maliciosos', async () => {
  const mockFetch = createMockFetch([]);
  for (const badId of [
    'dpl_foo; rm -rf /',
    '../../etc/passwd',
    'dpl_invalid$char',
    '',
    'not_a_deployment',
    'DPL_UPPERCASE',
  ]) {
    const result = await verifyLegacyDeploymentRetirement(MOCK_STATE, 'token', {
      fetch: mockFetch,
      legacyId: badId,
    });
    assert.equal(result.verdict, 'UNVERIFIED', 'Should reject: ' + badId);
    assert.equal(result.reason, 'INVALID_LEGACY_ID');
  }
  assert.equal(mockFetch.calls.length, 0);
});
