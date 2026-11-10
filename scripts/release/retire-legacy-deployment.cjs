'use strict';
// Controlled retirement of the legacy armed deployment (T732, hardened in T733).
//
// Deletes exactly ONE deployment (dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K) and nothing else.
//
// Fail-closed contract:
//   - every read must succeed AND be well formed; a failed or malformed read is never "absence of evidence"
//   - the whole preflight is taken twice (before the DELETE and again immediately before it); any difference is a STOP
//   - exactly one DELETE; an uncertain result is reconciled with reads and NEVER retried
//   - tokens and Authorization headers are never printed or persisted; only statuses and identifiers are recorded
//
// Vercel contract (official REST reference):
//   DELETE /v13/deployments/{id}?teamId=  -> 200 {"uid": "<id>", "state": "DELETED"}; 400/401/403/404 otherwise
//   GET    /v13/deployments/{id}?teamId=  -> deployment identity
//   GET    /v2/deployments/{id}/aliases   -> {"aliases": [{"alias", "uid", "created", ...}]}
//   GET    /v4/aliases/{idOrAlias}        -> alias with `deployment` and `projectId`
//   GET    /v4/aliases?projectId=         -> {"aliases": [{"alias", "deploymentId", ...}], "pagination": {"next"}}
const fs = require('node:fs');
const { json } = require('./lib.cjs');
const P = require('../pilot/window-protocol.cjs');
const C = require('../pilot/ayrton-canary.cjs');

const LEGACY_ARMED_DEPLOYMENT = P.LEGACY_ARMED_DEPLOYMENT; // dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K
const PROTECTED_PROD_DEPLOYMENT = 'dpl_4CxS8VeoTwWFEJa37tqiHRGGuj4H';
const PROTECTED_ROLLBACK_DEPLOYMENT = 'dpl_AuykDuRaXejkbUzFNjFz6XocNPZt';
const EXPECTED_PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const EXPECTED_TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';
const CANONICAL_REPOSITORY = 'vdsenasesoria-svg/vdsen-ecosistema';
const CANONICAL_REF = 'refs/heads/codex/client-app-next';
const AYRTON_UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const RETIRE_WORKFLOW = 'vdsen-retire-legacy-deployment.yml';
const PRODUCTION_WORKFLOWS = Object.freeze(['vdsen-retire-legacy-deployment.yml', 'vdsen-release-prod.yml', 'vdsen-app-release-prod.yml',
  'vdsen-ayrton-runtime.yml', 'vdsen-rollback.yml', 'vdsen-numeric-pilot.yml']);
const VERCEL_API = 'https://api.vercel.com';
const FIRESTORE_DOCS = 'https://firestore.googleapis.com/v1/projects/' + C.PROJECT + '/databases/(default)/documents/';
const MAX_ALIAS_PAGES = 10;
const ALIAS_PAGE_LIMIT = 100;

function state() { return json('.release/vdsen-client.json'); }
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const block = (reason, extra) => Object.assign({ ok: false, reason }, extra || {});

// ── transport: never throws, never returns a body that was not JSON-object shaped
async function get(url, headers, f) {
  try {
    const r = await f(url, { method: 'GET', headers, signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (r.status !== 200) return { status: r.status, ok: false };
    let data;
    try { data = typeof r.json === 'function' ? await r.json() : JSON.parse(await r.text()); } catch (e) { return { status: 200, ok: false, malformed: true }; }
    if (!isObj(data)) return { status: 200, ok: false, malformed: true };
    return { status: 200, ok: true, data };
  } catch (err) {
    return { status: 'NETWORK', ok: false };
  }
}
const vercelHeaders = (ctx) => ({ Authorization: 'Bearer ' + ctx.vercelToken });
const withTeam = (ctx, p) => VERCEL_API + p + (p.includes('?') ? '&' : '?') + 'teamId=' + encodeURIComponent(ctx.s.vercel_team);
const vget = (ctx, p) => get(withTeam(ctx, p), vercelHeaders(ctx), ctx.fetch);

// ── identity validators (pure)
function deploymentIdentity(d, id, s) {
  if (!isObj(d)) return false;
  return (d.id || d.uid) === id && d.projectId === s.production_project && (d.teamId || d.ownerId) === s.vercel_team;
}
function validateProduction(d, s) {
  if (!deploymentIdentity(d, s.production_deployment, s)) return 'PROD_IDENTITY_MISMATCH';
  if (d.readyState !== 'READY') return 'PROD_NOT_READY';
  if (d.target !== 'production') return 'PROD_TARGET_MISMATCH';
  const sha = isObj(d.meta) ? d.meta.githubCommitSha : undefined;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return 'PROD_SHA_MISSING';
  if (sha !== s.runtime_sha) return 'PROD_SHA_MISMATCH';
  return null;
}
function validateRollback(d, s) {
  if (!deploymentIdentity(d, s.rollback_deployment, s)) return 'ROLLBACK_IDENTITY_MISMATCH';
  if (d.readyState !== 'READY') return 'ROLLBACK_NOT_READY';
  const sha = isObj(d.meta) ? d.meta.githubCommitSha : undefined;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return 'ROLLBACK_SHA_MISSING';
  const a = s.app_release || {};
  // OFF provenance: the pinned manifest names this deployment as the safe recovery target with the same runtime SHA.
  if (sha !== s.rollback_runtime_sha || a.safe_recovery_deployment !== s.rollback_deployment || a.safe_recovery_runtime_sha !== s.rollback_runtime_sha) return 'ROLLBACK_OFF_PROVENANCE_MISMATCH';
  return null;
}

// ── individual reads
async function readContext(ctx) {
  const e = ctx.env;
  if (e.GITHUB_REPOSITORY !== CANONICAL_REPOSITORY) return block('REPOSITORY_NOT_CANONICAL');
  if (e.GITHUB_REF !== CANONICAL_REF) return block('REF_NOT_CANONICAL');
  if (e.GITHUB_EVENT_NAME !== 'workflow_dispatch') return block('EVENT_NOT_DISPATCH');
  if (e.GITHUB_RUN_ATTEMPT !== '1') return block('RERUN_NOT_AUTHORIZED');
  if (!/^\d+$/.test(e.GITHUB_RUN_ID || '')) return block('RUN_ID_INVALID');
  return { ok: true };
}

async function listRuns(ctx, p) {
  const r = await get('https://api.github.com/repos/' + CANONICAL_REPOSITORY + p, { Authorization: 'Bearer ' + ctx.githubToken, Accept: 'application/vnd.github+json' }, ctx.fetch);
  if (!r.ok) return null;
  const d = r.data;
  if (!Array.isArray(d.workflow_runs) || !Number.isInteger(d.total_count) || d.total_count > d.workflow_runs.length) return null; // truncated/malformed: not evidence
  if (!d.workflow_runs.every(isObj)) return null;
  return d.workflow_runs;
}
async function readConcurrency(ctx) {
  const self = String(ctx.env.GITHUB_RUN_ID);
  for (const status of ['in_progress', 'queued', 'waiting']) {
    const runs = await listRuns(ctx, '/actions/runs?status=' + status + '&per_page=100');
    if (!runs) return block('CONCURRENCY_READ_UNAVAILABLE');
    for (const run of runs) {
      const wf = String(run.path || '').replace(/@.*$/, '').split('/').pop();
      if (String(run.id) !== self && PRODUCTION_WORKFLOWS.includes(wf)) return block('CONCURRENT_PRODUCTION_OPERATION');
    }
  }
  const prior = await listRuns(ctx, '/actions/workflows/' + RETIRE_WORKFLOW + '/runs?per_page=100');
  if (!prior) return block('RETIREMENT_HISTORY_UNAVAILABLE');
  if (prior.some((r) => String(r.id) !== self && ['cancelled', 'timed_out', 'startup_failure', 'action_required'].includes(r.conclusion))) return block('PRIOR_RETIREMENT_UNCERTAIN');
  return { ok: true };
}

async function readFences(ctx, now) {
  if (!ctx.googleToken) return block('FIRESTORE_READ_UNAVAILABLE');
  try { P.exactUid(AYRTON_UID); } catch (e) { return block('AYRTON_UID_CONTRACT_BROKEN'); }
  const h = { Authorization: 'Bearer ' + ctx.googleToken };
  const doc = async (p) => {
    const r = await get(FIRESTORE_DOCS + p, h, ctx.fetch);
    if (!r.ok || !isObj(r.data.fields) || typeof r.data.updateTime !== 'string') return null;
    return { fields: C.decDoc(r.data), updateTime: r.data.updateTime };
  };
  const client = await doc('clients/' + AYRTON_UID);
  if (!client || typeof client.fields.coachId !== 'string' || !/^[A-Za-z0-9]{20,40}$/.test(client.fields.coachId)) return block('FIRESTORE_READ_UNAVAILABLE', { which: 'client' });
  const release = await doc(C.RELEASE_PATH);
  const coach = await doc('coaches/' + client.fields.coachId);
  if (!release || !coach) return block('FIRESTORE_READ_UNAVAILABLE', { which: release ? 'coach' : 'release' });
  const canary = coach.fields.autoApplyCanary;
  const only = (x) => isObj(x) && Array.isArray(x.clientIds) && x.clientIds.length === 1 && x.clientIds[0] === AYRTON_UID;
  if (release.fields.enabled !== false) return block('RELEASE_FENCE_NOT_DISABLED');
  if (!isObj(canary) || canary.enabled !== false) return block('COACH_CANARY_NOT_DISABLED');
  const exp = Date.parse(release.fields.expiresAt);
  if (typeof release.fields.expiresAt !== 'string' || !Number.isFinite(exp) || exp > now) return block('RELEASE_WINDOW_STILL_VALID_OR_UNREADABLE');
  if (!only(release.fields) || !only(canary)) return block('FENCE_SCOPE_NOT_AYRTON_ONLY');
  return { ok: true, versions: { release: release.updateTime, coach: coach.updateTime } };
}

async function readAliases(ctx) {
  const s = ctx.s;
  // Production alias: must be well formed and point at the protected production deployment.
  const host = new URL(s.production_origin).hostname;
  const pa = await vget(ctx, '/v4/aliases/' + encodeURIComponent(host));
  if (!pa.ok) return block('PROD_ALIAS_READ_FAILED_' + pa.status);
  const a = pa.data, aliasDep = isObj(a.deployment) ? (a.deployment.id || a.deployment.uid) : undefined;
  if (a.alias !== host || typeof aliasDep !== 'string') return block('PROD_ALIAS_MALFORMED');
  if (a.projectId !== s.production_project) return block('PROD_ALIAS_PROJECT_MISMATCH');
  if (aliasDep === LEGACY_ARMED_DEPLOYMENT) return block('LEGACY_IS_PRODUCTION_ALIAS_TARGET');
  if (aliasDep !== s.production_deployment) return block('PROD_ALIAS_TARGET_MISMATCH');
  // Aliases attached to the legacy deployment itself.
  const la = await vget(ctx, '/v2/deployments/' + encodeURIComponent(LEGACY_ARMED_DEPLOYMENT) + '/aliases');
  if (!la.ok) return block('LEGACY_ALIASES_READ_FAILED_' + la.status);
  if (!Array.isArray(la.data.aliases) || !la.data.aliases.every((x) => isObj(x) && typeof x.alias === 'string')) return block('LEGACY_ALIASES_MALFORMED');
  if (la.data.aliases.length > 0) return block('LEGACY_HAS_ACTIVE_ALIAS');
  // Every alias of the project: none may target the legacy deployment.
  let until = null, seen = 0;
  for (let page = 0; page < MAX_ALIAS_PAGES; page++) {
    const r = await vget(ctx, '/v4/aliases?projectId=' + encodeURIComponent(s.production_project) + '&limit=' + ALIAS_PAGE_LIMIT + (until ? '&until=' + encodeURIComponent(until) : ''));
    if (!r.ok) return block('PROJECT_ALIASES_READ_FAILED_' + r.status);
    const list = r.data.aliases;
    if (!Array.isArray(list) || !list.every((x) => isObj(x) && typeof x.alias === 'string')) return block('PROJECT_ALIASES_MALFORMED');
    if (list.some((x) => x.deploymentId === LEGACY_ARMED_DEPLOYMENT)) return block('LEGACY_HAS_ACTIVE_ALIAS');
    seen += list.length;
    const next = isObj(r.data.pagination) ? r.data.pagination.next : (list.length >= ALIAS_PAGE_LIMIT ? undefined : null);
    if (next === undefined) return block('PROJECT_ALIASES_PAGINATION_MALFORMED');
    if (next === null) return { ok: true, productionAliasDeployment: aliasDep, projectAliasesSeen: seen };
    until = next;
  }
  return block('PROJECT_ALIASES_PAGINATION_EXCEEDED');
}

// ── one complete, fail-closed snapshot of every condition that may change
async function snapshot(ctx) {
  const s = ctx.s;
  if (s.production_deployment !== PROTECTED_PROD_DEPLOYMENT || s.rollback_deployment !== PROTECTED_ROLLBACK_DEPLOYMENT
    || s.production_project !== EXPECTED_PROJECT || s.vercel_team !== EXPECTED_TEAM) return block('MANIFEST_CONTRACT_MISMATCH');
  for (const t of [ctx.vercelToken, ctx.googleToken, ctx.githubToken]) if (!t) return block('MISSING_CREDENTIAL');
  const c = await readContext(ctx); if (!c.ok) return c;
  const k = await readConcurrency(ctx); if (!k.ok) return k;
  const f = await readFences(ctx, ctx.now()); if (!f.ok) return f;
  const prod = await vget(ctx, '/v13/deployments/' + encodeURIComponent(s.production_deployment));
  if (!prod.ok) return block('PROD_DEPLOYMENT_HTTP_' + prod.status);
  const pe = validateProduction(prod.data, s); if (pe) return block(pe);
  const rb = await vget(ctx, '/v13/deployments/' + encodeURIComponent(s.rollback_deployment));
  if (!rb.ok) return block('ROLLBACK_DEPLOYMENT_HTTP_' + rb.status);
  const re = validateRollback(rb.data, s); if (re) return block(re);
  const leg = await vget(ctx, '/v13/deployments/' + encodeURIComponent(LEGACY_ARMED_DEPLOYMENT));
  if (leg.status === 404) return block('LEGACY_ALREADY_RETIRED');
  if (!leg.ok) return block('LEGACY_DEPLOYMENT_HTTP_' + leg.status);
  if (!deploymentIdentity(leg.data, LEGACY_ARMED_DEPLOYMENT, s)) return block('LEGACY_IDENTITY_MISMATCH');
  const al = await readAliases(ctx); if (!al.ok) return al;
  return { ok: true, fingerprint: { production: s.production_deployment, productionSha: prod.data.meta.githubCommitSha, rollback: s.rollback_deployment,
    legacy: LEGACY_ARMED_DEPLOYMENT, aliasTarget: al.productionAliasDeployment, fences: f.versions } };
}

// Takes the snapshot twice; the second one is taken immediately before the DELETE and must match the first exactly.
async function preflight(ctx) {
  const first = await snapshot(ctx); if (!first.ok) return first;
  const second = await snapshot(ctx); if (!second.ok) return block('RECHECK_' + second.reason);
  if (JSON.stringify(first.fingerprint) !== JSON.stringify(second.fingerprint)) return block('STATE_CHANGED_BEFORE_DELETE');
  return { ok: true, fingerprint: second.fingerprint };
}

// ── the single destructive request
async function executeSingleDelete(ctx) {
  const id = LEGACY_ARMED_DEPLOYMENT;
  if (id === PROTECTED_PROD_DEPLOYMENT || id === PROTECTED_ROLLBACK_DEPLOYMENT || id !== P.LEGACY_ARMED_DEPLOYMENT) throw new Error('SECURITY_VIOLATION: refusing to delete ' + id);
  try {
    const r = await ctx.fetch(withTeam(ctx, '/v13/deployments/' + encodeURIComponent(id)), { method: 'DELETE', headers: vercelHeaders(ctx), signal: AbortSignal.timeout(30000), redirect: 'error' });
    let body = null; try { body = typeof r.json === 'function' ? await r.json() : null; } catch (e) { body = null; }
    const clean = r.status === 200 && isObj(body) && body.state === 'DELETED' && body.uid === id;
    return { status: r.status, clean };
  } catch (e) {
    return { status: 'NETWORK', clean: false };
  }
}

async function verifyPostRetirement(ctx) {
  const s = ctx.s;
  const prodCheck = async () => { const r = await vget(ctx, '/v13/deployments/' + encodeURIComponent(s.production_deployment)); return { status: r.status, valid: r.ok && validateProduction(r.data, s) === null }; };
  const production_before = await prodCheck();
  const rr = await vget(ctx, '/v13/deployments/' + encodeURIComponent(s.rollback_deployment));
  const rollback = { status: rr.status, valid: rr.ok && validateRollback(rr.data, s) === null };
  const lr = await vget(ctx, '/v13/deployments/' + encodeURIComponent(LEGACY_ARMED_DEPLOYMENT));
  const legacy = { status: lr.status, retired: lr.status === 404 };
  const production_after = await prodCheck();
  return { verified: production_before.valid && rollback.valid && legacy.retired && production_after.valid, production_before, rollback, legacy, production_after };
}

async function retireLegacyDeployment(s, opts = {}) {
  const ctx = { s, env: opts.env || process.env, fetch: opts.fetch || fetch, now: opts.now || Date.now,
    vercelToken: opts.vercelToken, googleToken: opts.googleToken, githubToken: opts.githubToken };
  const pre = await preflight(ctx);
  if (!pre.ok) return { verdict: 'BLOCKED', reason: pre.reason, target: LEGACY_ARMED_DEPLOYMENT };
  const del = await executeSingleDelete(ctx); // exactly one; never retried
  const post = await verifyPostRetirement(ctx);
  if (del.clean && post.verified) return { verdict: 'LEGACY_RETIRED_VERIFIED', target: LEGACY_ARMED_DEPLOYMENT, delete_status: del.status, post_verification: post };
  return { verdict: 'UNCERTAIN', reason: del.clean ? 'POST_VERIFICATION_FAILED' : 'DELETE_RESULT_NOT_CLEAN_' + del.status, target: LEGACY_ARMED_DEPLOYMENT, delete_status: del.status, post_verification: post };
}

async function main() {
  if (process.env.CONFIRM_DEPLOYMENT_ID !== LEGACY_ARMED_DEPLOYMENT) { console.error('ERROR: CONFIRM_DEPLOYMENT_ID must match exactly ' + LEGACY_ARMED_DEPLOYMENT); process.exit(1); }
  const result = await retireLegacyDeployment(state(), { vercelToken: process.env.VERCEL_TOKEN, googleToken: process.env.GOOGLE_ACCESS_TOKEN, githubToken: process.env.GITHUB_TOKEN });
  const lines = ['## Legacy armed deployment controlled retirement', '', '| Item | Value |', '|---|---|', '| Target | `' + result.target + '` |', '| Verdict | **' + result.verdict + '** |', '| Reason | ' + (result.reason || 'OK') + ' |'];
  if (result.post_verification) {
    const p = result.post_verification;
    lines.push('', '| Post check | HTTP | Valid |', '|---|---|---|', '| production (before) | ' + p.production_before.status + ' | ' + p.production_before.valid + ' |', '| rollback OFF | ' + p.rollback.status + ' | ' + p.rollback.valid + ' |',
      '| legacy | ' + p.legacy.status + ' | retired=' + p.legacy.retired + ' |', '| production (after) | ' + p.production_after.status + ' | ' + p.production_after.valid + ' |');
  }
  fs.mkdirSync('release-output', { recursive: true });
  fs.writeFileSync('release-output/legacy-retirement.json', JSON.stringify(result, null, 2) + '\n');
  try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch (e) { /* summary is best effort */ }
  console.log(lines.join('\n'));
  process.exit(result.verdict === 'LEGACY_RETIRED_VERIFIED' ? 0 : result.verdict === 'BLOCKED' ? 2 : 3);
}

if (require.main === module) main().catch((e) => { console.error('FATAL_RETIREMENT_ERROR: ' + (e && e.message ? e.message : String(e))); process.exit(3); });

module.exports = { LEGACY_ARMED_DEPLOYMENT, PROTECTED_PROD_DEPLOYMENT, PROTECTED_ROLLBACK_DEPLOYMENT, EXPECTED_PROJECT, EXPECTED_TEAM, CANONICAL_REF, AYRTON_UID,
  validateProduction, validateRollback, snapshot, preflight, executeSingleDelete, verifyPostRetirement, retireLegacyDeployment };
