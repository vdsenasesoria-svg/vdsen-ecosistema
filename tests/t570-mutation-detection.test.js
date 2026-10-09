'use strict';
// T570 — Mutation detection before recovery.
//
// THE BUG THIS LOCKS OUT
// `apply()` used one try/catch and set `rollback_required = true` on ANY failure. Run 37629216025
// proved why that is wrong: the promote returned HTTP 422 and production had NOT changed, yet the
// workflow still ran recovery, called rollback against a deployment that was STILL the current
// production one, and that call also returned 422. The second 422 therefore said nothing about
// whether rollback works after a REAL mutation - it only proved the state machine was too eager.
//
// THE INVARIANT
// An unsuccessful promote request does NOT imply production changed. Recovery may only mutate when
// a change is observed, or cannot be ruled out. The decision is made from the observed production
// alias, never from the fact that we asked.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const app = require('../scripts/release/app-live.cjs');

const PREVIOUS = 'dpl_FngrtpodSKHZ9aPk75aA5SS7JGnB';
const CANDIDATE = 'dpl_9rCu3FswEnseDvcgpf6FbrjzuJJS';
const RUNTIME = '8365410cf7f09427c79ead77aa4f769c16e9a803';
const PREVIOUS_RUNTIME = 'd7bb71521d750eafd46a15fdd3c6ee157d4bd4cf';
const PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';

// assertRollbackArtifact requires every one of these fields, so the fixture must be complete or
// apply() fails before the path under test can be exercised.
const artifact = (over = {}) => ({
  candidate_sha: RUNTIME,
  candidate_deployment: CANDIDATE,
  production_deployment: PREVIOUS,
  production_runtime_sha: PREVIOUS_RUNTIME,
  production_project: PROJECT,
  vercel_team: TEAM,
  production_origin: 'https://vdsen-ecosistema.vercel.app',
  main_sha: 'f6596ba5207dc158b8a9b01483cd0fe0ebeb274c',
  captured_at: '2026-10-07T14:00:00.000Z',
  ...over,
});

// ── decideRecovery: pure, every branch provable ───────────────────────────────────────────────

test('T570-1 promote fails before mutation and production is unchanged => NO rollback', () => {
  const d = app.decideRecovery({ observed: PREVIOUS, observedError: null, previous: PREVIOUS, expectedNew: CANDIDATE });
  assert.equal(d.mutation_status, 'NO_MUTATION');
  assert.equal(d.rollback_required, false, 'rollback must NOT be required when production did not move');
  assert.match(d.reason, /did not move production/);
});

test('T570-2 the alias we observe is what decides, never the fact that promote was attempted', () => {
  // Same "promote threw" situation, two different observations, two different decisions.
  const unchanged = app.decideRecovery({ observed: PREVIOUS, observedError: 'promote HTTP 422', previous: PREVIOUS, expectedNew: CANDIDATE });
  const changed = app.decideRecovery({ observed: CANDIDATE, observedError: 'promote timed out', previous: PREVIOUS, expectedNew: CANDIDATE });
  assert.equal(unchanged.rollback_required, false);
  assert.equal(changed.rollback_required, true);
  assert.equal(changed.mutation_status, 'MUTATED');
});

test('T570-3 promote times out but the alias changed => rollback required', () => {
  const d = app.decideRecovery({ observed: CANDIDATE, observedError: null, previous: PREVIOUS, expectedNew: CANDIDATE });
  assert.equal(d.mutation_status, 'MUTATED');
  assert.equal(d.rollback_required, true);
});

test('T570-4 promote returns an error but the alias changed => rollback required', () => {
  const d = app.decideRecovery({ observed: CANDIDATE, observedError: 'HTTP 500', previous: PREVIOUS, expectedNew: CANDIDATE });
  assert.equal(d.rollback_required, true);
});

test('T570-5 production serves something NEITHER captured nor candidate => fail closed', () => {
  const d = app.decideRecovery({ observed: 'dpl_somethingElse', observedError: null, previous: PREVIOUS, expectedNew: CANDIDATE });
  assert.equal(d.mutation_status, 'UNEXPECTED');
  assert.equal(d.rollback_required, true, 'an unknown production state must be recovered, not assumed safe');
});

test('T570-6 the alias cannot be read after an uncertain mutation => FAIL CLOSED, never a silent success', () => {
  const d = app.decideRecovery({ observed: null, observedError: 'alias read timed out', previous: PREVIOUS, expectedNew: CANDIDATE });
  assert.equal(d.mutation_status, 'UNKNOWN');
  assert.equal(d.rollback_required, true, 'unreadable production must not be treated as unchanged');
  assert.match(d.reason, /cannot be ruled out/);
  assert.match(d.reason, /alias read timed out/, 'the read failure is reported, not swallowed');
});

test('T570-7 rollback target equal to the current deployment is never a reason to call rollback', () => {
  // decideRecovery is the contract; the rollbackApp guard re-reads production too.
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release', 'app-live.cjs'), 'utf8');
  const i = src.indexOf('async function rollbackApp(');
  const body = src.slice(i, src.indexOf('\nfunction setOut', i));
  assert.ok(/currentId && currentId === artifact\.production_deployment/.test(body),
    'rollbackApp must skip the call when the target is already current');
  assert.ok(/rollback_status: 'NOT_NEEDED'/.test(body), 'and classify it NOT_NEEDED');
  assert.ok(/NO_MUTATION/.test(body), 'with an explicit no-mutation state');
  // the re-read must happen inside rollbackApp, not be trusted from earlier in the run
  assert.ok(/currentId = await currentApp\(s\)/.test(body), 'production is re-read at recovery time');
  // and it must come BEFORE the actual revert call
  assert.ok(body.indexOf('currentId = await currentApp(s)') < body.indexOf('await revertApp('),
    'the guard precedes the mutation');
});

test('T570-8 recovery has no Firestore path and reports rules_mutated=false', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release', 'app-live.cjs'), 'utf8');
  const i = src.indexOf('async function rollbackApp(');
  const body = src.slice(i, src.indexOf('\nfunction setOut', i));
  for (const forbidden of ['firestore.rules', 'firebaserules', 'firestore.googleapis', 'setDoc', 'updateDoc']) {
    assert.ok(!body.includes(forbidden), 'recovery must not reference ' + forbidden);
  }
  assert.ok(/rules_mutated: false/.test(body), 'every recovery outcome records rules_mutated: false');
  assert.ok(/state: 'RECOVERED'/.test(body), 'a successful recovery is classified');
});

// ── apply(): the failure path, exercised with fakes ───────────────────────────────────────────

// Runs the real apply() against injected steps and a temp OUT directory. `artifact` is written by
// preflight in production; here we author it so apply can be driven without any network.
async function runApply(t, { promoteThrows, aliasSequence }) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t570-'));
  const prevOut = app.getOut();
  app.setOut(out);
  t.after(() => { app.setOut(prevOut); fs.rmSync(out, { recursive: true, force: true }); });

  fs.writeFileSync(path.join(out, 'app-preflight.json'), JSON.stringify({
    runtime_sha: RUNTIME, candidate: CANDIDATE, production_deployment: PREVIOUS,
    rollback_artifact: 'app-rollback-test.json',
  }));
  fs.writeFileSync(path.join(out, 'app-rollback-test.json'), JSON.stringify(artifact()));

  let call = 0;
  const steps = {
    promote: async () => { if (promoteThrows) throw new Error(promoteThrows); },
    currentApp: async () => aliasSequence[Math.min(call++, aliasSequence.length - 1)],
    deployment: async (s, id) => ({ id, uid: id, readyState: 'READY', target: null, projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN', meta: { githubCommitSha: RUNTIME } }),
    verifyPublicBytes: async () => [{ path: 'vdsen-cliente.html', ok: true }],
    servedSurface: () => ['vdsen-cliente.html'],
  };
  const prevSha = process.env.APP_RUNTIME_SHA;
  process.env.APP_RUNTIME_SHA = RUNTIME;
  t.after(() => { if (prevSha === undefined) delete process.env.APP_RUNTIME_SHA; else process.env.APP_RUNTIME_SHA = prevSha; });

  let error = null;
  try { await app.apply(steps); } catch (e) { error = e; }
  const result = JSON.parse(fs.readFileSync(path.join(out, 'app-result.json'), 'utf8'));
  return { result, error };
}

test('T570-9 apply(): promote throws and production never moved => NO_MUTATION, no rollback', async (t) => {
  const { result, error } = await runApply(t, { promoteThrows: 'API POST promote failed: HTTP 422', aliasSequence: [PREVIOUS] });
  assert.ok(error, 'apply still reports the failure');
  assert.equal(result.mutation_status, 'NO_MUTATION');
  assert.equal(result.rollback_required, false);
  assert.equal(result.state, 'NO_MUTATION');
  assert.equal(result.observed_production_deployment, PREVIOUS);
  assert.equal(result.app_release_status, 'FAIL');
  assert.equal(result.rules_mutated, false);
});

test('T570-10 apply(): promote throws but production DID move => MUTATED, rollback required', async (t) => {
  const { result } = await runApply(t, { promoteThrows: 'socket hang up', aliasSequence: [CANDIDATE] });
  assert.equal(result.mutation_status, 'MUTATED');
  assert.equal(result.rollback_required, true);
  assert.equal(result.state, 'RECOVERY_REQUIRED');
  assert.equal(result.production_deployment, CANDIDATE);
});

test('T570-11 apply(): promotion succeeds but verification fails => rollback required', async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t570b-'));
  const prevOut = app.getOut();
  app.setOut(out);
  t.after(() => { app.setOut(prevOut); fs.rmSync(out, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(out, 'app-preflight.json'), JSON.stringify({
    runtime_sha: RUNTIME, candidate: CANDIDATE, production_deployment: PREVIOUS, rollback_artifact: 'app-rollback-test.json',
  }));
  fs.writeFileSync(path.join(out, 'app-rollback-test.json'), JSON.stringify(artifact()));
  const prevSha = process.env.APP_RUNTIME_SHA;
  process.env.APP_RUNTIME_SHA = RUNTIME;
  t.after(() => { if (prevSha === undefined) delete process.env.APP_RUNTIME_SHA; else process.env.APP_RUNTIME_SHA = prevSha; });

  await assert.rejects(() => app.apply({
    promote: async () => {},
    currentApp: async () => CANDIDATE,
    deployment: async (s, id) => ({ id, uid: id, readyState: 'READY', target: null, projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN', meta: { githubCommitSha: RUNTIME } }),
    verifyPublicBytes: async () => { throw new Error('served bytes do not match the candidate'); },
    servedSurface: () => ['vdsen-cliente.html'],
  }));
  const result = JSON.parse(fs.readFileSync(path.join(out, 'app-result.json'), 'utf8'));
  assert.equal(result.mutation_status, 'MUTATED');
  assert.equal(result.rollback_required, true, 'a real mutation with failed verification must be recovered');
});

test('T570-12 apply(): promotion succeeds and verification succeeds => no rollback', async (t) => {
  const { result, error } = await runApply(t, { promoteThrows: null, aliasSequence: [CANDIDATE] });
  assert.equal(error, null, 'a clean release does not throw');
  assert.equal(result.app_release_status, 'SUCCESS');
  assert.equal(result.rollback_required, false);
  assert.equal(result.state, 'VERIFIED');
  assert.equal(result.production_deployment, CANDIDATE);
});

test('T570-13 apply(): the recovery decision is only reached on failure, never on success', async (t) => {
  const { result } = await runApply(t, { promoteThrows: null, aliasSequence: [CANDIDATE] });
  assert.equal(result.mutation_status, undefined, 'no mutation bookkeeping on the happy path');
  assert.equal(result.recovery_reason, undefined);
});

test('T570-14 observeProduction reports a read failure instead of pretending it saw nothing', async () => {
  const ok = await app.observeProduction({}, async () => PREVIOUS);
  assert.deepEqual(ok, { id: PREVIOUS, error: null });
  const bad = await app.observeProduction({}, async () => { throw new Error('network down'); });
  assert.equal(bad.id, null);
  assert.match(bad.error, /network down/);
});

test('T570-15 NUMERIC_APPLY_ENABLED sigue en false', () => {
  for (const m of ['progression-effective-prescription', 'progression-application-consumer', 'progression-auto-apply-shadow', 'progression-magnitude-policy']) {
    assert.equal(require('../assets/' + m + '.js').NUMERIC_APPLY_ENABLED, false, m);
  }
});
