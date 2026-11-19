'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDiagnosticCode } = require('../scripts/pilot/ayrton-runtime.cjs');
const { NumericGuardError } = require('../scripts/release/numeric-guard.cjs');
const { runAyrtonPreflightDiagnostics } = require('../scripts/pilot/ayrton-preflight-diagnostics.cjs');

test('classifyDiagnosticCode classifies previously hidden ARM_PREFLIGHT errors deterministically', () => {
  assert.equal(classifyDiagnosticCode(new NumericGuardError('VALUE_NOT_READABLE', 'secret env')), 'VALUE_NOT_READABLE');
  assert.equal(classifyDiagnosticCode(new NumericGuardError('NUMERIC_APPLY_ACTIVE', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED')), 'NUMERIC_APPLY_ACTIVE');
  assert.equal(classifyDiagnosticCode(new Error('LEGACY_RETIREMENT_UNVERIFIED')), 'LEGACY_RETIREMENT_UNVERIFIED');
  assert.equal(classifyDiagnosticCode(new Error('LEGACY_ARMED_DEPLOYMENT_STILL_EXISTS')), 'LEGACY_ARMED_DEPLOYMENT_STILL_EXISTS');
  assert.equal(classifyDiagnosticCode(new Error('MALFORMED_VERCEL_DEPLOYMENTS_RESPONSE')), 'MALFORMED_VERCEL_DEPLOYMENTS_RESPONSE');
  assert.equal(classifyDiagnosticCode(new Error('FOREIGN_OR_MALFORMED_SCOPE')), 'FOREIGN_OR_MALFORMED_SCOPE');
  assert.equal(classifyDiagnosticCode(new Error('API GET /v13/deployments/dpl_123 failed: HTTP 403')), 'VERCEL_API_HTTP_403');
});

test('runAyrtonPreflightDiagnostics runs all checks separately and verifies reconciliation without leaking secrets', async () => {
  const deployedProduct = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.release', 'deployed-product.json'), 'utf8')
  );
  const s = {
    runtime_sha: deployedProduct.runtime_sha,
    production_deployment: 'dpl_8kLZt5zTgAbyvPR9jyoLeb6MsD6C',
    production_project: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
    vercel_team: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
    numeric_apply_enabled: false,
    app_release: { source_release_run: '43992221920', deployment: 'dpl_8kLZt5zTgAbyvPR9jyoLeb6MsD6C' },
  };
  const validDisarmed = {
    schema: 'vdsen-numeric-guard-v1',
    status: 'DISARMED',
    flags: {
      AUTONOMOUS_PROGRESSION_ENABLED: 'PLAIN_FALSE',
      AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'PLAIN_FALSE',
    },
    env_fingerprint: 'a'.repeat(64),
    captured_at: new Date().toISOString(),
  };

  const expectedMainSha =
    process.env.APP_EXPECTED_MAIN_SHA ||
    'bf1b59f33d62e2127b5d5fd969688bff1f7feccf';

  const report = await runAyrtonPreflightDiagnostics({
    state: s,
    ensureBaselineArtifacts: false,
    git: (...args) => {
      if (args[0] === 'show') return 'vdsen-progression-runtime-v1';
      if (args[0] === 'ls-remote') return expectedMainSha + '\trefs/heads/main';
      if (args[0] === 'grep') return 'process.env.AUTONOMOUS_PROGRESSION_ENABLED\nprocess.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED';
      return '';
    },
    assertLegacyRetired: async () => true,
    io: {
      validateBaseline: async () => ({ status: 'OFF_AT_IMMUTABLE_BUILD' }),
      current: async () => s.production_deployment,
      offProof: async () => validDisarmed,
      assertNoPriorOperation: async () => true,
    },
    operationId: 'op-ayrton-shadow-test',
    reconcileCheckRunId: '44005942092',
    gatherReconciliationEvidence: async () => ({
      runId: '44005942092',
      baselineDeployment: s.production_deployment,
      currentAlias: s.production_deployment,
      stagedDeploymentsCount: 0,
      priorRunMutations: 0,
      evidenceVerified: true,
      phaseProven: 'ARM_PREFLIGHT_ZERO_MUTATIONS',
    }),
  });

  assert.equal(report.overall, 'PASS');
  assert.deepEqual(
    report.checks.map(c => [c.check, c.status]),
    [
      ['SOURCE', 'PASS'],
      ['LEGACY', 'PASS'],
      ['BASELINE', 'PASS'],
      ['ALIAS', 'PASS'],
      ['FENCES', 'SKIPPED'],
      ['NUMERIC_GUARD', 'PASS'],
      ['DEPLOYMENTS', 'PASS'],
    ]
  );
  assert.equal(report.reconciliation.admissible, true);
  assert.equal(report.reconciliation.baselineMatchesAlias, true);
});

test('runAyrtonPreflightDiagnostics isolates failing check and maps to safe code', async () => {
  const s = {
    runtime_sha: '076c8c70a276cb80d669d7cd187861756405871f',
    production_deployment: 'dpl_8kLZt5zTgAbyvPR9jyoLeb6MsD6C',
    app_release: { source_release_run: '43992221920', deployment: 'dpl_8kLZt5zTgAbyvPR9jyoLeb6MsD6C' },
  };
  const expectedMainSha =
    process.env.APP_EXPECTED_MAIN_SHA ||
    'bf1b59f33d62e2127b5d5fd969688bff1f7feccf';

  const report = await runAyrtonPreflightDiagnostics({
    state: s,
    ensureBaselineArtifacts: false,
    git: (...args) => {
      if (args[0] === 'show') return 'vdsen-progression-runtime-v1';
      if (args[0] === 'ls-remote') return expectedMainSha + '\trefs/heads/main';
      if (args[0] === 'grep') return 'process.env.AUTONOMOUS_PROGRESSION_ENABLED\nprocess.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED';
      return '';
    },
    assertLegacyRetired: async () => { throw new Error('LEGACY_RETIREMENT_UNVERIFIED'); },
    io: {
      validateBaseline: async () => ({ status: 'OFF_AT_IMMUTABLE_BUILD' }),
      current: async () => s.production_deployment,
      offProof: async () => { throw new NumericGuardError('VALUE_NOT_READABLE', 'secret-token-value'); },
      assertNoPriorOperation: async () => { throw new Error('MALFORMED_VERCEL_DEPLOYMENTS_RESPONSE'); },
    },
  });

  assert.equal(report.overall, 'FAIL');
  const byName = Object.fromEntries(report.checks.map(c => [c.check, c.code]));
  assert.equal(byName.LEGACY, 'LEGACY_RETIREMENT_UNVERIFIED');
  assert.equal(byName.NUMERIC_GUARD, 'VALUE_NOT_READABLE');
  assert.equal(byName.DEPLOYMENTS, 'MALFORMED_VERCEL_DEPLOYMENTS_RESPONSE');
  assert.ok(!JSON.stringify(report).includes('secret-token-value'));
});

test('runAyrtonPreflightDiagnostics rejects main SHA mismatch against APP_EXPECTED_MAIN_SHA', async () => {
  const prevExpected = process.env.APP_EXPECTED_MAIN_SHA;
  process.env.APP_EXPECTED_MAIN_SHA = 'bf1b59f33d62e2127b5d5fd969688bff1f7feccf';
  try {
    const deployedProduct = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '.release', 'deployed-product.json'), 'utf8')
    );
    const s = {
      runtime_sha: deployedProduct.runtime_sha,
      production_deployment: 'dpl_7ByavXXqB8m8SzKtz3W5erWJherU',
      app_release: { source_release_run: '44179647316', deployment: 'dpl_7ByavXXqB8m8SzKtz3W5erWJherU' },
    };
    const report = await runAyrtonPreflightDiagnostics({
      state: s,
      ensureBaselineArtifacts: false,
      git: (...args) => {
        if (args[0] === 'show') return 'vdsen-progression-runtime-v1';
        if (args[0] === 'ls-remote') return '5f25b5b9a3c45b425bad4d8eadd145cf7423aec7\trefs/heads/main';
        if (args[0] === 'grep') return 'process.env.AUTONOMOUS_PROGRESSION_ENABLED\nprocess.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED';
        return '';
      },
      assertLegacyRetired: async () => true,
      io: {
        validateBaseline: async () => ({ status: 'OFF_AT_IMMUTABLE_BUILD' }),
        current: async () => s.production_deployment,
        offProof: async () => ({
          schema: 'vdsen-numeric-guard-v1',
          status: 'DISARMED',
          flags: {
            AUTONOMOUS_PROGRESSION_ENABLED: 'PLAIN_FALSE',
            AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'PLAIN_FALSE',
          },
          env_fingerprint: 'a'.repeat(64),
          captured_at: new Date().toISOString(),
        }),
        assertNoPriorOperation: async () => true,
      },
    });
    assert.equal(report.overall, 'FAIL');
    const sourceCheck = report.checks.find(c => c.check === 'SOURCE');
    assert.equal(sourceCheck.status, 'FAIL');
    assert.equal(sourceCheck.code, 'MAIN_SHA_MISMATCH');
  } finally {
    if (prevExpected === undefined) delete process.env.APP_EXPECTED_MAIN_SHA;
    else process.env.APP_EXPECTED_MAIN_SHA = prevExpected;
  }
});
