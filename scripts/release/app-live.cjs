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
const { hash, json, git, gitBinary } = require('./lib.cjs');
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
  const all = await listDeployments(s);
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
  const tar = spawnSync('git', ['archive', '--format=tar', sha], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
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
function runVercelCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', 'vercel@' + VERCEL_CLI_VERSION].concat(args), {
      cwd,
      env: process.env,
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

  // 1. exact tree
  exportCandidateTree(runtime, outDir);
  const verifiedPaths = verifyExportedTree(runtime, outDir, surface);

  // 2. the production alias must still be on the previous deployment BEFORE anything is built
  const currentBefore = await currentApp(s);

  // 3. one staged production deployment, not aliased to any production domain
  const res = await runVercelCli([
    'deploy', '--prod', '--skip-domain', '--yes',
    '--project', s.production_project,
    '--scope', s.vercel_team,
    '--cwd', outDir,
  ], outDir);
  if (res.code !== 0) {
    throw new Error('staged production deploy failed: ' + diagnosticLines(res.out, res.err));
  }
  const all = String(res.out) + '\n' + String(res.err);
  const urlMatch = all.match(/https:\/\/[A-Za-z0-9._-]+\.vercel\.app/);
  assert.ok(urlMatch, 'staged deploy did not report a deployment URL');
  const stagedUrl = urlMatch[0];

  // 4. resolve it and prove it is staged: production target, READY, and NOT current
  const d0 = await vercel(s, '/v13/deployments/' + encodeURIComponent(stagedUrl));
  normalizeDeployment(d0);
  assertStaged(d0, { project: s.production_project, team: s.vercel_team, current: currentBefore });

  // 5. the public alias must NOT have moved
  const currentAfter = await currentApp(s);
  assert.equal(currentAfter, currentBefore, 'production alias moved during staging; refusing to continue');

  const report = {
    staged_deployment: d0.id || d0.uid,
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
  return runVercelCli(['promote', 'https://' + id + '.vercel.app', '--yes', '--project', s.production_project, '--scope', s.vercel_team]).then((res) => {
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
  const results = [];
  for (const p of paths) {
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

  const current = await deployment(s, aliasDeploymentId);
  assert.equal(current.meta?.githubCommitSha, s.runtime_sha, 'Current production runtime does not match the recorded baseline');

  return { s, runtime, candidate, aliasDeploymentId, mainSha, env, fb, current };
}

async function preflight() {
  assertKillSwitch();
  const { s, runtime, candidate, aliasDeploymentId, mainSha, env, fb, current } = await readOnlyPreflight();

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
  // The promotion target is the STAGED PRODUCTION deployment built from the exact candidate tree,
  // not an ephemeral Preview. Falling back to the preview candidate keeps older runs reproducible,
  // but the staged artifact is what the current workflow produces.
  let staged = null;
  try { staged = json(path.join(OUT, 'app-staged.json')); } catch (e) { staged = null; }
  const targetDeployment = staged && staged.staged_deployment ? staged.staged_deployment : artifact.candidate_deployment;
  const result = { release_id: process.env.GITHUB_RUN_ID || 'local', runtime_sha: runtime, app_release_status: 'FAIL', production_deployment: null, previous_deployment: artifact.production_deployment, promotion_target: targetDeployment, promotion_model: staged ? 'staged_production' : 'preview_candidate', rules_mutated: false, main_unchanged: true, error: null, rollback_required: false };
  try {
    await promoteFn(s, targetDeployment);
    const aliasDeploymentId = await currentAppFn(s);
    const d = await deploymentFn(s, aliasDeploymentId);
    assertPromoted(d, { runtime, project: s.production_project, team: s.vercel_team, productionDeploymentId: aliasDeploymentId });
    const verified = await verifyFn(s, runtime, surfaceFn());
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
  // Only revert if a promotion actually happened. The workflow calls this with `if: failure()`,
  // which also fires when an EARLIER gate (preflight, tests, kill switch) failed — in that case
  // production was never touched, and reverting would be a pointless mutation followed by a
  // confusing false failure.
  let result = null;
  try { result = json(path.join(OUT, 'app-result.json')); } catch (e) { result = null; }
  if (!result || result.rollback_required !== true) {
    const out = { rollback_status: 'NOT_NEEDED', reason: 'no promotion was performed in this run', rules_mutated: false };
    save('app-rollback-result.json', out);
    console.log('APP ROLLBACK NOT NEEDED: production was never mutated in this run');
    return out;
  }
  const artifact = assertRollbackArtifact(json(path.join(OUT, process.env.APP_ROLLBACK_ARTIFACT || 'app-rollback-' + (process.env.GITHUB_RUN_ID || 'local') + '.json')));
  // Final guard, independent of whatever asked for recovery: if the rollback target is ALREADY the
  // current production deployment there is nothing to restore, and issuing the call would be a
  // meaningless mutation whose failure would be misread as "rollback is broken". Re-read
  // production here instead of trusting the value captured earlier in the run.
  let currentId = null;
  try { currentId = await currentApp(s); } catch (e) { currentId = null; }
  if (currentId && currentId === artifact.production_deployment) {
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
  const id = await revertApp(s, artifact.production_deployment);
  const d = await deployment(s, id);
  assert.equal(d.readyState, 'READY', 'Restored deployment is not READY');
  assert.equal(d.meta?.githubCommitSha, artifact.production_runtime_sha, 'Restored runtime identity mismatch');
  await verifyPublicBytes(s, artifact.production_runtime_sha, servedSurface());
  const out = { rollback_status: 'PASS', state: 'RECOVERED', restored_deployment: id, restored_runtime_sha: artifact.production_runtime_sha, rules_mutated: false };
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
  } else if (cmd === 'read-only-preflight') {
    // Runs the EXACT read path the release preflight uses, without the mutation kill switch.
    // This is what the diagnostics workflow calls: a separate probe re-implemented these reads
    // and reported them healthy while the real path failed.
    const r = await readOnlyPreflight();
    console.log('READ-ONLY PREFLIGHT PASS: candidate ' + r.candidate.id + ' -> production ' + r.aliasDeploymentId);
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
  assertExplicitRuntime, assertKillSwitch, assertAppOnlySources, assertCandidate,
  assertCandidateNotAlreadyProduction, assertBaseline, assertEnvironment,
  assertFirebaseProject, assertPromoted, assertRollbackArtifact,
  resolveCandidate, currentApp, listDeployments, normalizeDeployment, deployment, productionEnv, promote, revertApp,
  verifyPublicBytes, servedSurface, verifyProductIdentity, readOnlyPreflight, preflight, apply, rollbackApp, releaseResult, preflightSummary, redactUrl, vercelUrl, preflightSummary,
  REQUIRED_PROD_ENV, FORBIDDEN_RUNTIME_VALUES, setOut, getOut,
  observeProduction, decideRecovery,
  exportCandidateTree, verifyExportedTree, assertStaged, stageProduction, runVercelCli, diagnosticLines, VERCEL_CLI_VERSION,
};
