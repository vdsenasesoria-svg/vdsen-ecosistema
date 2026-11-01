'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const R = require('../scripts/pilot/ayrton-runtime.cjs'), P = require('../scripts/pilot/window-protocol.cjs');
const C = require('../scripts/pilot/ayrton-canary.cjs'), T = require('../api/autonomous-progression-trigger');
const G = require('../scripts/release/numeric-guard.cjs'), B = require('../scripts/pilot/off-baseline.cjs');
const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1', hash = x => crypto.createHash('sha256').update(x).digest('hex');
const window = () => ({ schema: 'vdsen-ayrton-window-v1', uid: UID, coachId: 'test-coach', planId: 'test-plan', runtimeSha: 'a'.repeat(40),
  deployment: 'dpl_pilot', operationId: 'premerge-isolated-01', expiresAt: new Date(Date.now() + 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z') });
test('T673 review: no rollback when a staged read resolves to the unchanged baseline or another actor moved traffic', async () => {
  for (const current of ['dpl_off', 'dpl_concurrent']) {
    const w = window(), calls = []; let reads = 0;
    const s = { uid: UID, coachId: w.coachId, client: { activePlanId: w.planId }, release: { enabled: false, clientIds: [UID] }, coach: { autoApplyCanary: { enabled: false, clientIds: [UID] } } };
    await assert.rejects(() => R.arm(w, { runtimeSha: R.T671, deployment: 'dpl_off' }, {
      validateSource: async () => {}, validateBaseline: async () => {}, current: async () => ++reads === 1 ? 'dpl_off' : current,
      snapshot: async () => s, offProof: async () => G.evaluateProductionEnv([]), assertNoPriorOperation: async () => {}, save: async () => {},
      stage: async () => { calls.push('stage'); return { id: current, projectId: P.PROJECT, teamId: P.TEAM, sha: w.runtimeSha, state: 'READY', target: 'production', envNames: G.KNOWN_FLAGS }; },
      rollback: async () => calls.push('rollback'), promote: async () => calls.push('promote'), verifyBytes: async () => {},
    }));
    assert.deepEqual(calls, ['stage']);
  }
});
test('T673 review: only Ayrton can read diagnostics; valid authentication for another UID reveals no flags or window', async () => {
  for (const [uid, expected] of [[UID, 200], ['another-authenticated-user', 403]]) {
    let status, body;
    await T.makeHandler({ enabled: true, numericApplyEnabled: true, verifyIdToken: async () => ({ uid }),
      db: new Proxy({}, { get() { throw Error('DATABASE_TOUCHED'); } }) })({ method: 'GET', query: { check: 'runtime' }, headers: { authorization: 'Bearer isolated-test' } },
      { setHeader() {}, status: code => { status = code; return { json: b => { body = b; } }; } });
    assert.equal(status, expected);
    if (expected === 403) assert.deepEqual(body, { error: 'PROBE_FORBIDDEN' });
  }
});
test('T673 review: the runtime itself rejects a valid window configured for another UID', () => {
  const w = window(), bound = { uidHash: hash('foreign-client'), planHash: hash(w.planId), operationId: w.operationId, expiresAt: w.expiresAt };
  assert.equal(T.inspectPilotWindow(JSON.stringify(bound), 'foreign-client', undefined, w.planId).allowed, false);
  assert.equal(T.PILOT_UID_HASH, hash(UID)); assert.equal(P.exactUid(UID), UID);
});
test('T673 review: calendar-invalid UTC expirations are rejected at planner, writer and runtime boundaries', () => {
  const now = Date.parse('2026-11-25T00:00:00Z'), expiresAt = '2026-11-31T00:00:00Z', w = { ...window(), expiresAt };
  assert.throws(() => P.windowSpec(w, now), /EXPIRY_INVALID/);
  assert.throws(() => C.planWrites('enable', UID, { release: null, coach: {}, coachId: w.coachId }, { now: new Date(now), expiresAt }), /UTC inexistente/);
  assert.equal(T.inspectPilotWindow(JSON.stringify({ uidHash: hash(UID), planHash: hash(w.planId), expiresAt, operationId: w.operationId }), UID, now, w.planId).allowed, false);
});
function offProof() {
  const baseline = { runtimeSha: R.T671, deployment: 'dpl_off', officialReleaseRun: '12345' };
  const s = { runtime_sha: baseline.runtimeSha, production_deployment: baseline.deployment, production_project: P.PROJECT, vercel_team: P.TEAM,
    app_release: { runtime_sha: baseline.runtimeSha, deployment: baseline.deployment, source_release_run: baseline.officialReleaseRun } };
  const before = G.evaluateProductionEnv([], { project: P.PROJECT, team: P.TEAM, runtimeSha: R.T671, now: Date.parse('2026-10-29T10:00:00Z') });
  const after = { ...before, captured_at: '2026-10-29T10:01:00Z' };
  const d = { id: baseline.deployment, projectId: P.PROJECT, teamId: P.TEAM, readyState: 'READY', target: 'production', meta: { githubCommitSha: R.T671 }, env: [] };
  const proof = { run: { id: 12345, repository: { full_name: 'vdsenasesoria-svg/vdsen-ecosistema' }, path: '.github/workflows/vdsen-app-release-prod.yml',
    head_branch: 'codex/client-app-next', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', run_attempt: 1 },
    preflight: { runtime_sha: R.T671, numeric_guard: before },
    staged: { staged_deployment: baseline.deployment, candidate_sha: R.T671, production_project: P.PROJECT, vercel_team: P.TEAM,
      staged_target: 'production', staged_ready_state: 'READY', numeric_guard: after, staged_at: '2026-10-29T10:01:01Z' },
    result: { release_id: '12345', runtime_sha: R.T671, app_release_status: 'SUCCESS', state: 'VERIFIED', promotion_model: 'staged_production',
      promotion_target: baseline.deployment, production_deployment: baseline.deployment, rollback_required: false, rules_mutated: false, main_unchanged: true } };
  return { s, baseline, d, proof };
}
test('T673 review: OFF rollback requires authenticated official build evidence for the exact immutable deployment', () => {
  const f = offProof();
  assert.equal(B.verify(f.s, f.baseline, f.d, f.proof).status, 'OFF_AT_IMMUTABLE_BUILD');
  for (const change of [
    p => { delete p.staged.numeric_guard; }, p => { p.staged.staged_deployment = 'dpl_other'; },
    p => { p.result.release_id = '54321'; }, p => { p.run.path = '.github/workflows/other.yml'; },
    p => { p.result.app_release_status = 'NOT_EXECUTED'; }, p => { p.run.run_attempt = 2; },
    p => { p.staged.numeric_guard.status = 'ARMED'; }, p => { p.staged.staged_at = 'invalid'; },
    p => { p.staged.staged_at = '2026-10-29T11:00:00Z'; }, p => { p.run.repository.full_name = 'foreign/repository'; },
  ]) { const x = offProof(); change(x.proof); assert.throws(() => B.verify(x.s, x.baseline, x.d, x.proof)); }
  assert.throws(() => B.verify(f.s, f.baseline, { ...f.d, env: [G.FLAG_NUMERIC] }, f.proof), e => e.code === 'ENV_DISCORDANCE');
  assert.throws(() => B.load(f.s, f.baseline, f.d), 'missing artifacts cannot be treated as OFF');
});
