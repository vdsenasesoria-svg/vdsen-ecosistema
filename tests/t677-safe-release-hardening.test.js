'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const app = require('../scripts/release/app-live.cjs');
const NG = require('../scripts/release/numeric-guard.cjs');
const B = require('../scripts/pilot/off-baseline.cjs');

const SAFE_OFF_BASELINE = app.SAFE_OFF_BASELINE;
const PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';
const RUNTIME = 'c'.repeat(40);
const RID = process.env.GITHUB_RUN_ID || 'local';
const ARTIFACT = 'app-rollback-' + RID + '.json';
const mockEvidenceSha = 'e'.repeat(64);
const mockProof = {
  status: 'OFF_AT_IMMUTABLE_BUILD',
  officialReleaseRun: SAFE_OFF_BASELINE.officialReleaseRun,
  deployment: SAFE_OFF_BASELINE.deployment,
  evidenceSha256: mockEvidenceSha,
};

function setupEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't677-focused-'));
  const prevOut = app.getOut();
  const prevSha = process.env.APP_RUNTIME_SHA;
  app.setOut(tmp);
  process.env.APP_RUNTIME_SHA = RUNTIME;
  const cleanup = () => {
    app.setOut(prevOut);
    if (prevSha === undefined) delete process.env.APP_RUNTIME_SHA; else process.env.APP_RUNTIME_SHA = prevSha;
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, cleanup };
}

const put = (tmp, name, data) => fs.writeFileSync(path.join(tmp, name), JSON.stringify(data));

const validRollbackArtifact = (over = {}) => ({
  release_id: RID,
  candidate_sha: RUNTIME,
  candidate_deployment: 'dpl_candidate',
  production_deployment: 'dpl_previous',
  production_runtime_sha: SAFE_OFF_BASELINE.runtimeSha,
  safe_off_deployment: SAFE_OFF_BASELINE.deployment,
  safe_off_evidence_sha256: mockEvidenceSha,
  production_project: PROJECT,
  vercel_team: TEAM,
  production_origin: 'https://vdsen-ecosistema.vercel.app',
  main_sha: 'f6596ba5207dc158b8a9b01483cd0fe0ebeb274c',
  captured_at: new Date().toISOString(),
  ...over,
});

const validStagedReport = (over = {}) => ({
  release_id: RID,
  staged_deployment: 'dpl_staged',
  candidate_sha: RUNTIME,
  production_project: PROJECT,
  vercel_team: TEAM,
  production_alias_before: 'dpl_previous',
  numeric_guard: { status: 'DISARMED' },
  ...over,
});

// 1. Deployment inesperado con el mismo SHA.
test('T677.1 unexpected deployment with identical SHA is rejected (exact identity required)', () => {
  // assertPromoted directly enforces that sharing the commit SHA is NOT enough.
  const dWrongId = {
    id: 'dpl_unexpected_other',
    readyState: 'READY',
    projectId: PROJECT,
    teamId: TEAM,
    meta: { githubCommitSha: RUNTIME },
  };
  assert.throws(
    () => app.assertPromoted(dWrongId, {
      runtime: RUNTIME,
      project: PROJECT,
      team: TEAM,
      productionDeploymentId: 'dpl_unexpected_other',
      targetDeployment: 'dpl_authorized_target',
    }),
    /Production alias does not point to the authorized deployment/
  );

  // Even if productionDeploymentId is forged to match targetDeployment, if the deployment object has a different id:
  assert.throws(
    () => app.assertPromoted(dWrongId, {
      runtime: RUNTIME,
      project: PROJECT,
      team: TEAM,
      productionDeploymentId: 'dpl_authorized_target',
      targetDeployment: 'dpl_authorized_target',
    }),
    /Observed deployment id does not match the authorized deployment/
  );
});

// 2. Alias modificado después de verificar bytes durante promoción.
test('T677.2 alias modified after public bytes verification during promotion fails closed', async () => {
  const { tmp, cleanup } = setupEnv();
  const guardEvidence = NG.evaluateProductionEnv([], { project: PROJECT, team: TEAM, runtimeSha: RUNTIME });
  try {
    put(tmp, 'app-preflight.json', {
      release_id: RID,
      runtime_sha: RUNTIME,
      candidate: 'dpl_candidate',
      production_deployment: 'dpl_previous',
      rollback_artifact: ARTIFACT,
      numeric_guard: guardEvidence,
    });
    put(tmp, ARTIFACT, validRollbackArtifact());
    put(tmp, 'app-staged.json', validStagedReport({ numeric_guard: guardEvidence }));

    // currentApp sequence:
    // 1. Pre-promotion check (must equal artifact.production_deployment -> 'dpl_previous')
    // 2. Post-promote convergence read (returns target 'dpl_staged')
    // 3. Post-bytes verification re-read (race condition: concurrent actor points to 'dpl_foreign_hijack')
    let reads = 0;
    const steps = {
      verifySafeOffBaseline: async () => mockProof,
      numericGuard: async () => guardEvidence,
      promote: async () => {},
      currentApp: async () => {
        reads++;
        if (reads === 1) return 'dpl_previous';
        if (reads === 2) return 'dpl_staged';
        return 'dpl_foreign_hijack';
      },
      deployment: async (s, id) => ({
        id, readyState: 'READY', projectId: PROJECT, teamId: TEAM, meta: { githubCommitSha: RUNTIME },
      }),
      verifyPublicBytes: async () => ['vdsen-cliente.html'],
      servedSurface: () => ['vdsen-cliente.html'],
    };

    await assert.rejects(
      () => app.apply(steps),
      /ALIAS_CHANGED_AFTER_VERIFICATION/
    );

    const result = JSON.parse(fs.readFileSync(path.join(tmp, 'app-result.json'), 'utf8'));
    assert.equal(result.app_release_status, 'FAIL');
    assert.notEqual(result.state, 'VERIFIED');
    assert.equal(result.rollback_required, true);
  } finally {
    cleanup();
  }
});

// 3. Alias modificado después de verificar bytes durante rollback.
test('T677.3 alias modified after public bytes verification during rollback does not declare RECOVERED', async () => {
  const { tmp, cleanup } = setupEnv();
  try {
    put(tmp, 'app-result.json', { release_id: RID, rollback_required: true, mutation_status: 'MUTATED' });
    put(tmp, ARTIFACT, validRollbackArtifact());
    put(tmp, 'app-staged.json', validStagedReport());

    let reads = 0;
    const steps = {
      verifySafeOffBaseline: async () => mockProof,
      // 1. Read before revert: returns 'dpl_staged'
      // 2. Re-read after byte verification: returns a different deployment instead of safe off
      currentApp: async () => {
        reads++;
        if (reads === 1) return 'dpl_staged';
        return 'dpl_foreign_unstable';
      },
      revertApp: async (s, target) => target,
      deployment: async (s, id) => ({
        id, readyState: 'READY', target: 'production',
        meta: { githubCommitSha: SAFE_OFF_BASELINE.runtimeSha },
      }),
      servedSurface: () => ['vdsen-cliente.html'],
      verifyPublicBytes: async () => ['vdsen-cliente.html'],
    };

    await assert.rejects(
      () => app.rollbackApp(steps),
      /ALIAS_NOT_PROVEN_AFTER_RECOVERY/
    );

    const rbResult = JSON.parse(fs.readFileSync(path.join(tmp, 'app-rollback-result.json'), 'utf8'));
    assert.equal(rbResult.state, 'RECOVERY_REQUIRED');
    assert.notEqual(rbResult.state, 'RECOVERED');
    assert.equal(rbResult.manual_recovery_required, true);
    assert.equal(rbResult.recovery_evidence.last_observed_deployment, 'dpl_foreign_unstable');
  } finally {
    cleanup();
  }
});

// 4. Interrupción después del intento de promoción, antes del resultado final (write-ahead evidence).
test('T677.4 interruption after promotion request retains write-ahead record requiring recovery', async () => {
  const { tmp, cleanup } = setupEnv();
  const guardEvidence = NG.evaluateProductionEnv([], { project: PROJECT, team: TEAM, runtimeSha: RUNTIME });
  try {
    put(tmp, 'app-preflight.json', {
      release_id: RID,
      runtime_sha: RUNTIME,
      candidate: 'dpl_candidate',
      production_deployment: 'dpl_previous',
      rollback_artifact: ARTIFACT,
      numeric_guard: guardEvidence,
    });
    put(tmp, ARTIFACT, validRollbackArtifact());
    put(tmp, 'app-staged.json', validStagedReport({ numeric_guard: guardEvidence }));

    // Simulate process termination right inside promoteFn by checking the write-ahead file
    let writeAheadBeforePromote = null;
    const steps = {
      verifySafeOffBaseline: async () => mockProof,
      numericGuard: async () => guardEvidence,
      currentApp: async () => 'dpl_previous',
      deployment: async (s, id) => ({
        id, readyState: 'READY', projectId: PROJECT, teamId: TEAM, meta: { githubCommitSha: RUNTIME },
      }),
      promote: async () => {
        writeAheadBeforePromote = JSON.parse(fs.readFileSync(path.join(tmp, 'app-result.json'), 'utf8'));
        throw new Error('PROCESS_KILLED_SIMULATION');
      },
    };

    await assert.rejects(() => app.apply(steps), /PROCESS_KILLED_SIMULATION/);

    // Verify write-ahead evidence was persisted before promote was called
    assert.ok(writeAheadBeforePromote);
    assert.equal(writeAheadBeforePromote.state, 'MUTATION_REQUESTED');
    assert.equal(writeAheadBeforePromote.mutation_status, 'UNKNOWN');
    assert.equal(writeAheadBeforePromote.rollback_required, true);
    assert.ok(writeAheadBeforePromote.requested_at);

    // Simulate that the process was interrupted (e.g. killed) right during mutation:
    // restore the exact write-ahead state that was on disk before any catch block could update it.
    put(tmp, 'app-result.json', writeAheadBeforePromote);

    // Now verify rollbackApp treats this interrupted state as requiring recovery
    let reverted = false;
    let reads = 0;
    const rbSteps = {
      verifySafeOffBaseline: async () => mockProof,
      currentApp: async () => {
        reads++;
        return reads === 1 ? 'dpl_staged' : SAFE_OFF_BASELINE.deployment;
      },
      revertApp: async (s, target) => { reverted = true; return target; },
      deployment: async (s, id) => ({
        id, readyState: 'READY', target: 'production',
        meta: { githubCommitSha: SAFE_OFF_BASELINE.runtimeSha },
      }),
      servedSurface: () => ['vdsen-cliente.html'],
      verifyPublicBytes: async () => ['vdsen-cliente.html'],
    };

    const out = await app.rollbackApp(rbSteps);
    assert.equal(out.rollback_status, 'PASS');
    assert.equal(out.state, 'RECOVERED');
    assert.equal(reverted, true);
  } finally {
    cleanup();
  }
});

// 5. Observación fallida y recuperación manual requerida.
test('T677.5 observation failure records manual recovery required without auto-overwrite', async () => {
  const { tmp, cleanup } = setupEnv();
  const guardEvidence = NG.evaluateProductionEnv([], { project: PROJECT, team: TEAM, runtimeSha: RUNTIME });
  try {
    put(tmp, 'app-preflight.json', {
      release_id: RID,
      runtime_sha: RUNTIME,
      candidate: 'dpl_candidate',
      production_deployment: 'dpl_previous',
      rollback_artifact: ARTIFACT,
      numeric_guard: guardEvidence,
    });
    put(tmp, ARTIFACT, validRollbackArtifact());
    put(tmp, 'app-staged.json', validStagedReport({ numeric_guard: guardEvidence }));

    // Observation throws network error after promote attempt
    let reads = 0;
    const steps = {
      verifySafeOffBaseline: async () => mockProof,
      numericGuard: async () => guardEvidence,
      currentApp: async () => {
        reads++;
        if (reads === 1) return 'dpl_previous';
        throw new Error('Vercel API timed out unreachably');
      },
      promote: async () => { throw new Error('Promote connection reset'); },
      deployment: async (s, id) => ({
        id, readyState: 'READY', projectId: PROJECT, teamId: TEAM, meta: { githubCommitSha: RUNTIME },
      }),
    };

    await assert.rejects(() => app.apply(steps), /Promote connection reset/);

    const result = JSON.parse(fs.readFileSync(path.join(tmp, 'app-result.json'), 'utf8'));
    assert.equal(result.mutation_status, 'UNKNOWN');
    assert.equal(result.rollback_required, true);
    assert.equal(result.manual_recovery_required, true);
    assert.ok(result.recovery_evidence);
    assert.equal(result.recovery_evidence.safe_off_deployment, SAFE_OFF_BASELINE.deployment);
    assert.equal(result.recovery_evidence.candidate_deployment, 'dpl_candidate');
    assert.match(result.recovery_evidence.observed_error, /Vercel API timed out/);

    // Rollback attempt when observation remains unreadable must fail closed
    await assert.rejects(
      () => app.rollbackApp({
        verifySafeOffBaseline: async () => mockProof,
        currentApp: async () => { throw new Error('Network still down'); },
      }),
      /PRODUCTION_ALIAS_UNREADABLE_MANUAL_RECOVERY_REQUIRED/
    );

    const rbResult = JSON.parse(fs.readFileSync(path.join(tmp, 'app-rollback-result.json'), 'utf8'));
    assert.equal(rbResult.manual_recovery_required, true);
    assert.equal(rbResult.state, 'RECOVERY_REQUIRED');
  } finally {
    cleanup();
  }
});

// 6. Artefactos pertenecientes a distintas ejecuciones.
test('T677.6 artifacts belonging to mismatched runs are rejected', async () => {
  const { tmp, cleanup } = setupEnv();
  const guardEvidence = NG.evaluateProductionEnv([], { project: PROJECT, team: TEAM, runtimeSha: RUNTIME });
  try {
    put(tmp, 'app-preflight.json', {
      release_id: RID,
      runtime_sha: RUNTIME,
      candidate: 'dpl_candidate',
      production_deployment: 'dpl_previous',
      rollback_artifact: ARTIFACT,
      numeric_guard: guardEvidence,
    });
    // Rollback artifact carries another run id
    put(tmp, ARTIFACT, validRollbackArtifact({ release_id: '999999999' }));
    put(tmp, 'app-staged.json', validStagedReport({ numeric_guard: guardEvidence }));

    const steps = {
      verifySafeOffBaseline: async () => mockProof,
      numericGuard: async () => guardEvidence,
      currentApp: async () => 'dpl_previous',
      deployment: async (s, id) => ({
        id, readyState: 'READY', projectId: PROJECT, teamId: TEAM, meta: { githubCommitSha: RUNTIME },
      }),
      promote: async () => {},
    };

    await assert.rejects(
      () => app.apply(steps),
      /ARTIFACT_RELEASE_MISMATCH: rollback artifact belongs to another run/
    );
  } finally {
    cleanup();
  }
});

// 7. Idempotencia sin mutación.
test('T677.7 idempotency: rollbackApp is a no-op when production already serves safe OFF deployment', async () => {
  const { tmp, cleanup } = setupEnv();
  try {
    put(tmp, 'app-result.json', { release_id: RID, rollback_required: true, mutation_status: 'MUTATED' });
    put(tmp, ARTIFACT, validRollbackArtifact());

    let revertCalled = false;
    const steps = {
      verifySafeOffBaseline: async () => mockProof,
      currentApp: async () => SAFE_OFF_BASELINE.deployment,
      revertApp: async () => { revertCalled = true; },
    };

    const out = await app.rollbackApp(steps);
    assert.equal(out.rollback_status, 'NOT_NEEDED');
    assert.equal(out.state, 'NO_MUTATION');
    assert.equal(out.current_deployment, SAFE_OFF_BASELINE.deployment);
    assert.equal(revertCalled, false);
  } finally {
    cleanup();
  }
});

// 8. Rechazo de evidencia OFF inválida.
test('T677.8 invalid OFF baseline evidence is strictly rejected', () => {
  const baseline = {
    runtimeSha: '21dc0e2b211facfb0df9f3079c58488c2f86952c',
    deployment: 'dpl_BDdGBRjtRotiv4nJJEDoZK57He9s',
    officialReleaseRun: '40688365774',
    evidenceArtifactDigest: 'sha256:27e222d6d8e4bd0d02ebd6d8f00fd550ae665923e7893b0c0221ccae1fc34131',
  };
  const s = {
    runtime_sha: baseline.runtimeSha,
    production_deployment: baseline.deployment,
    production_project: PROJECT,
    vercel_team: TEAM,
    app_release: {
      runtime_sha: baseline.runtimeSha,
      deployment: baseline.deployment,
      source_release_run: baseline.officialReleaseRun,
    },
  };
  const d = {
    id: baseline.deployment,
    projectId: PROJECT,
    teamId: TEAM,
    readyState: 'READY',
    target: 'production',
    meta: { githubCommitSha: baseline.runtimeSha },
  };
  const before = NG.evaluateProductionEnv([], { project: PROJECT, team: TEAM, runtimeSha: baseline.runtimeSha, now: Date.parse('2026-10-28T12:00:00Z') });
  const after = { ...before, captured_at: '2026-10-28T12:01:00Z' };
  const makeProof = (over = {}) => ({
    run: {
      id: 40688365774,
      repository: { full_name: 'vdsenasesoria-svg/vdsen-ecosistema' },
      path: '.github/workflows/vdsen-app-release-prod.yml',
      head_branch: 'codex/client-app-next',
      head_sha: baseline.runtimeSha,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      run_attempt: 1,
    },
    preflight: {
      runtime_sha: baseline.runtimeSha,
      candidate: 'dpl_cand',
      production_deployment: 'dpl_prev',
      rollback_artifact: 'app-rollback-40688365774.json',
      numeric_guard: before,
    },
    staged: {
      staged_deployment: baseline.deployment,
      candidate_sha: baseline.runtimeSha,
      production_project: PROJECT,
      vercel_team: TEAM,
      staged_target: 'production',
      staged_ready_state: 'READY',
      production_alias_before: 'dpl_prev',
      production_alias_after: 'dpl_prev',
      numeric_guard: after,
      staged_at: '2026-10-28T12:01:01Z',
    },
    result: {
      release_id: '40688365774',
      runtime_sha: baseline.runtimeSha,
      app_release_status: 'SUCCESS',
      state: 'VERIFIED',
      promotion_model: 'staged_production',
      previous_deployment: 'dpl_prev',
      promotion_target: baseline.deployment,
      production_deployment: baseline.deployment,
      rollback_required: false,
      rules_mutated: false,
      main_unchanged: true,
    },
    rollback: {
      release_id: '40688365774',
      candidate_sha: baseline.runtimeSha,
      candidate_deployment: 'dpl_cand',
      production_deployment: 'dpl_prev',
      production_project: PROJECT,
      vercel_team: TEAM,
    },
    artifact: {
      name: 'app-release-result-40688365774',
      expired: false,
      digest: baseline.evidenceArtifactDigest,
      workflow_run: { id: 40688365774, head_sha: baseline.runtimeSha, head_branch: 'codex/client-app-next' },
    },
    ...over,
  });

  // Valid proof passes
  const valid = makeProof();
  const verified = B.verify(s, baseline, d, valid);
  assert.equal(verified.status, 'OFF_AT_IMMUTABLE_BUILD');

  // Digest mismatch is rejected
  const badDigest = makeProof({
    artifact: {
      name: 'app-release-result-40688365774',
      expired: false,
      digest: 'sha256:' + 'f'.repeat(64),
      workflow_run: { id: 40688365774, head_sha: baseline.runtimeSha, head_branch: 'codex/client-app-next' },
    },
  });
  assert.throws(() => B.verify(s, baseline, d, badDigest), /OFF_BASELINE_ARTIFACT_DIGEST_MISMATCH/);

  // Mismatched run id is rejected
  const badRunId = makeProof({
    result: { ...valid.result, release_id: '999999' },
  });
  assert.throws(() => B.verify(s, baseline, d, badRunId));
});

// 9. Mocks completamente aislados de Vercel real.
test('T677.9 simulated test runs do not make real network requests to Vercel', async () => {
  const { tmp, cleanup } = setupEnv();
  const prevFetch = global.fetch;
  let fetchAttempted = false;
  global.fetch = async (url) => {
    if (String(url).includes('vercel.com')) {
      fetchAttempted = true;
      throw new Error('NETWORK_VIOLATION: simulated test attempted real Vercel API call to ' + url);
    }
    return prevFetch(url);
  };
  try {
    put(tmp, 'app-result.json', { release_id: RID, rollback_required: true, mutation_status: 'MUTATED' });
    put(tmp, ARTIFACT, validRollbackArtifact());
    put(tmp, 'app-staged.json', validStagedReport());

    const steps = {
      verifySafeOffBaseline: async () => mockProof,
      currentApp: async () => SAFE_OFF_BASELINE.deployment,
      revertApp: async () => {},
    };

    const out = await app.rollbackApp(steps);
    assert.equal(out.rollback_status, 'NOT_NEEDED');
    assert.equal(fetchAttempted, false, 'No real Vercel fetch may occur during simulated steps');
  } finally {
    global.fetch = prevFetch;
    cleanup();
  }
});

// ── T677.1 focal rollback classification hardening

// T677.1-1: app-result.json de otra ejecución con rollback_required: false
test('T677.1-1 app-result.json from another execution with rollback_required=false is rejected', async () => {
  const { tmp, cleanup } = setupEnv();
  try {
    put(tmp, 'app-result.json', {
      release_id: 'other-run-999999',
      rollback_required: false,
      state: 'NO_MUTATION',
      mutation_status: 'NO_MUTATION',
    });

    await assert.rejects(
      () => app.rollbackApp({ currentApp: async () => SAFE_OFF_BASELINE.deployment }),
      /ARTIFACT_RELEASE_MISMATCH: release result belongs to another run/
    );

    const rbResult = JSON.parse(fs.readFileSync(path.join(tmp, 'app-rollback-result.json'), 'utf8'));
    assert.equal(rbResult.state, 'RECOVERY_REQUIRED');
    assert.equal(rbResult.manual_recovery_required, true);
    assert.notEqual(rbResult.rollback_status, 'NOT_NEEDED');
  } finally {
    cleanup();
  }
});

// T677.1-2: Resultado incompleto o ilegible
test('T677.1-2 incomplete or unreadable app-result.json is rejected and never becomes NOT_NEEDED', async () => {
  const { tmp, cleanup } = setupEnv();
  try {
    // Case A: Structurally incomplete (missing rollback_required boolean)
    put(tmp, 'app-result.json', { release_id: RID });
    await assert.rejects(
      () => app.rollbackApp({ currentApp: async () => SAFE_OFF_BASELINE.deployment }),
      /RESULT_ARTIFACT_INCOMPLETE: rollback_required must be a boolean/
    );
    let rbResult = JSON.parse(fs.readFileSync(path.join(tmp, 'app-rollback-result.json'), 'utf8'));
    assert.equal(rbResult.state, 'RECOVERY_REQUIRED');
    assert.equal(rbResult.manual_recovery_required, true);

    // Case B: rollback_required=false without proven NO_MUTATION or VERIFIED state
    put(tmp, 'app-result.json', { release_id: RID, rollback_required: false, state: 'MUTATION_REQUESTED' });
    await assert.rejects(
      () => app.rollbackApp({ currentApp: async () => SAFE_OFF_BASELINE.deployment }),
      /RESULT_ARTIFACT_INCOMPLETE: rollback_required=false requires proven NO_MUTATION or VERIFIED state/
    );
    rbResult = JSON.parse(fs.readFileSync(path.join(tmp, 'app-rollback-result.json'), 'utf8'));
    assert.equal(rbResult.state, 'RECOVERY_REQUIRED');
    assert.equal(rbResult.manual_recovery_required, true);

    // Case C: Unreadable / corrupt JSON even if production serves the baseline
    fs.writeFileSync(path.join(tmp, 'app-result.json'), '{corrupt-json');
    put(tmp, ARTIFACT, validRollbackArtifact());
    await assert.rejects(
      () => app.rollbackApp({
        verifySafeOffBaseline: async () => mockProof,
        currentApp: async () => 'dpl_previous',
      }),
      /RESULT_ARTIFACT_UNREADABLE/
    );
    rbResult = JSON.parse(fs.readFileSync(path.join(tmp, 'app-rollback-result.json'), 'utf8'));
    assert.equal(rbResult.state, 'RECOVERY_REQUIRED');
    assert.equal(rbResult.manual_recovery_required, true);
    assert.notEqual(rbResult.rollback_status, 'NOT_NEEDED');
  } finally {
    cleanup();
  }
});

// T677.1-3: Resultado ausente con evidencia staged y alias ajeno
test('T677.1-3 missing app-result.json with staged evidence and foreign production alias records manual recovery without overwrite', async () => {
  const { tmp, cleanup } = setupEnv();
  try {
    put(tmp, ARTIFACT, validRollbackArtifact());
    put(tmp, 'app-staged.json', validStagedReport());

    let revertCalled = false;
    await assert.rejects(
      () => app.rollbackApp({
        verifySafeOffBaseline: async () => mockProof,
        currentApp: async () => 'dpl_foreign_unrecognized',
        revertApp: async () => { revertCalled = true; },
      }),
      /FOREIGN_ALIAS_NO_AUTOMATIC_OVERWRITE: production serves dpl_foreign_unrecognized/
    );

    assert.equal(revertCalled, false, 'Must not overwrite foreign alias');
    const rbResult = JSON.parse(fs.readFileSync(path.join(tmp, 'app-rollback-result.json'), 'utf8'));
    assert.equal(rbResult.rollback_status, 'MANUAL_RECOVERY_REQUIRED');
    assert.equal(rbResult.state, 'RECOVERY_REQUIRED');
    assert.equal(rbResult.manual_recovery_required, true);
    assert.equal(rbResult.recovery_evidence.last_observed_deployment, 'dpl_foreign_unrecognized');
    assert.equal(rbResult.recovery_evidence.staged_deployment, 'dpl_staged');
  } finally {
    cleanup();
  }
});

// T677.1-4: Resultado válido sin necesidad de rollback
test('T677.1-4 valid current-run app-result.json with rollback_required=false returns NOT_NEEDED', async () => {
  const { tmp, cleanup } = setupEnv();
  try {
    put(tmp, 'app-result.json', {
      release_id: RID,
      rollback_required: false,
      state: 'NO_MUTATION',
      mutation_status: 'NO_MUTATION',
    });
    put(tmp, 'app-staged.json', validStagedReport());

    let revertCalled = false;
    const out = await app.rollbackApp({
      revertApp: async () => { revertCalled = true; },
    });

    assert.equal(out.rollback_status, 'NOT_NEEDED');
    assert.equal(out.state, 'NO_MUTATION');
    assert.equal(out.rules_mutated, false);
    assert.equal(revertCalled, false);
  } finally {
    cleanup();
  }
});

// T677.1-5: Producción ya restaurada al baseline OFF (con o sin app-result.json)
test('T677.1-5 legitimate idempotency when production already serves SAFE_OFF_BASELINE.deployment', async () => {
  const { tmp, cleanup } = setupEnv();
  try {
    // Subcase A: Missing app-result.json + staged evidence present + production already at SAFE_OFF_BASELINE.deployment
    put(tmp, ARTIFACT, validRollbackArtifact());
    put(tmp, 'app-staged.json', validStagedReport());

    let revertCalled = false;
    const outMissing = await app.rollbackApp({
      verifySafeOffBaseline: async () => mockProof,
      currentApp: async () => SAFE_OFF_BASELINE.deployment,
      revertApp: async () => { revertCalled = true; },
    });
    assert.equal(outMissing.rollback_status, 'NOT_NEEDED');
    assert.equal(outMissing.state, 'NO_MUTATION');
    assert.equal(outMissing.current_deployment, SAFE_OFF_BASELINE.deployment);
    assert.equal(revertCalled, false);

    // Subcase B: Write-ahead / rollback_required=true present + production already at SAFE_OFF_BASELINE.deployment
    put(tmp, 'app-result.json', {
      release_id: RID,
      rollback_required: true,
      state: 'MUTATION_REQUESTED',
      mutation_status: 'UNKNOWN',
    });
    const outPresent = await app.rollbackApp({
      verifySafeOffBaseline: async () => mockProof,
      currentApp: async () => SAFE_OFF_BASELINE.deployment,
      revertApp: async () => { revertCalled = true; },
    });
    assert.equal(outPresent.rollback_status, 'NOT_NEEDED');
    assert.equal(outPresent.state, 'NO_MUTATION');
    assert.equal(outPresent.current_deployment, SAFE_OFF_BASELINE.deployment);
    assert.equal(revertCalled, false);
  } finally {
    cleanup();
  }
});
