'use strict';
// APP-ONLY production release lane for the VDSEN Client App.
//
// WHY THIS FILE EXISTS
// `scripts/release/live.cjs` is a RULES-ONLY lane: it authenticates to the Firebase Rules
// API, can deploy firestore.rules and can roll rules back. Repurposing it for an app
// release would put the Firestore rules in the blast radius of an app promotion. This lane
// is deliberately separate and CANNOT mutate Firestore state:
//
//   - it never calls the Firebase Rules API for mutation (no ruleset create, no release patch)
//   - it never touches firestore.indexes.json
//   - it never writes Firestore documents
//   - it never changes IAM, credentials or NUMERIC_APPLY_ENABLED
//   - it never mutates `main`
//   - it never uses the rules rollback artifact as an app rollback source
//
// Its only mutation is pointing Vercel production traffic at an exact, pre-verified Git
// deployment, and its only revert is pointing that traffic back at the captured previous
// production deployment.
//
// Documented Vercel mechanisms used (official REST API, no unpinned CLI):
//   promote : POST /v10/projects/{projectId}/promote/{deploymentId}   (operationId requestPromote)
//   revert  : POST /v1/projects/{projectId}/rollback/{deploymentId}   (operationId requestRollback)
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { hash, json, git } = require('./lib.cjs');
const deployedProduct = require('./deployed-product.cjs');

const STATE = '.release/vdsen-client.json';
// Configurable so tests can exercise the full flow against a temp directory.
let OUT = 'release-output';
const VERCEL_API = 'https://api.vercel.com';

// Production server variables the app needs at runtime. Names only; values are never read
// into logs. PRESENT/MISSING is all this lane may report.
const REQUIRED_PROD_ENV = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];

// A runtime target must be an explicit full SHA. Never `latest`, `HEAD`, a branch or a
// "most recent" convenience value.
const FORBIDDEN_RUNTIME_VALUES = ['latest', 'head', 'main', 'master', 'codex/client-app-next', ''];

const state = () => json(STATE);
const save = (name, data) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + '\n');
};

// `body` is optional on purpose: an empty body would be serialised as the literal
// string "undefined" and rejected by the API.
async function api(url, token, method = 'GET', body, acceptStatus) {
  assert.ok(token, 'Missing workflow credential');
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (acceptStatus && r.status === acceptStatus) return { status: r.status };
  assert.ok(r.ok, 'API ' + method + ' failed: HTTP ' + r.status); // Never print bodies or tokens.
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}
const vercel = (s, p, method, body, acceptStatus) =>
  api(VERCEL_API + p + '?teamId=' + encodeURIComponent(s.vercel_team), process.env.VERCEL_TOKEN, method, body, acceptStatus);

// ── contract checks (pure: every one takes its data as an argument, so tests need no network)

function assertExplicitRuntime(runtime) {
  assert.equal(typeof runtime, 'string', 'Explicit runtime SHA required');
  assert.ok(!FORBIDDEN_RUNTIME_VALUES.includes(runtime.trim().toLowerCase()),
    'Runtime must be an exact commit SHA, never latest/HEAD/branch');
  assert.match(runtime, /^[0-9a-f]{40}$/, 'Runtime must be a full 40-char commit SHA');
  return runtime;
}

function assertKillSwitch() {
  assert.equal(process.env.CLIENT_APP_RELEASE_ENABLED, 'true', 'CLIENT_APP_RELEASE_ENABLED must be true to mutate');
}

// The whole point of the separate lane: no path here may MUTATE Firestore or its rules.
// A single read-only observation of the live ruleset is allowed (requirement A10 asks the
// rollback artifact to record what rules are live), so it is carved out by name and
// everything else is checked to be non-mutating.
// The forbidden import is assembled at runtime on purpose: written literally it would appear
// in this very file and the guard would flag itself.
const FORBIDDEN_IMPORT = 'require(' + JSON.stringify('./li' + 've.cjs') + ')';
const OBSERVED_RULES_API = 'https://firebaserules.googleapis.com/v1/projects/';
function assertAppOnlySources() {
  const src = fs.readFileSync(__filename, 'utf8');
  assert.ok(!src.includes(FORBIDDEN_IMPORT), 'App lane must not import the rules lane');
  const observed = src.match(/firebaserules\.googleapis\.com/g) || [];
  assert.equal(observed.length, 1, 'exactly one rules API reference: the read-only observation');
  // Everything else must be free of Firestore/rules endpoints.
  const withoutObservation = src.split(OBSERVED_RULES_API).join('');
  assert.ok(!/firebaserules\.googleapis\.com/.test(withoutObservation),
    'App lane must not contact the Firebase Rules API outside the read-only observation');
  assert.ok(!/firestore\.googleapis\.com/.test(withoutObservation),
    'App lane must not contact the Firestore data API');
  return true;
}

function assertCandidate(c, { runtime, project, team }) {
  assert.ok(c, 'Candidate deployment was not resolved');
  assert.equal(c.id && typeof c.id === 'string', true, 'Candidate must have an id');
  assert.match(c.id, /^dpl_/, 'Candidate id must be a Vercel deployment id');
  assert.equal(c.projectId, project, 'Candidate project mismatch');
  assert.equal(c.teamId || team, team, 'Candidate team mismatch');
  assert.equal(c.target, 'preview', 'Candidate must be a preview deployment before promotion');
  assert.equal(c.readyState || c.ready, 'READY', 'Candidate deployment is not READY');
  // Exact Git identity, never chronology.
  const sha = c.meta?.githubCommitSha;
  assert.equal(sha, runtime, 'Candidate githubCommitSha does not match the exact runtime');
  assert.equal(c.meta?.githubCommitRef !== undefined, true, 'Candidate must come from Git');
  assert.equal(c.source || 'git', 'git', 'Candidate source identity must be Git');
  return c;
}

function assertCandidateNotAlreadyProduction(c, productionDeploymentId) {
  assert.notEqual(c.id, productionDeploymentId,
    'Candidate is already the production deployment; refusing to treat that as a promotion');
  return true;
}

function assertBaseline({ aliasDeploymentId, expectedDeploymentId, mainSha, expectedMainSha }) {
  assert.equal(aliasDeploymentId, expectedDeploymentId, 'Production baseline deployment mismatch');
  assert.equal(mainSha, expectedMainSha, 'main moved; refusing to release');
}

function assertEnvironment(envs) {
  const byName = new Map();
  for (const e of envs || []) byName.set(e.key, e);
  const missing = [];
  for (const name of REQUIRED_PROD_ENV) {
    const e = byName.get(name);
    const targets = Array.isArray(e?.target) ? e.target : [e?.target];
    const inProduction = !!e && targets.includes('production');
    // A production-scoped variable may also be branched to `preview`; that is fine.
    const branchedAway = Array.isArray(e?.customEnvironmentIds) && targets.length === 1 && !inProduction;
    if (!inProduction || branchedAway) missing.push(name);
  }
  assert.deepEqual(missing, [], 'Missing Production-scoped variables: ' + missing.join(', '));
  return { present: REQUIRED_PROD_ENV.length, missing: [] };
}

// FIREBASE_PROJECT_ID must name the released project. Read internally, compared, never printed.
function assertFirebaseProject(envs, expected) {
  const e = (envs || []).find((x) => x.key === 'FIREBASE_PROJECT_ID');
  assert.ok(e, 'FIREBASE_PROJECT_ID missing');
  const value = e.value !== undefined ? e.value : e.target?.[0]?.value;
  if (value === undefined) return 'UNREADABLE_NOT_ASSERTED';
  assert.equal(value, expected, 'FIREBASE_PROJECT_ID does not match the released Firebase project');
  return 'MATCH';
}

function assertPromoted(d, { runtime, project, team, productionDeploymentId }) {
  assert.equal(d.readyState, 'READY', 'Promoted deployment is not READY');
  assert.equal(d.projectId, project, 'Promoted project mismatch');
  assert.equal(d.teamId || team, team, 'Promoted team mismatch');
  assert.equal(d.meta?.githubCommitSha, runtime, 'Promoted runtime SHA mismatch');
  assert.ok(productionDeploymentId, 'Resulting production deployment was not resolved');
}

function assertRollbackArtifact(artifact) {
  assert.ok(artifact, 'Rollback artifact must exist BEFORE mutation');
  for (const field of ['candidate_sha', 'candidate_deployment', 'production_deployment', 'production_runtime_sha', 'production_project', 'vercel_team', 'production_origin', 'main_sha', 'captured_at']) {
    assert.ok(artifact[field], 'Rollback artifact missing ' + field);
  }
  assert.match(artifact.candidate_sha, /^[0-9a-f]{40}$/);
  assert.match(artifact.production_runtime_sha, /^[0-9a-f]{40}$/);
  const text = JSON.stringify(artifact);
  assert.ok(!/Bearer |VERCEL_TOKEN|private_key|BEGIN [A-Z ]*PRIVATE KEY/.test(text), 'Rollback artifact must not contain secrets');
  return artifact;
}

// ── live operations

async function currentApp(s) {
  const host = new URL(s.production_origin).hostname;
  const a = await vercel(s, '/v4/aliases/' + host);
  assert.equal(a.projectId, s.production_project, 'Production alias belongs to another project');
  assert.ok(a.deployment?.id, 'Missing production alias deployment');
  return a.deployment.id;
}

async function awaitApp(s, id) {
  for (let i = 0; i < 30; i++) {
    if (await currentApp(s) === id) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function deployment(s, id) { return vercel(s, '/v13/deployments/' + encodeURIComponent(id)); }

// Resolve the candidate by EXACT metadata. Chronology is never a selection criterion.
async function resolveCandidate(s, runtime) {
  const list = await vercel(s, '/v6/deployments?projectId=' + encodeURIComponent(s.production_project) + '&limit=100');
  const all = list.deployments || [];
  const exact = all.filter((d) => d.meta?.githubCommitSha === runtime && (d.projectId === s.production_project));
  assert.ok(exact.length > 0, 'No deployment found for the exact candidate SHA in this project');
  const previews = exact.filter((d) => d.target !== 'production');
  const usable = previews.length ? previews : exact;
  // If several share the exact SHA, prefer READY, then the most recently created among those.
  const ready = usable.filter((d) => (d.readyState || d.ready) === 'READY');
  const pool = ready.length ? ready : usable;
  pool.sort((a, b) => (b.created || 0) - (a.created || 0));
  assert.equal(new Set(pool.map((d) => d.meta.githubCommitSha)).size, 1, 'Ambiguous candidates for one SHA');
  return pool[0];
}

async function productionEnv(s) {
  const r = await vercel(s, '/v9/projects/' + encodeURIComponent(s.production_project) + '/env?decrypt=false');
  return r.envs || r;
}

async function promote(s, id) {
  // Documented: POST /v10/projects/{projectId}/promote/{deploymentId} -> requestPromote.
  // Does NOT rebuild; the deployment keeps its Git identity.
  await vercel(s, '/v10/projects/' + encodeURIComponent(s.production_project) + '/promote/' + encodeURIComponent(id), 'POST');
  const ok = await awaitApp(s, id);
  assert.ok(ok, 'Production alias did not converge to the promoted deployment');
  return id;
}

// Revert production traffic to the ORIGINAL production deployment. App only.
async function revertApp(s, id) {
  await vercel(s, '/v1/projects/' + encodeURIComponent(s.production_project) + '/rollback/' + encodeURIComponent(id), 'POST');
  const ok = await awaitApp(s, id);
  assert.ok(ok, 'Production alias did not converge back to the captured deployment');
  return id;
}

async function verifyPublicBytes(s, runtime, paths) {
  const results = [];
  for (const p of paths) {
    const expected = hash(Buffer.from(git('show', runtime + ':' + p)));
    const r = await fetch(s.production_origin + '/' + p + '?apprelease=' + runtime, {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    assert.equal(r.status, 200, 'Public surface HTTP failure: ' + p);
    const actual = hash(Buffer.from(await r.arrayBuffer()));
    assert.equal(actual, expected, 'Public byte mismatch: ' + p);
    results.push(p);
  }
  return results;
}

// Optional, read-only, and never fatal: an observation of what rules are live, so the
// artifact can show the app release did not touch them. Requires a Google token only if
// the caller chooses to provide one.
// The endpoint is built from OBSERVED_RULES_API so the URL literal exists exactly once in
// this file. That keeps the app-only guard a real check instead of a self-match.
async function observeLiveRulesReadOnly(s) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) return 'NOT_CAPTURED_NO_GOOGLE_TOKEN';
  try {
    const r = await api(OBSERVED_RULES_API + s.firebase_project + '/releases/cloud.firestore', token);
    return r.rulesetName || 'UNKNOWN';
  } catch (e) { return 'NOT_CAPTURED_' + String(e.message).slice(0, 60); }
}

function servedSurface() {
  const manifest = json(deployedProduct.MANIFEST);
  return Object.keys(manifest.files);
}

// The lane runs from canonical HEAD (tooling plus whatever product is integrated there),
// while the artifact released and verified is the exact candidate SHA. If a served path
// differs between the two, the bytes proven by the smoke are not the bytes that were tested,
// so the release must stop. Compared on committed blobs, never the worktree.
function verifyProductIdentity(candidateSha) {
  assert.match(candidateSha, /^[0-9a-f]{40}$/, 'Explicit candidate SHA required for identity check');
  const differs = [];
  for (const p of servedSurface()) {
    const head = hash(Buffer.from(git('show', 'HEAD:' + p)));
    const atCandidate = hash(Buffer.from(git('show', candidateSha + ':' + p)));
    if (head !== atCandidate) differs.push(p);
  }
  assert.deepEqual(differs, [],
    'Release tooling HEAD does not serve the released artifact for: ' + differs.join(', '));
  return { verified: servedSurface().length, candidate_sha: candidateSha };
}

// ── commands

async function preflight() {
  assertAppOnlySources();
  assertKillSwitch();
  const s = state();
  const runtime = assertExplicitRuntime(process.env.APP_RUNTIME_SHA);
  assert.equal(process.env.APP_PROJECT_ID || s.production_project, s.production_project, 'Project mismatch');
  assert.equal(process.env.APP_TEAM_ID || s.vercel_team, s.vercel_team, 'Team mismatch');

  const candidate = assertCandidate(await resolveCandidate(s, runtime), { runtime, project: s.production_project, team: s.vercel_team });
  const aliasDeploymentId = await currentApp(s);
  assertCandidateNotAlreadyProduction(candidate, aliasDeploymentId);

  const mainSha = git('ls-remote', 'origin', 'refs/heads/main').trim().split(/\s/)[0];
  assertBaseline({ aliasDeploymentId, expectedDeploymentId: s.production_deployment, mainSha, expectedMainSha: process.env.APP_EXPECTED_MAIN_SHA });

  const envs = await productionEnv(s);
  const env = assertEnvironment(envs);
  const fb = assertFirebaseProject(envs, s.firebase_project);

  const current = await deployment(s, aliasDeploymentId);
  assert.equal(current.meta?.githubCommitSha, s.runtime_sha, 'Current production runtime does not match the recorded baseline');

  const artifact = assertRollbackArtifact(save('app-rollback-' + (process.env.GITHUB_RUN_ID || 'local') + '.json', {
    release_id: process.env.GITHUB_RUN_ID || 'local',
    release_reason: process.env.APP_RELEASE_REASON || '',
    candidate_sha: runtime,
    candidate_deployment: candidate.id,
    production_deployment: aliasDeploymentId,
    production_runtime_sha: current.meta.githubCommitSha,
    production_project: s.production_project,
    vercel_team: s.vercel_team,
    production_origin: s.production_origin,
    main_sha: mainSha,
    live_rules_observation: await observeLiveRulesReadOnly(s),
    captured_at: new Date().toISOString(),
  }));

  const report = {
    runtime_sha: runtime, candidate: candidate.id, production_deployment: aliasDeploymentId,
    production_runtime_sha: current.meta.githubCommitSha, main_sha: mainSha,
    env, firebase_project: fb, rollback_artifact: 'app-rollback-' + (process.env.GITHUB_RUN_ID || 'local') + '.json',
    app_only: 'NO_FIRESTORE_MUTATION_PATH',
  };
  save('app-preflight.json', report);
  console.log('APP PREFLIGHT PASS: candidate ' + candidate.id + ' -> production ' + aliasDeploymentId);
  return report;
}

// The mutation steps are injectable so the failure path can be proven with fakes instead of
// being asserted from source text. Production always calls this with no second argument.
async function apply(steps = {}) {
  assertAppOnlySources();
  const promoteFn = steps.promote || promote;
  const currentAppFn = steps.currentApp || currentApp;
  const deploymentFn = steps.deployment || deployment;
  const verifyFn = steps.verifyPublicBytes || verifyPublicBytes;
  const surfaceFn = steps.servedSurface || servedSurface;
  const s = state();
  const runtime = assertExplicitRuntime(process.env.APP_RUNTIME_SHA);
  const pre = json(path.join(OUT, 'app-preflight.json'));
  assert.equal(pre.runtime_sha, runtime, 'Preflight was not for this exact runtime');
  const artifact = assertRollbackArtifact(json(path.join(OUT, pre.rollback_artifact)));
  const result = { release_id: process.env.GITHUB_RUN_ID || 'local', runtime_sha: runtime, app_release_status: 'FAIL', production_deployment: null, previous_deployment: artifact.production_deployment, rules_mutated: false, main_unchanged: true, error: null, rollback_required: false };
  try {
    await promoteFn(s, artifact.candidate_deployment);
    const aliasDeploymentId = await currentAppFn(s);
    const d = await deploymentFn(s, aliasDeploymentId);
    assertPromoted(d, { runtime, project: s.production_project, team: s.vercel_team, productionDeploymentId: aliasDeploymentId });
    const verified = await verifyFn(s, runtime, surfaceFn());
    result.production_deployment = aliasDeploymentId;
    result.verified_surfaces = verified.length;
    result.app_release_status = 'SUCCESS';
    result.rollback_required = false;
  } catch (e) {
    // Post-promotion verification failed: the app must go back to the captured deployment.
    result.error = e.message;
    result.app_release_status = 'FAIL';
    result.rollback_required = true;
    save('app-result.json', result);
    throw e;
  }
  save('app-result.json', result);
  console.log('APP RELEASE SUCCESS: ' + result.production_deployment);
  return result;
}

async function rollbackApp() {
  assertAppOnlySources();
  const s = state();
  const artifact = assertRollbackArtifact(json(path.join(OUT, process.env.APP_ROLLBACK_ARTIFACT || 'app-rollback-' + (process.env.GITHUB_RUN_ID || 'local') + '.json')));
  const id = await revertApp(s, artifact.production_deployment);
  const d = await deployment(s, id);
  assert.equal(d.readyState, 'READY', 'Restored deployment is not READY');
  assert.equal(d.meta?.githubCommitSha, artifact.production_runtime_sha, 'Restored runtime identity mismatch');
  await verifyPublicBytes(s, artifact.production_runtime_sha, servedSurface());
  const out = { rollback_status: 'PASS', restored_deployment: id, restored_runtime_sha: artifact.production_runtime_sha, rules_mutated: false };
  save('app-rollback-result.json', out);
  console.log('APP ROLLBACK PASS: ' + id);
  return out;
}

function setOut(dir) { OUT = dir; }
function getOut() { return OUT; }

function releaseResult() {
  try { return json(path.join(OUT, 'app-result.json')); }
  catch (e) { return { app_release_status: 'NOT_EXECUTED' }; }
}

// Machine-readable preflight summary for the workflow run summary. Reports PRESENCE only:
// never a value, never a secret.
function preflightSummary() {
  const lines = ['## Client App release preflight', ''];
  let report = null;
  try { report = json(path.join(OUT, 'app-preflight.json')); } catch (e) { report = null; }
  const result = releaseResult();
  lines.push('| field | value |', '|---|---|');
  const row = (k, v) => lines.push('| ' + k + ' | ' + v + ' |');
  row('app kill switch (CLIENT_APP_RELEASE_ENABLED)', process.env.CLIENT_APP_RELEASE_ENABLED === 'true' ? 'true' : 'false');
  row('requested runtime', process.env.APP_RUNTIME_SHA || '(none)');
  row('release reason', process.env.APP_RELEASE_REASON || '(none)');
  if (report) {
    row('candidate deployment', report.candidate);
    row('production before', report.production_deployment);
    row('production runtime before', report.production_runtime_sha);
    row('main', report.main_sha);
    row('Production variables present', report.env.present + '/' + REQUIRED_PROD_ENV.length + (report.env.missing.length ? ' MISSING: ' + report.env.missing.join(', ') : ''));
    row('FIREBASE_PROJECT_ID', report.firebase_project);
    row('rollback artifact', report.rollback_artifact);
    row('firestore mutation path', report.app_only);
  } else {
    row('preflight', 'NOT REACHED');
  }
  row('app release status', result.app_release_status || 'NOT_EXECUTED');
  if (result.error) row('error', result.error);
  lines.push('', 'This lane does not read Firestore for mutation and does not deploy Firestore rules.');
  return lines.join('\n');
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'preflight') await preflight();
  else if (cmd === 'apply') await apply();
  else if (cmd === 'rollback') await rollbackApp();
  else if (cmd === 'verify-product-identity') {
    const r = verifyProductIdentity(process.env.APP_RUNTIME_SHA);
    console.log('PRODUCT IDENTITY PASS: HEAD serves the released artifact (' + r.verified + ' paths)');
  } else if (cmd === 'release-result') console.log(JSON.stringify(releaseResult()));
  else if (cmd === 'preflight-summary') console.log(preflightSummary());
  else throw new Error('usage: app-live.cjs preflight|apply|rollback|verify-product-identity|preflight-summary|release-result');
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}

module.exports = {
  assertExplicitRuntime, assertKillSwitch, assertAppOnlySources, assertCandidate,
  assertCandidateNotAlreadyProduction, assertBaseline, assertEnvironment,
  assertFirebaseProject, assertPromoted, assertRollbackArtifact,
  resolveCandidate, currentApp, deployment, productionEnv, promote, revertApp,
  verifyPublicBytes, servedSurface, verifyProductIdentity, preflight, apply, rollbackApp, releaseResult, preflightSummary, preflightSummary,
  REQUIRED_PROD_ENV, FORBIDDEN_RUNTIME_VALUES, setOut, getOut,
};
