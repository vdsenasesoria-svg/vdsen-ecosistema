'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const app = require('../scripts/release/app-live.cjs');
const NG = require('../scripts/release/numeric-guard.cjs');

const SAFE_OFF_BASELINE = app.SAFE_OFF_BASELINE;
const PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';
// Every artifact belongs to the run that consumes it (T677); locally that is 'local', in Actions the real run id.
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't676-focused-'));
  const prevOut = app.getOut();
  app.setOut(tmp);
  const cleanup = () => {
    app.setOut(prevOut);
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, cleanup };
}

const put = (tmp, name, data) => fs.writeFileSync(path.join(tmp, name), JSON.stringify(data));
const rollbackArtifact = (over = {}) => ({
  release_id: RID,
  candidate_sha: 'a'.repeat(40),
  candidate_deployment: 'dpl_candidate',
  production_deployment: 'dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K',
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
const stagedReport = (over = {}) => ({
  release_id: RID,
  staged_deployment: 'dpl_staged_failed',
  candidate_sha: 'a'.repeat(40),
  production_project: PROJECT,
  vercel_team: TEAM,
  numeric_guard: { status: 'DISARMED' },
  ...over,
});

test('T676 rollback safely restores accredited OFF baseline with verification', async () => {
  const { tmp, cleanup } = setupEnv();
  try {
    put(tmp, 'app-result.json', { release_id: RID, rollback_required: true, mutation_status: 'MUTATED' });
    put(tmp, ARTIFACT, rollbackArtifact());
    put(tmp, 'app-staged.json', stagedReport());

    let revertedTarget = null;
    let bytesVerified = false;
    // The alias follows the mutation: staged until the restore is issued, the OFF target afterwards.
    const steps = {
      verifySafeOffBaseline: async () => mockProof,
      currentApp: async () => (revertedTarget ? revertedTarget : 'dpl_staged_failed'),
      revertApp: async (s, target) => { revertedTarget = target; return target; },
      deployment: async (s, id) => ({
        id, readyState: 'READY', target: 'production',
        meta: { githubCommitSha: SAFE_OFF_BASELINE.runtimeSha }
      }),
      servedSurface: () => ['vdsen-cliente.html'],
      verifyPublicBytes: async (s, sha, surface) => {
        assert.equal(sha, SAFE_OFF_BASELINE.runtimeSha);
        bytesVerified = true;
        return surface;
      },
    };

    const out = await app.rollbackApp(steps);
    assert.equal(out.rollback_status, 'PASS');
    assert.equal(out.state, 'RECOVERED');
    assert.equal(out.restored_deployment, SAFE_OFF_BASELINE.deployment);
    assert.equal(out.restored_runtime_sha, SAFE_OFF_BASELINE.runtimeSha);
    assert.equal(out.verified_alias, SAFE_OFF_BASELINE.deployment);
    assert.equal(out.rules_mutated, false);
    assert.equal(revertedTarget, SAFE_OFF_BASELINE.deployment);
    assert.equal(bytesVerified, true);
  } finally {
    cleanup();
  }
});

test('T676 promotion failure requires rollback when production moved', async () => {
  const { tmp, cleanup } = setupEnv();
  const prevSha = process.env.APP_RUNTIME_SHA;
  process.env.APP_RUNTIME_SHA = 'c'.repeat(40);
  const guardEvidence = NG.evaluateProductionEnv([], {
    project: PROJECT,
    team: TEAM,
    runtimeSha: 'c'.repeat(40),
  });
  try {
    put(tmp, 'app-preflight.json', {
      release_id: RID,
      runtime_sha: 'c'.repeat(40),
      candidate: 'dpl_candidate',
      production_deployment: 'dpl_previous',
      rollback_artifact: ARTIFACT,
      numeric_guard: guardEvidence,
    });
    put(tmp, ARTIFACT, rollbackArtifact({ candidate_sha: 'c'.repeat(40), production_deployment: 'dpl_previous' }));
    put(tmp, 'app-staged.json', stagedReport({ staged_deployment: 'dpl_staged_cand', candidate_sha: 'c'.repeat(40), production_alias_before: 'dpl_previous', numeric_guard: guardEvidence }));

    // Alias: the baseline right before the request, the staged build afterwards (production moved).
    let reads = 0;
    const steps = {
      verifySafeOffBaseline: async () => mockProof,
      numericGuard: async () => guardEvidence,
      promote: async () => { throw new Error('API POST promote failed: HTTP 500'); },
      currentApp: async () => (reads++ === 0 ? 'dpl_previous' : 'dpl_staged_cand'),
      deployment: async (s, id) => ({ id, readyState: 'READY', projectId: PROJECT, teamId: TEAM, meta: { githubCommitSha: 'c'.repeat(40) } }),
      verifyPublicBytes: async () => ['vdsen-cliente.html'],
      servedSurface: () => ['vdsen-cliente.html'],
    };

    let thrown = null;
    try {
      await app.apply(steps);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown);
    const result = JSON.parse(fs.readFileSync(path.join(tmp, 'app-result.json'), 'utf8'));
    assert.equal(result.app_release_status, 'FAIL');
    assert.equal(result.mutation_status, 'MUTATED');
    assert.equal(result.rollback_required, true);
    assert.equal(result.state, 'RECOVERY_REQUIRED');
  } finally {
    if (prevSha === undefined) delete process.env.APP_RUNTIME_SHA; else process.env.APP_RUNTIME_SHA = prevSha;
    cleanup();
  }
});

test('T676 unexpected alias is never overwritten automatically (FOREIGN_ALIAS_NO_AUTOMATIC_OVERWRITE)', async () => {
  const { tmp, cleanup } = setupEnv();
  try {
    put(tmp, 'app-result.json', { release_id: RID, rollback_required: true, mutation_status: 'MUTATED' });
    put(tmp, ARTIFACT, rollbackArtifact());
    put(tmp, 'app-staged.json', stagedReport({ staged_deployment: 'dpl_staged_expected' }));

    let reverted = false;
    const steps = {
      verifySafeOffBaseline: async () => mockProof,
      currentApp: async () => 'dpl_foreign_third_party',
      revertApp: async () => { reverted = true; },
    };

    let thrown = null;
    try {
      await app.rollbackApp(steps);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'Debe rechazar alias desconocido');
    assert.match(thrown.message, /FOREIGN_ALIAS_NO_AUTOMATIC_OVERWRITE/);
    assert.equal(reverted, false, 'No debe intentar revertir cuando el alias es foráneo');
    // the incident is recorded with the ids a human needs, and never as a recovery
    const record = JSON.parse(fs.readFileSync(path.join(tmp, 'app-rollback-result.json'), 'utf8'));
    assert.equal(record.manual_recovery_required, true);
    assert.equal(record.state, 'RECOVERY_REQUIRED');
    assert.equal(record.recovery_evidence.last_observed_deployment, 'dpl_foreign_third_party');
  } finally {
    cleanup();
  }
});

test('T676 idempotency: no mutation when production already serves safe OFF deployment', async () => {
  const { tmp, cleanup } = setupEnv();
  try {
    put(tmp, 'app-result.json', { release_id: RID, rollback_required: true, mutation_status: 'MUTATED' });
    put(tmp, ARTIFACT, rollbackArtifact({ production_deployment: 'dpl_previous' }));

    let reverted = false;
    const steps = {
      verifySafeOffBaseline: async () => mockProof,
      currentApp: async () => SAFE_OFF_BASELINE.deployment,
      revertApp: async () => { reverted = true; },
    };

    const out = await app.rollbackApp(steps);
    assert.equal(out.rollback_status, 'NOT_NEEDED');
    assert.equal(out.state, 'NO_MUTATION');
    assert.equal(out.current_deployment, SAFE_OFF_BASELINE.deployment);
    assert.equal(out.rules_mutated, false);
    assert.equal(reverted, false);
  } finally {
    cleanup();
  }
});

test('T676 rollback without safe OFF proof in artifact is rejected', async () => {
  const { tmp, cleanup } = setupEnv();
  try {
    put(tmp, 'app-result.json', { release_id: RID, rollback_required: true, mutation_status: 'MUTATED' });
    const artifact = rollbackArtifact({ production_deployment: 'dpl_previous' });
    delete artifact.safe_off_deployment; delete artifact.safe_off_evidence_sha256;
    put(tmp, ARTIFACT, artifact);
    put(tmp, 'app-staged.json', stagedReport({ staged_deployment: 'dpl_staged' }));

    let thrown = null;
    try {
      await app.rollbackApp({
        verifySafeOffBaseline: async () => mockProof,
        currentApp: async () => 'dpl_staged',
      });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown);
    assert.match(thrown.message, /SAFE_OFF_TARGET_MISMATCH/);
  } finally {
    cleanup();
  }
});
