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
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { hash, json, git, gitBinary, assertReleaseMode } = require('./lib.cjs');
const deployedProduct = require('./deployed-product.cjs');
const numericGuard = require('./numeric-guard.cjs');

const STATE = '.release/vdsen-client.json';
// Reviewed immutable OFF build; distinct from the currently serving T663 deployment.
// `evidenceArtifactDigest` pins the GitHub-reported digest of artifact `app-release-result-<run>` of the official run
// (read from the authenticated Actions API during T677 review; reviewers can re-read it). It is a provenance anchor reviewed
// in the repository; the locally computed `evidenceSha256` is only tamper evidence of what was downloaded.
const SAFE_OFF_BASELINE = Object.freeze({ runtimeSha: '21dc0e2b211facfb0df9f3079c58488c2f86952c', deployment: 'dpl_BDdGBRjtRotiv4nJJEDoZK57He9s', officialReleaseRun: '40688365774',
  evidenceArtifactDigest: 'sha256:27e222d6d8e4bd0d02ebd6d8f00fd550ae665923e7893b0c0221ccae1fc34131' });
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
  return data; // callers assert on the persisted artifact, so return what was written
};

// `body` is optional on purpose: an empty body would be serialised as the literal
// string "undefined" and rejected by the API.
//
// `required` distinguishes the credential this lane genuinely needs (the Vercel token, which
// every call here uses) from a purely optional one. A blanket assertion previously killed the
// preflight with "Missing workflow credential" whenever GOOGLE_ACCESS_TOKEN was absent — and
// this APP-ONLY lane deliberately has no Google authentication at all.
// Measured: the SAME read returns 200 in one run and 400 minutes later with identical
// parameters (`/v7/deployments`, and `/v4/aliases/{hostname}` before it). The Vercel API is
// intermittently unhealthy for these reads. Retry the transient statuses on idempotent GETs
// with bounded backoff. NEVER retry 401/403: those are credential failures and must fail fast.
const RETRYABLE_STATUS = new Set([400, 408, 425, 429, 500, 502, 503, 504]);
const RETRY_ATTEMPTS = 2; // the poll repeats anyway; many retries amplified load and drew HTTP 400

async function api(url, token, method = 'GET', body, acceptStatus, required = true) {
  if (required) assert.ok(token, 'Missing workflow credential');
  else if (!token) throw new Error('credential not provided');
  let last = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    // Only declare a JSON content type when a body is actually sent. Announcing
    // `Content-Type: application/json` with no body makes the request semantically invalid and
    // Vercel answers HTTP 422 - which is exactly how both the promote and the rollback failed
    // on the first attempt that got past the preflight.
    const headers = { Authorization: 'Bearer ' + token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (acceptStatus && r.status === acceptStatus) return { status: r.status };
    if (r.ok) {
      const text = await r.text();
      return text ? JSON.parse(text) : {};
    }
    // Identify WHICH operation failed without ever printing a token or a response body.
    // The path is not secret; query values are stripped because they carry the team id.
    let where = url;
    try { where = new URL(url).pathname; } catch (e) {}
    last = new Error('API ' + method + ' ' + where + ' failed: HTTP ' + r.status);
    const retryable = method === 'GET' && RETRYABLE_STATUS.has(r.status);
    if (!retryable || attempt === RETRY_ATTEMPTS) throw last;
    await new Promise((res) => setTimeout(res, 400 * attempt));
  }
  throw last;
}
// Traza REDACTADA: nombres de parametros y longitudes, nunca valores. Sirve para comparar la
// peticion que funciona (diagnostico) con la que falla (preflight) sin exponer credenciales.
function redactUrl(url) {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()].map(([k, v]) => k + '=' + String(v).length + 'ch');
    return u.origin + u.pathname + '?' + params.join('&');
  } catch (e) { return '(unparseable)'; }
}
// Build the Vercel request URL. The query separator MUST depend on whether the path already
// has one.
//
// This was the real cause of every HTTP 400 in the preflight, and it survived several rounds of
// "fix the endpoint" because the symptom looked like a retired endpoint:
//   path with a query   -> VERCEL_API + p + '?teamId=..'  produced  '..?projectId=X&limit=40?teamId=Y'
//                          -> malformed, upstream answers 400
//   path without query  -> '..?teamId=Y'                  -> fine
// That is exactly why `/v4/aliases/{host}` worked while `/v7/deployments?...` and
// `/v6/deployments?...` never did. The independent diagnostic missed it because it built its
// own URLs and never used this wrapper.
function vercelUrl(s, p) {
  const sep = p.includes('?') ? '&' : '?';
  return VERCEL_API + p + sep + 'teamId=' + encodeURIComponent(s.vercel_team);
}
const vercel = (s, p, method, body, acceptStatus) => {
  const url = vercelUrl(s, p);
  if (process.env.APP_TRACE_READS === 'true') console.log('VERCEL READ ' + redactUrl(url));
  return api(url, process.env.VERCEL_TOKEN, method, body, acceptStatus);
};

// T641: proof that Numeric Apply is OFF in the Vercel PRODUCTION environment the deployment is built from (see numeric-guard.cjs). GET only; fail closed; no override.
// `vercelGet` goes through the same wrapper as every other read of this lane (same credential, same retry policy, never a response body in an error).
function numericGuardEvidence(s, runtime) {
  return numericGuard.collectEvidence(s, runtime, { git, vercelGet: (p) => vercel(s, p) });
}

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
  // Symmetric with the rules lane, which requires `rules_only`. Both lanes read the same reviewed
  // state, so the state now records WHICH release is intended and neither lane can be driven by the
  // other's baseline. Only the mutation entry points call this (staging and promote); the read-only
  // preflight deliberately does not, so diagnostics keep working while a state is being prepared.
  assertReleaseMode(state(), 'app_only', 'Client App release lane');
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
  // Vercel only populates `target` for production (`'production'`). A preview deployment
  // reports it as null/absent, so requiring target === 'preview' rejected a perfectly valid
  // candidate. What matters is that the candidate is NOT already serving production.
  assert.ok(c.target === null || c.target === undefined || c.target === 'preview',
    'Candidate must not already be a production deployment (target=' + c.target + ')');
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

function assertPromoted(d, { runtime, project, team, productionDeploymentId, targetDeployment }) {
  // Exact identity first: sharing the commit SHA is NOT equivalence. A different deployment of the same commit (another
  // actor's build, a preview, an older staged build) must never be reported as the authorized promotion.
  assert.ok(targetDeployment, 'The authorized target deployment is required to verify the promotion');
  assert.equal(productionDeploymentId, targetDeployment, 'Production alias does not point to the authorized deployment');
  if (d.id !== undefined || d.uid !== undefined) assert.equal(d.id || d.uid, targetDeployment, 'Observed deployment id does not match the authorized deployment');
  assert.equal(d.readyState, 'READY', 'Promoted deployment is not READY');
  assert.equal(d.projectId, project, 'Promoted project mismatch');
  assert.equal(d.teamId || team, team, 'Promoted team mismatch');
  // The staged deploy stamps `-m githubCommitSha=<candidate>`, so the identity MUST be present and
  // equal. A CLI deploy uploads a tree, not a git ref, and Vercel leaves this metadata null unless
  // it is set explicitly - which is what made this gate fail with 'Promoted runtime SHA mismatch'
  // after the promotion itself had already succeeded. The requirement is kept strict instead of
  // accepting a missing value, because that value is the only server-side link between the running
  // deployment and the approved commit.
  assert.ok(d.meta && d.meta.githubCommitSha, 'Promoted deployment carries no commit identity');
  assert.equal(d.meta.githubCommitSha, runtime, 'Promoted runtime SHA mismatch');
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

// Validate authenticated official build evidence independently of the serving alias.
async function verifySafeOffBaseline(s, downloadEvidence = false, deploymentFn = deployment) {
  const B = require('../pilot/off-baseline.cjs'), b = SAFE_OFF_BASELINE;
  assert.equal(s.runtime_sha, b.runtimeSha, 'SAFE_OFF_BASELINE_RUNTIME_MISMATCH');
  const historical = Object.assign({}, s, { runtime_sha: b.runtimeSha, production_deployment: b.deployment,
    app_release: Object.assign({}, s.app_release, { runtime_sha: b.runtimeSha, deployment: b.deployment, source_release_run: b.officialReleaseRun }) });
  if (downloadEvidence) B.download(historical, b);
  return B.load(historical, b, await deploymentFn(s, b.deployment));
}
function assertSafeRollbackProof(artifact, proof) {
  const b = SAFE_OFF_BASELINE;
  assert.ok(proof && proof.status === 'OFF_AT_IMMUTABLE_BUILD', 'SAFE_OFF_PROOF_REQUIRED');
  assert.equal(proof.deployment, b.deployment, 'SAFE_OFF_DEPLOYMENT_MISMATCH');
  assert.equal(String(proof.officialReleaseRun), b.officialReleaseRun, 'SAFE_OFF_RUN_MISMATCH');
  assert.match(proof.evidenceSha256 || '', /^[a-f0-9]{64}$/, 'SAFE_OFF_EVIDENCE_INVALID');
  assert.equal(artifact.production_runtime_sha, b.runtimeSha, 'SAFE_OFF_RUNTIME_MISMATCH');
  assert.equal(artifact.safe_off_deployment, b.deployment, 'SAFE_OFF_TARGET_MISMATCH');
  assert.equal(artifact.safe_off_evidence_sha256, proof.evidenceSha256, 'SAFE_OFF_EVIDENCE_CHANGED');
  return proof;
}

// ── live operations

// Resolve the deployment serving production from the project's own deployment list, filtered
// by `target=production`.
//
// Retired/broken reads replaced here, all previously invisible because the rules lane never
// changes the app (release_mode is rules_only), so its code path never actually ran:
//   - GET /v4/aliases/{hostname}  -> HTTP 400 for this project
//   - GET /v6/deployments         -> HTTP 400: /v6 is no longer documented. The published
//                                    OpenAPI spec lists only /v7 and /v13.
//   - the list returns `uid`, not `id` -> every downstream comparison matched nothing.
// /v7 supports both `projectId` and `target`.
const DEPLOYMENTS_LIST = '/v7/deployments';
const LIST_LIMIT = 40; // smaller page: a full 100-entry page is heavier than this lane needs

// Vercel's deployment list identifies a deployment as `uid`, while the single-deployment
// endpoint and the promote/rollback paths use `id`. Normalising here keeps every downstream
// comparison (`currentApp`, `awaitApp`, the promoted-deployment check) meaningful.
// Measured, not assumed: on a real production entry, `uid` is present and `id` is absent.
function normalizeDeployment(d) {
  if (!d) return d;
  if (d.id === undefined && d.uid !== undefined) d.id = d.uid;
  return d;
}

async function listDeployments(s, extra = '') {
  const list = await vercel(s, DEPLOYMENTS_LIST + '?projectId=' + encodeURIComponent(s.production_project) + '&limit=' + LIST_LIMIT + extra);
  return (list.deployments || []).map(normalizeDeployment);
}

// Resolve the deployment serving production in ONE request.
//
// History, because three different approaches were tried here and the reason matters:
//   - GET /v6/deployments            -> retired, HTTP 400 (not in the published spec)
//   - GET /v7/deployments + target   -> works once, then HTTP 400 under repetition
//   - GET /v4/aliases/{hostname}     -> returns the live deployment directly
// `currentApp()` is called inside a convergence poll, so the list endpoint was being hit
// dozens of times per run; the alias answers the same question in a single call and never
// repeats. This is the live production identity read, so it must be both accurate and cheap.
async function currentApp(s) {
  const host = new URL(s.production_origin).hostname;
  const a = await vercel(s, '/v4/aliases/' + encodeURIComponent(host));
  assert.ok(a.deployment && (a.deployment.id || a.deployment.uid), 'Production alias has no deployment');
  assert.equal(a.projectId || s.production_project, s.production_project, 'Production alias belongs to another project');
  return a.deployment.id || a.deployment.uid;
}

// Convergence poll. Kept deliberately light: the previous version hit the deployment LIST
// endpoint up to 30 times per call, and with retries that was >100 requests, which is what the
// upstream started rejecting with HTTP 400. One alias read per attempt is enough.
async function awaitApp(s, id) {
  for (let i = 0; i < 20; i++) {
    if (await currentApp(s) === id) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

async function deployment(s, id) { return vercel(s, '/v13/deployments/' + encodeURIComponent(id)); }

// Resolve the candidate by EXACT metadata. Chronology is never a selection criterion.
async function resolveCandidate(s, runtime) {
  const { deployments, truncated } = await listDeploymentPages(s);
  const sel = selectCandidate(deployments, runtime, s);
  assert.notEqual(sel.status, 'AMBIGUOUS', 'Ambiguous candidates for one SHA');
  assert.ok(sel.status === 'OK', 'No deployment found for the exact candidate SHA in this project' + (truncated ? ' (deployment list truncated at the page cap)' : ''));
  return sel.candidate;
}

// Follows Vercel's pagination.next cursor (until) up to a hard page cap. A candidate beyond the cap
// is reported as truncated, never silently treated as nonexistent.
async function listDeploymentPages(s, maxPages = 10) {
  const out = [];
  let until = null, pages = 0;
  while (pages < maxPages) {
    const list = await vercel(s, DEPLOYMENTS_LIST + '?projectId=' + encodeURIComponent(s.production_project) + '&limit=' + LIST_LIMIT + (until ? '&until=' + encodeURIComponent(until) : ''));
    assert.ok(list && Array.isArray(list.deployments), 'Deployment list response is incomplete');
    out.push(...list.deployments.map(normalizeDeployment));
    pages += 1;
    const next = list.pagination && list.pagination.next;
    if (next === null || next === undefined || String(next) === until) return { deployments: out, truncated: false, pages };
    until = String(next);
  }
  return { deployments: out, truncated: true, pages };
}

// Pure selection shared by the release lane and the read-only diagnostics, so both always judge the
// SAME candidate. Exact Git identity + project; two distinct READY deployments for one SHA is
// ambiguous and refused rather than silently picked by order.
function selectCandidate(all, runtime, s) {
  const exact = all.filter((d) => d && d.meta?.githubCommitSha === runtime && (d.projectId === s.production_project));
  if (exact.length === 0) return { status: 'NOT_FOUND', candidate: null, matches: 0 };
  const previews = exact.filter((d) => d.target !== 'production');
  const usable = previews.length ? previews : exact;
  const ready = usable.filter((d) => (d.readyState || d.ready) === 'READY');
  const pool = ready.length ? ready : usable;
  const ids = new Set(pool.map((d) => d.id));
  if (ids.size !== 1) return { status: 'AMBIGUOUS', candidate: null, matches: ids.size };
  return { status: 'OK', candidate: pool[0], matches: 1 };
}

async function productionEnv(s) {
  const r = await vercel(s, '/v9/projects/' + encodeURIComponent(s.production_project) + '/env?decrypt=false');
  return r.envs || r;
}

// ── Staged production deployment ──────────────────────────────────────────────────────────────
//
// WHY THE PREVIEW MODEL WAS REPLACED
// The lane used to promote an ephemeral Preview deployment. Run 37629216025 showed the flaw: the
// approved candidate's Preview rotated away, so there was no artifact left to promote and the
// release became impossible through no fault of the code. That coupled a release to the lifetime
// of a Preview.
//
// THE DOCUMENTED MODEL NOW USED (verified against Vercel's own documentation AND the pinned CLI's
// own --help output, not copied from memory):
//
//   vercel deploy --prod --skip-domain     a Production deployment that is NOT assigned to the
//                                          production domains yet ("staged production")
//   vercel promote <url|deploymentId>      makes it current
//   vercel rollback                        restores the previous production deployment
//
// From Vercel's knowledge base, "Creating a staged production deployment":
//   "you can create staged production deployments that aren't immediately assigned to your
//    production domains ... Staged production deployments use production environment variables"
// And `vercel deploy --help` in the pinned CLI documents `--skip-domain` as:
//   "Disable the automatic promotion (aliasing) of [the deployment]"
//
// So the staged deployment is built with PRODUCTION variables (what the product needs), while the
// public production alias keeps serving the previous deployment until promote runs. The artifact is
// built fresh from the exact candidate tree, which removes the rotation coupling entirely.

// Exports the EXACT candidate tree into a clean directory. `git archive` writes only TRACKED files
// at that commit, so untracked release tooling or local edits can never leak into the artifact -
// which is what the lane requires ("No untracked release tooling may enter the product artifact").
function exportCandidateTree(sha, destDir) {
  assert.match(sha, /^[0-9a-f]{40}$/, 'Tree export requires a full commit SHA');
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  // `git archive` otherwise honours a Windows core.autocrlf setting and produces a
  // tree whose text bytes differ from the reviewed commit.  A staged deployment
  // must always be the exact Git blobs, irrespective of the runner checkout.
  const tar = spawnSync('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', sha], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  if (tar.status !== 0) {
    throw new Error('git archive failed for ' + sha + ': ' + String(tar.stderr || '').slice(0, 300));
  }
  const untar = spawnSync('tar', ['-xf', '-', '-C', destDir], { input: tar.stdout, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  if (untar.status !== 0) {
    throw new Error('tar extract failed: ' + String(untar.stderr || '').slice(0, 300));
  }
  return destDir;
}

// Proves the exported directory is byte-identical to the candidate commit for every path the
// product actually serves. A mismatch means the artifact is NOT the approved product.
function verifyExportedTree(sha, destDir, paths) {
  const mismatches = [];
  for (const p of paths) {
    // gitBinary, not git: `git()` decodes stdout as utf8 and would corrupt binary blobs (.jpg,
    // .ttf), so the hash could never match the exported file.
    const expected = hash(gitBinary('show', sha + ':' + p));
    const file = path.join(destDir, p);
    if (!fs.existsSync(file)) { mismatches.push(p + ' (missing)'); continue; }
    const actual = hash(fs.readFileSync(file));
    if (actual !== expected) mismatches.push(p + ' (hash)');
  }
  assert.equal(mismatches.length, 0, 'Exported tree does not match the candidate commit: ' + mismatches.join(', '));
  return paths.length;
}

// A staged deployment must be a PRODUCTION deployment that is not yet serving. `current` is the
// deployment the production alias resolves to right now.
function assertStaged(d, { project, team, current }) {
  assert.ok(d, 'Staged deployment must be readable');
  assert.equal(d.projectId, project, 'Staged deployment belongs to another project');
  const teamOk = d.teamId === undefined || d.teamId === null || d.teamId === team;
  assert.ok(teamOk, 'Staged deployment belongs to another team');
  assert.equal(d.target, 'production', 'Staged deployment must be a production-target deployment');
  assert.equal(d.readyState || d.ready, 'READY', 'Staged deployment is not READY');
  assert.notEqual(d.id || d.uid, current, 'Staged deployment is already the current production deployment');
}

// Runs a Vercel CLI command in a given working directory. The CLI prints its diagnostics to
// STDERR (not stdout), so both streams are captured and the error-looking lines are preferred.
function runVercelCli(args, cwd, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', 'vercel@' + VERCEL_CLI_VERSION].concat(args), {
      cwd,
      env: Object.assign({}, process.env, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, out, err: 'spawn failed: ' + e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// Keeps the DIAGNOSTIC lines and drops npm/install chatter, which npx prints last and which used
// to hide the real error when only the tail was captured.
function diagnosticLines(out, err) {
  const all = (String(err) + '\n' + String(out))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(npm |i@|added \d|package|found \d|Vercel CLI \d)/.test(l));
  const errs = all.filter((l) => /error|failed|not |cannot|unable|forbidden|denied|422|403|401|invalid|refus|missing/i.test(l));
  return (errs.length ? errs : all).slice(0, 8).join(' | ');
}

// Creates EXACTLY ONE staged production deployment from the authorized candidate tree.
//
// Guarantees, all required by the lane contract:
//  - the source is `git archive` of the EXACT candidate SHA, never the working tree or HEAD
//  - it is built with the PRODUCTION target, and therefore production variables
//  - `--skip-domain` keeps the production alias on the previous deployment
//  - project and team are established explicitly, not from an accidental local link
//  - the CLI version is pinned
async function stageProduction() {
  assertKillSwitch();
  assertAppOnlySources();
  const s = state();
  const runtime = assertExplicitRuntime(process.env.APP_RUNTIME_SHA);
  const outDir = path.resolve(process.env.APP_STAGE_DIR || path.join(os.tmpdir(), 'vdsen-staged-' + runtime.slice(0, 12)));
  const surface = servedSurface();

  // 0. T641 gate BEFORE anything is exported, built or created: Numeric Apply must be provably OFF in the production environment, and the evidence must be the one the
  //    preflight captured (a change in between is a concurrent modification). A staged production deployment is built with the production variables, so refusing here
  //    also avoids creating a deployment that could run with a numeric switch ON.
  const pf = json(path.join(OUT, 'app-preflight.json'));
  const evidenceBefore = await numericGuardEvidence(s, runtime);
  numericGuard.assertPromotionAllowed({ preflight: pf.numeric_guard, fresh: evidenceBefore, expect: { project: s.production_project, team: s.vercel_team, runtimeSha: runtime } });

  // 1. exact tree
  exportCandidateTree(runtime, outDir);
  const verifiedPaths = verifyExportedTree(runtime, outDir, surface);

  // 2. the production alias must still be on the previous deployment BEFORE anything is built
  const currentBefore = await currentApp(s);
  const rollbackArtifact = assertRollbackArtifact(json(path.join(OUT, pf.rollback_artifact)));
  assertSafeRollbackProof(rollbackArtifact, await verifySafeOffBaseline(s));
  assert.equal(currentBefore, rollbackArtifact.production_deployment, 'BASELINE_MOVED_BEFORE_STAGE');
  if (process.env.GITHUB_ACTIONS === 'true') {
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'NO_JOB_RERUNS');
  }
  const intent = path.join(OUT, 'app-stage-intent.json');
  fs.writeFileSync(intent, JSON.stringify({ runtime_sha: runtime }), { flag: 'wx' });

  // 3. one staged production deployment, not aliased to any production domain
  //
  // The project and team are established through VERCEL_ORG_ID / VERCEL_PROJECT_ID, which is the
  // documented way to deploy non-interactively in CI. Passing them as flags does NOT work here:
  // `--scope` expects a team SLUG, not the `team_...` id, and passing the id made the CLI fail in
  // authentication with "Not able to load user because of unexpected error: User not found. (404)".
  // The deploy directory is a positional argument, which is the documented form.
  // `--json` so the deployment id comes straight from the CLI instead of being scraped from prose.
  // `-m githubCommitSha=<sha>` stamps the EXACT candidate identity onto the deployment. A CLI
  // deploy uploads a tree rather than a git ref, so Vercel leaves `meta.githubCommitSha` null and
  // the post-promotion identity gate had nothing to compare against. Stamping it keeps that gate
  // strict rather than relaxing it.
  const res = await runVercelCli(['deploy', outDir, '--prod', '--skip-domain', '--yes', '--json', '-m', 'githubCommitSha=' + runtime], outDir, {
    VERCEL_ORG_ID: s.vercel_team,
    VERCEL_PROJECT_ID: s.production_project,
  });
  if (res.code !== 0) {
    throw new Error('staged production deploy failed: ' + diagnosticLines(res.out, res.err));
  }
  const all = String(res.out) + '\n' + String(res.err);
  const urlMatch = all.match(/https:\/\/[A-Za-z0-9._-]+\.vercel\.app/);
  assert.ok(urlMatch, 'staged deploy did not report a deployment URL');
  const stagedUrl = urlMatch[0];
  // Prefer the id from the JSON output. `--json` is not guaranteed on every CLI version, so the
  // URL is still parsed as a fallback - and if only the URL is available, `/v13/deployments` wants
  // the HOSTNAME, never the full URL: passing `https%3A%2F%2F...` answers HTTP 404.
  let stagedId = null;
  try {
    const parsed = JSON.parse(String(res.out).trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() || 'null');
    if (parsed && (parsed.id || parsed.uid)) stagedId = parsed.id || parsed.uid;
  } catch (e) { stagedId = null; }
  if (!stagedId) stagedId = stagedUrl.replace(/^https:\/\//, '');

  // 4. resolve it and prove it is staged: production target, READY, and NOT current
  const d0 = await vercel(s, '/v13/deployments/' + encodeURIComponent(stagedId));
  normalizeDeployment(d0);
  assertStaged(d0, { project: s.production_project, team: s.vercel_team, current: currentBefore });
  // T641: bracket the staging: the variables must be unchanged AFTER the deployment was built, and the variable names Vercel reports for it must be explained by the evidence.
  const evidenceAfter = numericGuard.attachDeploymentEnv(await numericGuardEvidence(s, runtime), d0);
  numericGuard.assertPromotionAllowed({ preflight: pf.numeric_guard, staged: evidenceAfter, fresh: evidenceAfter, expect: { project: s.production_project, team: s.vercel_team, runtimeSha: runtime } });

  // 5. the public alias must NOT have moved
  const currentAfter = await currentApp(s);
  assert.equal(currentAfter, currentBefore, 'production alias moved during staging; refusing to continue');

  const report = {
    release_id: process.env.GITHUB_RUN_ID || 'local',
    staged_deployment: d0.id || d0.uid || stagedId,
    staged_url: stagedUrl,
    staged_target: d0.target,
    staged_ready_state: d0.readyState || d0.ready,
    candidate_sha: runtime,
    production_project: s.production_project,
    vercel_team: s.vercel_team,
    verified_paths: verifiedPaths,
    production_alias_before: currentBefore,
    production_alias_after: currentAfter,
    exported_tree: outDir,
    cli_version: VERCEL_CLI_VERSION,
    staged_at: new Date().toISOString(),
    numeric_guard: evidenceAfter,
  };
  assert.ok(!/Bearer |VERCEL_TOKEN|private_key|BEGIN [A-Z ]*PRIVATE KEY/.test(JSON.stringify(report)), 'staged report must not contain secrets');
  save('app-staged.json', report);
  return report;
}

// Promotion mechanism. Documented paths, tried in order:
//
//  1. `vercel promote <url>` - the mechanism Vercel documents for promoting a preview
//     deployment to production ("vercel promote"). The version is PINNED so a silent `latest`
//     can never be installed. It honours VERCEL_TOKEN and VERCEL_ORG_ID from the environment,
//     so no credential is passed on the command line.
//  2. POST /v10/projects/{id}/promote/{id} (operationId requestPromote), which is the same
//     operation over REST.
//
// The REST call answers HTTP 422 for this project even though the request matches the published
// schema exactly (requestBody present: false) and the candidate is READY, in the right project,
// at the right commit. 422 is a documented response of that operation, so the cause is
// eligibility rather than a malformed request - which is precisely why the CLI is tried first:
// it is the officially documented promotion tool and performs any additional steps the API does
// not.
//
// PINNED, and verified against the published changelog rather than guessed. The previous value
// (39.4.2) predated the `promote` subcommand, so the CLI returned its help text and the lane had
// to fall back to REST. 59.11.7 is the latest entry in packages/cli/CHANGELOG.md and `vercel
// promote` is documented at vercel.com/docs/cli/promote. Pinning keeps a silent `latest` out of a
// production release.
const VERCEL_CLI_VERSION = '59.11.7';

function promoteViaCli(s, id) {
  // Same reasoning as the staged deploy: project/team come from the environment, not from
  // `--project`/`--scope` flags (`--scope` wants a slug, not the team id).
  return runVercelCli(['promote', 'https://' + id + '.vercel.app', '--yes'], undefined, {
    VERCEL_ORG_ID: s.vercel_team,
    VERCEL_PROJECT_ID: s.production_project,
  }).then((res) => {
    if (res.code !== 0) return { ok: false, detail: diagnosticLines(res.out, res.err) };
    const m = String(res.out).match(/dpl_[A-Za-z0-9]+/);
    return { ok: true, deploymentId: m ? m[0] : id };
  });
}

async function promote(s, id) {
  const cli = await promoteViaCli(s, id);
  if (!cli.ok) {
    console.log('vercel CLI promotion did not succeed; falling back to the REST promote endpoint');
    if (cli.detail) console.log('  cli detail: ' + cli.detail.replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>'));
  }
  if (!cli.ok) {
    // Documented: POST /v10/projects/{projectId}/promote/{deploymentId} -> requestPromote.
    // Does NOT rebuild; the deployment keeps its Git identity.
    await vercel(s, '/v10/projects/' + encodeURIComponent(s.production_project) + '/promote/' + encodeURIComponent(id), 'POST');
  }
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
  // Skip anything not reachable over HTTP (see NOT_HTTP_SERVED): those paths are still verified at
  // the git level by verifyProductIdentity and verifyExportedTree.
  const fetchable = paths.filter((p) => !NOT_HTTP_SERVED.has(p));
  const results = [];
  for (const p of fetchable) {
    const expected = hash(gitBinary('show', runtime + ':' + p));
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
    // required=false: observing live rules is a courtesy for the audit trail, never a gate.
    const r = await api(OBSERVED_RULES_API + s.firebase_project + '/releases/cloud.firestore', token, 'GET', undefined, undefined, false);
    return r.rulesetName || 'UNKNOWN';
  } catch (e) { return 'NOT_CAPTURED_' + String(e.message).slice(0, 60); }
}

function servedSurface() {
  const manifest = json(deployedProduct.MANIFEST);
  return Object.keys(manifest.files);
}

// Paths that are part of the deployed artifact but are NOT reachable over HTTP, so they cannot be
// byte-compared through a public fetch. `vercel.json` is Vercel's own project configuration: it is
// uploaded and tracked in the artifact, and `verifyProductIdentity` compares it at the git level,
// but requesting /vercel.json answers 404. Comparing it over HTTP made the post-promotion
// verification fail with 'Public surface HTTP failure: vercel.json' even though production was
// serving exactly the right bytes - and because that failure happened after a successful
// promotion, it also triggered a needless recovery.
const NOT_HTTP_SERVED = new Set(['vercel.json']);
function httpServedSurface() {
  return servedSurface().filter((p) => !NOT_HTTP_SERVED.has(p));
}

// The lane runs from canonical HEAD (tooling plus whatever product is integrated there),
// while the artifact released and verified is the exact candidate SHA. If a served path
// differs between the two, the bytes proven by the smoke are not the bytes that were tested,
// so the release must stop. Compared on committed blobs, never the worktree.
function verifyProductIdentity(candidateSha) {
  assert.match(candidateSha, /^[0-9a-f]{40}$/, 'Explicit candidate SHA required for identity check');
  const differs = [];
  for (const p of servedSurface()) {
    const head = hash(gitBinary('show', 'HEAD:' + p));
    const atCandidate = hash(gitBinary('show', candidateSha + ':' + p));
    if (head !== atCandidate) differs.push(p);
  }
  assert.deepEqual(differs, [],
    'Release tooling HEAD does not serve the released artifact for: ' + differs.join(', '));
  return { verified: servedSurface().length, candidate_sha: candidateSha };
}

// ── commands

// Every read the preflight performs, split out so the READ-ONLY diagnostics workflow can run
// the EXACT same code path without arming the mutation kill switch. Duplicating these calls in
// a separate diagnostic is what let a failing read look healthy: it was a different code path.
async function readOnlyPreflight() {
  assertAppOnlySources();
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
  const numeric = await numericGuardEvidence(s, runtime);   // T641: Numeric Apply must be PROVEN off before anything is built or promoted

  const current = await deployment(s, aliasDeploymentId);
  assert.equal(current.meta?.githubCommitSha, s.runtime_sha, 'Current production runtime does not match the recorded baseline');

  return { s, runtime, candidate, aliasDeploymentId, mainSha, env, fb, current, numeric };
}

async function preflight() {
  assertKillSwitch();
  const { s, runtime, candidate, aliasDeploymentId, mainSha, env, fb, current, numeric } = await readOnlyPreflight();

  const safeProof = await verifySafeOffBaseline(s, true);
  const artifact = assertRollbackArtifact(save('app-rollback-' + (process.env.GITHUB_RUN_ID || 'local') + '.json', {
    release_id: process.env.GITHUB_RUN_ID || 'local',
    release_reason: process.env.APP_RELEASE_REASON || '',
    candidate_sha: runtime,
    candidate_deployment: candidate.id,
    production_deployment: aliasDeploymentId,
    production_runtime_sha: current.meta.githubCommitSha,
    safe_off_deployment: SAFE_OFF_BASELINE.deployment, safe_off_evidence_sha256: safeProof.evidenceSha256,
    production_project: s.production_project,
    vercel_team: s.vercel_team,
    production_origin: s.production_origin,
    main_sha: mainSha,
    live_rules_observation: await observeLiveRulesReadOnly(s),
    captured_at: new Date().toISOString(),
  }));

  assertSafeRollbackProof(artifact, safeProof);
  const report = {
    release_id: process.env.GITHUB_RUN_ID || 'local',
    runtime_sha: runtime, candidate: candidate.id, production_deployment: aliasDeploymentId,
    production_runtime_sha: current.meta.githubCommitSha, main_sha: mainSha,
    env, firebase_project: fb, numeric_guard: numeric, rollback_artifact: 'app-rollback-' + (process.env.GITHUB_RUN_ID || 'local') + '.json',
    app_only: 'NO_FIRESTORE_MUTATION_PATH',
  };
  save('app-preflight.json', report);
  console.log('APP PREFLIGHT PASS: candidate ' + candidate.id + ' -> production ' + aliasDeploymentId);
  return report;
}

// Reads the CURRENT production alias after an uncertain mutation. Failure is reported, never
// swallowed: an unreadable alias must not be mistaken for "nothing changed".
async function observeProduction(s, currentAppFn) {
  try {
    const id = await currentAppFn(s);
    return { id: id || null, error: null };
  } catch (e) {
    return { id: null, error: e && e.message ? e.message : String(e) };
  }
}

// Decides whether recovery may mutate. Pure: takes only observed values, so every branch is
// provable with a test and no network.
//
//   observed === previous                 -> NO_MUTATION, never call rollback
//   observed === expectedNew              -> MUTATED, rollback required
//   observed is some other deployment     -> UNEXPECTED, fail closed, rollback required
//   observed unreadable                   -> UNKNOWN,       fail closed, rollback required
//
// `rollback_required` may only be true when a mutation is observed OR cannot be ruled out.
function decideRecovery({ observed, observedError, previous, expectedNew }) {
  if (!observed) {
    return {
      mutation_status: 'UNKNOWN',
      rollback_required: true,
      reason: 'production could not be read after the mutation attempt, so a change cannot be ruled out' +
        (observedError ? ' (' + observedError + ')' : ''),
    };
  }
  if (observed === previous) {
    return {
      mutation_status: 'NO_MUTATION',
      rollback_required: false,
      reason: 'the promote attempt did not move production; the capture is still current, so rollback would be a meaningless mutation',
    };
  }
  if (observed === expectedNew) {
    return {
      mutation_status: 'MUTATED',
      rollback_required: true,
      reason: 'production now serves the candidate, so post-mutation verification failed and recovery is required',
    };
  }
  return {
    mutation_status: 'UNEXPECTED',
    rollback_required: true,
    reason: 'production serves neither the captured deployment nor the candidate, so it is unknown and must be recovered',
  };
}

// ── T677 evidence helpers (defined before apply/rollbackApp; pure or file-only, no network)

const ROLLBACK_ARTIFACT_NAME = /^app-rollback-[A-Za-z0-9_-]+\.json$/;
const releaseId = () => process.env.GITHUB_RUN_ID || 'local';

// MISSING and UNREADABLE are different facts. A write-ahead record that exists but cannot be parsed is evidence of an
// attempt we cannot interpret; it must never be collapsed into "nothing happened".
function readEvidence(name) {
  const file = path.join(OUT, name);
  if (!fs.existsSync(file)) return { status: 'MISSING', data: null };
  try { return { status: 'PRESENT', data: json(file) }; }
  catch (e) { return { status: 'UNREADABLE', data: null, error: String(e && e.message ? e.message : e).slice(0, 300) }; }
}

// The rollback artifact is selected by name, never by scanning the directory: environment override, else the name the
// preflight of THIS run recorded, else the name derived from the run id. Two disagreeing sources are rejected, not ranked.
function resolveRollbackArtifactName() {
  const fromEnv = process.env.APP_ROLLBACK_ARTIFACT || null;
  const pre = readEvidence('app-preflight.json');
  const fromPreflight = pre.status === 'PRESENT' && pre.data && pre.data.rollback_artifact ? pre.data.rollback_artifact : null;
  if (fromEnv && fromPreflight) assert.equal(fromEnv, fromPreflight, 'ROLLBACK_ARTIFACT_AMBIGUOUS: environment and preflight name different artifacts');
  const name = fromEnv || fromPreflight || 'app-rollback-' + releaseId() + '.json';
  assert.match(name, ROLLBACK_ARTIFACT_NAME, 'ROLLBACK_ARTIFACT_NAME_INVALID');
  return name;
}

// Every artifact consumed by a mutation or a recovery must belong to the run that is executing it. A missing run id is a
// rejection: it is how an artifact from another execution would otherwise be accepted silently.
function assertSameRelease(records) {
  const expected = releaseId();
  for (const [label, record] of Object.entries(records)) {
    if (!record) continue;
    assert.ok(record.release_id !== undefined && record.release_id !== null, 'ARTIFACT_RELEASE_MISSING: ' + label + ' carries no run id');
    assert.equal(String(record.release_id), expected, 'ARTIFACT_RELEASE_MISMATCH: ' + label + ' belongs to another run');
  }
}

// Links between the artifacts of one release: same candidate commit, same project and team, and a staged build that is
// neither the current production deployment nor derived from another baseline.
function assertCandidateLinkage({ pre, artifact, staged, runtime, s }) {
  assert.equal(artifact.candidate_sha, runtime, 'ARTIFACT_RUNTIME_MISMATCH: rollback artifact is for another commit');
  assert.equal(artifact.production_project, s.production_project, 'ARTIFACT_PROJECT_MISMATCH');
  assert.equal(artifact.vercel_team, s.vercel_team, 'ARTIFACT_TEAM_MISMATCH');
  assert.equal(pre.candidate, artifact.candidate_deployment, 'ARTIFACT_CANDIDATE_MISMATCH: preflight and rollback artifact name different candidates');
  assert.equal(pre.production_deployment, artifact.production_deployment, 'ARTIFACT_BASELINE_MISMATCH: preflight and rollback artifact captured different production deployments');
  if (staged) {
    assert.equal(staged.production_alias_before, artifact.production_deployment, 'STAGED_BASELINE_MISMATCH: the staged build was created against another production deployment');
    assert.notEqual(staged.staged_deployment, artifact.production_deployment, 'STAGED_IS_CURRENT_PRODUCTION');
  }
}

// Ids only, never a secret or a response body.
function recoveryEvidence({ artifact, staged, runtime, lastObserved, observedError }) {
  return {
    release_id: releaseId(),
    candidate_sha: (artifact && artifact.candidate_sha) || runtime || null,
    candidate_deployment: artifact ? artifact.candidate_deployment : null,
    staged_deployment: staged ? staged.staged_deployment : null,
    safe_off_deployment: SAFE_OFF_BASELINE.deployment,
    previous_deployment: artifact ? artifact.production_deployment : null,
    last_observed_deployment: lastObserved || null,
    observed_error: observedError ? String(observedError).slice(0, 300) : null,
  };
}

// A recovery that cannot prove the identity of production is a manual incident, recorded in the artifact the workflow
// already uploads (`app-*.json`). No automatic overwrite follows from it.
function recordManualRecovery(status, reason, evidence) {
  return save('app-rollback-result.json', { rollback_status: status, state: 'RECOVERY_REQUIRED', manual_recovery_required: true, reason, recovery_evidence: evidence, rules_mutated: false });
}

// The mutation steps are injectable so the failure path can be proven with fakes instead of
// being asserted from source text. Production always calls this with no second argument.
//
// RESIDUAL RISK (not removable here): Vercel's promote and rollback operations take only the project and the deployment
// id (no expected-current-deployment / If-Match style precondition is used or known to be offered), so there is no
// atomic compare-and-swap between "the alias is X" and "move the alias to Y". The window is narrowed, not closed:
// every identity read is placed immediately before the mutation, the alias is re-read after the public bytes are
// verified, and runs are serialized by the `vdsen-production` concurrency group. An actor outside that group (a
// dashboard user, another tool) can still move the alias inside the window; it is detected afterwards and reported as a
// manual recovery, never overwritten automatically.
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
  assert.match(String(pre.rollback_artifact), ROLLBACK_ARTIFACT_NAME, 'ROLLBACK_ARTIFACT_NAME_INVALID');
  const artifact = assertRollbackArtifact(json(path.join(OUT, pre.rollback_artifact)));
  // The promotion target is the STAGED PRODUCTION deployment built from the exact candidate tree,
  // not an ephemeral Preview. Falling back to the preview candidate keeps older runs reproducible,
  // but the staged artifact is what the current workflow produces.
  let staged = null;
  try { staged = json(path.join(OUT, 'app-staged.json')); } catch (e) { staged = null; }
  const targetDeployment = staged && staged.staged_deployment ? staged.staged_deployment : artifact.candidate_deployment;
  if (staged) {
    assert.ok(staged.staged_deployment && staged.numeric_guard, 'OFF_STAGED_EVIDENCE_REQUIRED');
    assert.equal(staged.candidate_sha, runtime, 'STAGED_RUNTIME_MISMATCH');
    assert.equal(staged.production_project, s.production_project, 'STAGED_PROJECT_MISMATCH');
    assert.equal(staged.vercel_team, s.vercel_team, 'STAGED_TEAM_MISMATCH');
  }
  // T677: every artifact must belong to THIS run and agree on candidate, project, team and baseline.
  assertSameRelease({ preflight: pre, 'rollback artifact': artifact, 'staged report': staged });
  assertCandidateLinkage({ pre, artifact, staged, runtime, s });
  // T641: last gate. Fresh evidence taken NOW must be DISARMED and identical to the evidence captured before and after staging, and none of it may be stale. There is no
  // override: without a successful proof the promotion is not attempted (nothing is mutated, no result claims otherwise).
  const guardFn = steps.numericGuard || numericGuardEvidence;
  numericGuard.assertPromotionAllowed({ preflight: pre.numeric_guard, staged: staged ? staged.numeric_guard : null, fresh: await guardFn(s, runtime),
    expect: { project: s.production_project, team: s.vercel_team, runtimeSha: runtime } });
  if (artifact.safe_off_deployment || steps.verifySafeOffBaseline || !steps.promote) {
    const verifySafeOffProofFn = steps.verifySafeOffBaseline || ((st) => verifySafeOffBaseline(st, false, deploymentFn));
    assertSafeRollbackProof(artifact, await verifySafeOffProofFn(s));
  }
  // T677: the LAST reads before the production request, placed after every slow gate above. The alias must still be the
  // captured baseline and the authorized target must still be the exact READY build of the approved commit.
  assert.equal(await currentAppFn(s), artifact.production_deployment, 'BASELINE_MOVED_BEFORE_PROMOTION');
  assertPromoted(normalizeDeployment(await deploymentFn(s, targetDeployment)), { runtime, project: s.production_project, team: s.vercel_team, productionDeploymentId: targetDeployment, targetDeployment });
  const result = { release_id: process.env.GITHUB_RUN_ID || 'local', runtime_sha: runtime, app_release_status: 'FAIL', production_deployment: null, previous_deployment: artifact.production_deployment, promotion_target: targetDeployment, promotion_model: staged ? 'staged_production' : 'preview_candidate', candidate_deployment: artifact.candidate_deployment, staged_deployment: staged ? staged.staged_deployment : null, safe_off_deployment: SAFE_OFF_BASELINE.deployment, rules_mutated: false, main_unchanged: true, error: null, rollback_required: false };
  // T677 write-ahead record: persisted BEFORE the production request. From here until the final result replaces it,
  // production is treated as possibly mutated (outcome UNKNOWN, recovery required). If the process dies after the request,
  // this file is what lets recovery tell an interrupted attempt from a run that never started. A failed write aborts here.
  save('app-result.json', Object.assign({}, result, { state: 'MUTATION_REQUESTED', mutation_status: 'UNKNOWN', rollback_required: true, requested_at: new Date().toISOString(), recovery_reason: 'promotion requested; its outcome was not recorded' }));
  try {
    await promoteFn(s, targetDeployment);
    const aliasDeploymentId = await currentAppFn(s);
    const d = await deploymentFn(s, aliasDeploymentId);
    assertPromoted(d, { runtime, project: s.production_project, team: s.vercel_team, productionDeploymentId: aliasDeploymentId, targetDeployment });
    const verified = await verifyFn(s, runtime, surfaceFn());
    // T677: the bytes were read over HTTP and say nothing about WHICH deployment answered. Re-read the alias after them;
    // a change here forbids VERIFIED and is handled by the recovery decision below.
    assert.equal(await currentAppFn(s), targetDeployment, 'ALIAS_CHANGED_AFTER_VERIFICATION: production no longer points to the authorized deployment');
    result.production_deployment = aliasDeploymentId;
    result.verified_surfaces = verified.length;
    result.app_release_status = 'SUCCESS';
    result.rollback_required = false;
    result.state = 'VERIFIED';
  } catch (e) {
    // ANY failure after the promote attempt used to set rollback_required = true unconditionally.
    // That was the false-recovery bug: a promote that returned 422 without moving traffic - which
    // is exactly what happened - was treated as a mutation, so recovery called rollback against a
    // deployment that was STILL the current production one. That produced a second 422 which said
    // nothing about whether rollback works after a REAL mutation.
    //
    // The invariant: an unsuccessful promote request does NOT imply production changed. Decide
    // from the observed production state, never from the fact that we asked.
    result.error = e.message;
    result.app_release_status = 'FAIL';
    result.state = 'MUTATION_REQUESTED';
    const observed = await observeProduction(s, currentAppFn);
    result.observed_production_deployment = observed.id;
    result.observed_error = observed.error;
    const decision = decideRecovery({ observed: observed.id, observedError: observed.error, previous: result.previous_deployment, expectedNew: targetDeployment });
    result.mutation_status = decision.mutation_status;
    result.rollback_required = decision.rollback_required;
    result.recovery_reason = decision.reason;
    result.state = decision.rollback_required ? 'RECOVERY_REQUIRED' : 'NO_MUTATION';
    if (result.rollback_required) result.production_deployment = observed.id;
    // T677: UNKNOWN (production unreadable) and UNEXPECTED (a deployment that is neither the baseline nor the target)
    // cannot be resolved by this lane. They are recorded as a manual recovery with the ids needed to act; the alias is
    // overwritten automatically only when it is observed on the staged build.
    if (decision.mutation_status === 'UNKNOWN' || decision.mutation_status === 'UNEXPECTED') {
      result.manual_recovery_required = true;
      result.recovery_evidence = recoveryEvidence({ artifact, staged, runtime, lastObserved: observed.id, observedError: observed.error });
    }
    save('app-result.json', result);
    throw e;
  }
  save('app-result.json', result);
  console.log('APP RELEASE SUCCESS: ' + result.production_deployment);
  return result;
}

async function rollbackApp() {
  const steps = arguments[0] || {};
  assertAppOnlySources();
  const s = state();
  const currentAppFn = steps.currentApp || currentApp;
  const revertAppFn = steps.revertApp || revertApp;
  const deploymentFn = steps.deployment || deployment;
  const verifyFn = steps.verifyPublicBytes || verifyPublicBytes;
  const surfaceFn = steps.servedSurface || servedSurface;
  const verifySafeOffFn = steps.verifySafeOffBaseline || (async (st) => verifySafeOffBaseline(st, false, deploymentFn));

  // Only revert if a promotion may have happened. The workflow calls this with `if: failure()`,
  // which also fires when an EARLIER gate (preflight, tests, kill switch) failed — in that case
  // production was never touched, and reverting would be a pointless mutation followed by a
  // confusing false failure.
  //
  // `app-result.json` is persisted BEFORE the production request (write-ahead), so a MISSING file means no promotion was
  // requested, while an UNREADABLE one is an attempt that cannot be interpreted and is never read as "nothing happened".
  const recorded = readEvidence('app-result.json');
  const result = recorded.data;
  let mustRecover = false;
  if (recorded.status === 'PRESENT') mustRecover = !result || result.rollback_required === true;
  else if (recorded.status === 'UNREADABLE') mustRecover = true;
  else {
    // No record. If a staged build exists, confirm production is not serving it before concluding nothing happened.
    const probe = readEvidence('app-staged.json');
    if (probe.status === 'UNREADABLE') mustRecover = true;
    else if (probe.status === 'PRESENT') {
      let seen = null, seenError = null;
      try { seen = await currentAppFn(s); } catch (e) { seen = null; seenError = e && e.message ? e.message : String(e); }
      if (!seen) {
        recordManualRecovery('MANUAL_RECOVERY_REQUIRED', 'no attempt record exists and production could not be read; its identity cannot be established', recoveryEvidence({ staged: probe.data, lastObserved: null, observedError: seenError }));
        throw new Error('PRODUCTION_ALIAS_UNREADABLE_MANUAL_RECOVERY_REQUIRED');
      }
      mustRecover = !!probe.data && seen === probe.data.staged_deployment;
    }
  }
  if (!mustRecover) {
    const out = { rollback_status: 'NOT_NEEDED', state: recorded.status === 'MISSING' ? 'NOT_STARTED' : 'NO_MUTATION', reason: 'no promotion was performed in this run', rules_mutated: false };
    save('app-rollback-result.json', out);
    console.log('APP ROLLBACK NOT NEEDED: production was never mutated in this run');
    return out;
  }
  const artifact = assertRollbackArtifact(json(path.join(OUT, resolveRollbackArtifactName())));
  assertSameRelease({ 'rollback artifact': artifact, 'release result': result });
  assertSafeRollbackProof(artifact, await verifySafeOffFn(s));
  // Final guard, independent of whatever asked for recovery: if the rollback target is ALREADY the
  // current production deployment there is nothing to restore, and issuing the call would be a
  // meaningless mutation whose failure would be misread as "rollback is broken". Re-read
  // production here instead of trusting the value captured earlier in the run.
  let currentId = null, currentError = null;
  if (steps.currentApp) {
    try { currentId = await steps.currentApp(s); } catch (e) { currentId = null; currentError = e && e.message ? e.message : String(e); }
  } else {
    try { currentId = await currentApp(s); } catch (e) { currentId = null; currentError = e && e.message ? e.message : String(e); }
  }
  if ((currentId && currentId === artifact.production_deployment) || currentId === SAFE_OFF_BASELINE.deployment) {
    const out = {
      rollback_status: 'NOT_NEEDED',
      state: 'NO_MUTATION',
      reason: 'production already serves the captured deployment; no rollback was issued',
      current_deployment: currentId,
      rules_mutated: false,
    };
    save('app-rollback-result.json', out);
    console.log('APP ROLLBACK NOT NEEDED: production already serves the captured deployment');
    return out;
  }
  const staged = json(path.join(OUT, 'app-staged.json'));
  assert.ok(staged && staged.staged_deployment && staged.numeric_guard, 'OFF_STAGED_EVIDENCE_REQUIRED');
  assertSameRelease({ 'staged report': staged });
  assert.equal(staged.candidate_sha, artifact.candidate_sha, 'STAGED_CANDIDATE_MISMATCH: staged report is for another commit');
  assert.equal(staged.production_project, artifact.production_project, 'STAGED_PROJECT_MISMATCH');
  assert.equal(staged.vercel_team, artifact.vercel_team, 'STAGED_TEAM_MISMATCH');
  if (!currentId) {
    recordManualRecovery('MANUAL_RECOVERY_REQUIRED', 'production could not be read before recovery; its identity cannot be established', recoveryEvidence({ artifact, staged, lastObserved: null, observedError: currentError }));
    throw new Error('PRODUCTION_ALIAS_UNREADABLE_MANUAL_RECOVERY_REQUIRED');
  }
  if (currentId !== staged.staged_deployment) {
    recordManualRecovery('MANUAL_RECOVERY_REQUIRED', 'production serves a deployment that is neither the captured baseline, the safe OFF target nor the staged build; it is not overwritten automatically', recoveryEvidence({ artifact, staged, lastObserved: currentId }));
    throw new Error('FOREIGN_ALIAS_NO_AUTOMATIC_OVERWRITE: production serves ' + currentId);
  }
  const id = steps.revertApp ? await steps.revertApp(s, SAFE_OFF_BASELINE.deployment) : await revertApp(s, SAFE_OFF_BASELINE.deployment);
  assert.equal(id, SAFE_OFF_BASELINE.deployment, 'RESTORED_DEPLOYMENT_MISMATCH: the restore did not return the safe OFF target');
  const d = await deploymentFn(s, id);
  assert.equal(d.readyState, 'READY', 'Restored deployment is not READY');
  assert.equal(d.meta?.githubCommitSha, SAFE_OFF_BASELINE.runtimeSha, 'Restored runtime identity mismatch');
  await verifyFn(s, SAFE_OFF_BASELINE.runtimeSha, surfaceFn());
  // Public bytes do not identify the deployment that served them: re-read the alias and require the exact safe OFF target
  // before claiming RECOVERED. If it cannot be proven, the incident is recorded as manual and RECOVERED is never written.
  let finalId = null, finalError = null;
  try { finalId = await currentAppFn(s); } catch (e) { finalId = null; finalError = e && e.message ? e.message : String(e); }
  if (finalId !== SAFE_OFF_BASELINE.deployment) {
    recordManualRecovery('RECOVERY_NOT_PROVEN', 'the alias could not be proven on the safe OFF target after verification', recoveryEvidence({ artifact, staged, lastObserved: finalId, observedError: finalError }));
    throw new Error('ALIAS_NOT_PROVEN_AFTER_RECOVERY: expected the safe OFF target');
  }
  const out = { rollback_status: 'PASS', state: 'RECOVERED', restored_deployment: id, restored_runtime_sha: SAFE_OFF_BASELINE.runtimeSha, verified_alias: finalId, rules_mutated: false };
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
    row('Numeric Apply proof (production env)', report.numeric_guard ? report.numeric_guard.status + ' [' + Object.entries(report.numeric_guard.flags).map(([k, v]) => k + ': ' + v).join('; ') + '] captured ' + report.numeric_guard.captured_at : 'MISSING');
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
  } else if (cmd === 'read-only-preflight') {
    // Runs the EXACT read path the release preflight uses, without the mutation kill switch.
    // This is what the diagnostics workflow calls: a separate probe re-implemented these reads
    // and reported them healthy while the real path failed.
    const r = await readOnlyPreflight();
    console.log('READ-ONLY PREFLIGHT PASS: candidate ' + r.candidate.id + ' -> production ' + r.aliasDeploymentId);
    console.log('NUMERIC APPLY PROOF: ' + r.numeric.status + ' (' + Object.entries(r.numeric.flags).map(([k, v]) => k + '=' + v).join(', ') + '; captured ' + r.numeric.captured_at + ')');
  } else if (cmd === 'stage') {
    // Creates EXACTLY ONE staged production deployment of the authorized candidate. This does NOT
    // move customer traffic: --skip-domain leaves the production alias on the previous deployment.
    const r = await stageProduction();
    console.log('APP STAGED DEPLOYMENT READY: ' + r.staged_deployment + ' (' + r.staged_url + ')');
  } else if (cmd === 'release-result') console.log(JSON.stringify(releaseResult()));
  else if (cmd === 'preflight-summary') console.log(preflightSummary());
  else throw new Error('usage: app-live.cjs read-only-preflight|preflight|stage|apply|rollback|verify-product-identity|preflight-summary|release-result');
}

if (require.main === module) {
  // Report the failing step by NAME, with the stage marker, so a gate never fails silently.
  // This lane has twice exited non-zero with no output, which made triage impossible.
  const stage = process.argv[2] || '(none)';
  const fail = (e, where) => {
    console.error('APP LANE FAILURE [' + stage + ']' + (where ? ' at ' + where : '') + ': ' + (e && e.message ? e.message : String(e)));
    if (e && e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
    process.exitCode = 1;
  };
  process.on('unhandledRejection', (e) => fail(e, 'unhandledRejection'));
  process.on('uncaughtException', (e) => fail(e, 'uncaughtException'));
  main().catch((e) => fail(e, 'main'));
}

module.exports = {
  SAFE_OFF_BASELINE, verifySafeOffBaseline, assertSafeRollbackProof, assertExplicitRuntime, assertKillSwitch, assertAppOnlySources, assertCandidate,
  assertCandidateNotAlreadyProduction, assertBaseline, assertEnvironment,
  assertFirebaseProject, assertPromoted, assertRollbackArtifact,
  resolveCandidate, selectCandidate, listDeploymentPages, currentApp, listDeployments, normalizeDeployment, deployment, productionEnv, promote, revertApp,
  verifyPublicBytes, servedSurface, httpServedSurface, NOT_HTTP_SERVED, verifyProductIdentity, readOnlyPreflight, preflight, apply, rollbackApp, releaseResult, preflightSummary, redactUrl, vercelUrl, preflightSummary,
  REQUIRED_PROD_ENV, FORBIDDEN_RUNTIME_VALUES, setOut, getOut,
  observeProduction, decideRecovery,
  exportCandidateTree, verifyExportedTree, assertStaged, stageProduction, runVercelCli, diagnosticLines, VERCEL_CLI_VERSION,
  readEvidence, resolveRollbackArtifactName, assertSameRelease, assertCandidateLinkage, recoveryEvidence, recordManualRecovery,
};
