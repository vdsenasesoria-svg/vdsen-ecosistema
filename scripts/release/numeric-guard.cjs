'use strict';
// T641 — fail-closed guard: a Client/Coach/API release must not be promoted unless "Numeric Apply is OFF" can be PROVEN from the Vercel production environment.
//
// WHAT THE RUNTIME ACTUALLY READS (derived from the code, never invented): api/autonomous-progression-trigger.js and api/_autonomousProgressionSweep.js turn the
// executor on with `process.env.AUTONOMOUS_PROGRESSION_ENABLED === 'true'` and let it APPLY with `process.env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED === 'true'`
// (strict string equality: absent, empty, 'false' or anything else = OFF). They are the only server switches; `trustedServerNumericApply` is set only by the server executor.
// The per-client Firestore barriers (releaseControl/autonomousProgression, coaches/{id}.autoApplyCanary) are Admin-only documents the app lane can NOT read (it has no Firestore
// access by contract), so they cannot be part of this proof; they only matter once the flags are ON, which this guard forbids at release time.
//
// WHAT CAN BE PROVEN WITH GET: `GET /v9/projects/{id}/env?decrypt=false` lists the project variables with `type`, `target`, `updatedAt`. Only a `plain` variable shows its
// value; `encrypted` / `sensitive` / `secret` / `shared` values are NOT readable. Therefore a progression variable is accepted ONLY if it is absent from the production
// scope or is a readable `plain` variable whose value is exactly `false`. Anything else (including a value that cannot be read) is REJECTED: fail closed, no override.
//
// The staged deployment is built from the PRODUCTION variables as they are at creation time, so the proof is bracketed in time: evidence before staging, evidence after staging
// (plus the variable NAMES Vercel reports for the deployment, when it reports them) and fresh evidence immediately before promotion. Their fingerprints (no values) must be
// identical, so a variable changed in between is detected. Evidence older than MAX_EVIDENCE_AGE_MS is rejected. Nothing here reads, prints or stores a token or a value.
const crypto = require('node:crypto');

const SCHEMA = 'vdsen-numeric-guard-v1';
const FLAG_GLOBAL = 'AUTONOMOUS_PROGRESSION_ENABLED';
const FLAG_NUMERIC = 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED';
const KNOWN_FLAGS = Object.freeze([FLAG_GLOBAL, FLAG_NUMERIC]);
const MAX_EVIDENCE_AGE_MS = 30 * 60 * 1000;   // fixed on purpose: no environment override, no silent relaxation
const PLAIN_TYPES = new Set(['plain']);
const isProgressionName = (name) => typeof name === 'string' && (/^AUTONOMOUS_/.test(name) || /NUMERIC_APPLY/.test(name));

class NumericGuardError extends Error {
  constructor(code, detail) { super('NUMERIC_GUARD ' + code + (detail ? ': ' + detail : '')); this.code = code; }
}
const reject = (code, detail) => { throw new NumericGuardError(code, detail); };

// Names of every environment variable the candidate's server code reads, so a NEW switch added by a later commit can never slip past this guard.
function discoverRuntimeEnvNames(runtimeSha, git) {
  if (!/^[0-9a-f]{40}$/.test(runtimeSha || '')) reject('RUNTIME_NOT_EXPLICIT');
  let out = '';
  try { out = git('grep', '-h', '-o', '-E', 'process\\.env\\.[A-Za-z0-9_]+', runtimeSha, '--', 'api'); }
  catch (e) { out = ''; }
  return [...new Set(out.split('\n').map((l) => l.trim().replace(/^process\.env\./, '')).filter(Boolean))].sort();
}
function assertContractCoverage(runtimeNames) {
  const progression = runtimeNames.filter(isProgressionName);
  const unknown = progression.filter((n) => !KNOWN_FLAGS.includes(n));
  if (unknown.length) reject('UNKNOWN_RUNTIME_SWITCH', 'the candidate reads progression variable(s) this guard does not cover: ' + unknown.join(','));
  const missing = KNOWN_FLAGS.filter((n) => !progression.includes(n));
  if (missing.length) reject('CONTRACT_DRIFT', 'the candidate no longer reads a switch the guard assumes: ' + missing.join(','));
  return progression;
}

const targetsOf = (e) => (Array.isArray(e.target) ? e.target : e.target === undefined || e.target === null ? [] : [e.target]);
const entryView = (e) => ({ id: e.id || null, key: e.key, type: e.type || null, target: targetsOf(e).slice().sort(), updatedAt: e.updatedAt === undefined ? null : e.updatedAt });
const sha256 = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

// Pure: decides from the variables list alone. Throws NumericGuardError; returns evidence with NO values.
function evaluateProductionEnv(envs, ctx) {
  ctx = ctx || {};
  if (!Array.isArray(envs)) reject('ENV_LIST_INCOMPLETE', 'the variable list is not an array');
  const relevant = envs.filter((e) => e && isProgressionName(e.key));
  const flags = {};
  for (const e of relevant) {
    const t = targetsOf(e);
    if (t.length === 0) reject('ENV_SCOPE_INDETERMINATE', e.key);
    if (!t.includes('production')) continue;                              // preview / development only: not used by a production deployment
    if (!KNOWN_FLAGS.includes(e.key)) reject('UNKNOWN_PROGRESSION_VARIABLE', e.key);
    if (e.gitBranch) reject('ENV_SCOPE_INDETERMINATE', e.key + ' is branch-scoped');
    if (flags[e.key]) reject('AMBIGUOUS_VARIABLE', e.key + ' is defined more than once for production');
    if (e.visibility !== undefined && e.visibility !== 'config') reject('VALUE_NOT_READABLE', e.key + ' is not a Config variable');
    if (!PLAIN_TYPES.has(e.type)) reject('VALUE_NOT_READABLE', e.key + ' has type ' + String(e.type) + '; its value cannot be proven OFF');
    if (e.value === 'true') reject(e.key === FLAG_NUMERIC ? 'NUMERIC_APPLY_ACTIVE' : 'GLOBAL_PROGRESSION_ACTIVE', e.key);
    if (e.value !== 'false') reject('VALUE_MALFORMED', e.key + ' must be exactly "false" or absent');
    flags[e.key] = { basis: 'PLAIN_FALSE', entry: entryView(e) };
  }
  for (const name of KNOWN_FLAGS) if (!flags[name]) flags[name] = { basis: 'ABSENT', entry: null };   // runtime treats absence as OFF (strict === 'true')
  const entries = KNOWN_FLAGS.map((n) => flags[n].entry);
  return {
    schema: SCHEMA, status: 'DISARMED', project: ctx.project || null, team: ctx.team || null, runtime_sha: ctx.runtimeSha || null,
    captured_at: new Date(ctx.now === undefined ? Date.now() : ctx.now).toISOString(),
    flags: { [FLAG_GLOBAL]: flags[FLAG_GLOBAL].basis, [FLAG_NUMERIC]: flags[FLAG_NUMERIC].basis },
    relevant_entries: entries.filter(Boolean), env_fingerprint: sha256(entries), runtime_progression_variables: ctx.runtimeProgression || null,
    deployment_env: null,
  };
}

// Reads the effective production variables with GET only. `vercelGet(path)` must return parsed JSON or throw an Error whose message carries the HTTP status.
async function collectEvidence(s, runtimeSha, deps) {
  const now = deps.now === undefined ? Date.now() : deps.now;
  const runtimeNames = deps.runtimeNames || discoverRuntimeEnvNames(runtimeSha, deps.git);
  const runtimeProgression = assertContractCoverage(runtimeNames);
  const guarded = async (path, what) => {
    try { return await deps.vercelGet(path); }
    catch (e) {
      const m = /HTTP (\d{3})/.exec(String((e && e.message) || ''));
      reject('READ_FAILED_' + what, m ? 'HTTP ' + m[1] : 'transport or unknown failure');
    }
    return null;
  };
  const project = await guarded('/v9/projects/' + encodeURIComponent(s.production_project), 'PROJECT');
  if (!project || project.id !== s.production_project) reject('PROJECT_IDENTITY_MISMATCH');
  if (project.accountId !== undefined && project.accountId !== s.vercel_team) reject('TEAM_IDENTITY_MISMATCH');
  const r = await guarded('/v9/projects/' + encodeURIComponent(s.production_project) + '/env?decrypt=false', 'ENV');
  const envs = r && Array.isArray(r) ? r : r && Array.isArray(r.envs) ? r.envs : null;
  if (!envs) reject('ENV_LIST_INCOMPLETE', 'no variable list in the response');
  if (r && !Array.isArray(r) && r.pagination && r.pagination.next) reject('ENV_LIST_INCOMPLETE', 'the response is paginated');
  return evaluateProductionEnv(envs, { project: s.production_project, team: s.vercel_team, runtimeSha, now, runtimeProgression });
}

// The variable NAMES Vercel reports for a deployment (`env`, and `build.env`) must be explained by the evidence: a progression variable the project inspection did not see
// (a shared/linked variable, say) is a discordance between the inspected and the real environment.
function attachDeploymentEnv(evidence, deployment) {
  const names = [];
  let reported = false;
  for (const list of [deployment && deployment.env, deployment && deployment.build && deployment.build.env]) {
    if (Array.isArray(list)) { reported = true; for (const n of list) if (typeof n === 'string') names.push(n); }
  }
  if (!reported) return Object.assign({}, evidence, { deployment_env: { names_reported: false, note: 'Vercel did not report variable names for this deployment; protection relies on the bracketed fingerprints' } });
  const progression = [...new Set(names.filter(isProgressionName))];
  for (const n of progression) {
    if (!KNOWN_FLAGS.includes(n)) reject('UNKNOWN_PROGRESSION_VARIABLE', n + ' is injected into the deployment');
    if (evidence.flags[n] !== 'PLAIN_FALSE') reject('ENV_DISCORDANCE', n + ' is injected into the deployment but the project inspection found it ' + evidence.flags[n]);
  }
  return Object.assign({}, evidence, { deployment_env: { names_reported: true, progression_names: progression.sort() } });
}

function assertDisarmedEvidence(ev, expect) {
  if (!ev || ev.schema !== SCHEMA) reject('EVIDENCE_MISSING');
  if (ev.status !== 'DISARMED') reject('EVIDENCE_NOT_DISARMED');
  if (!KNOWN_FLAGS.every((n) => ev.flags && (ev.flags[n] === 'ABSENT' || ev.flags[n] === 'PLAIN_FALSE'))) reject('EVIDENCE_INCONSISTENT');
  if (!/^[0-9a-f]{64}$/.test(ev.env_fingerprint || '')) reject('EVIDENCE_INCONSISTENT');
  if (expect) {
    if (ev.project !== expect.project) reject('PROJECT_IDENTITY_MISMATCH');
    if (ev.team !== expect.team) reject('TEAM_IDENTITY_MISMATCH');
    if (ev.runtime_sha !== expect.runtimeSha) reject('EVIDENCE_FOR_ANOTHER_RUNTIME');
  }
  return ev;
}
function assertFresh(ev, now) {
  const t = Date.parse(ev && ev.captured_at);
  if (!Number.isFinite(t)) reject('EVIDENCE_TIMESTAMP_INVALID');
  const age = (now === undefined ? Date.now() : now) - t;
  if (age < 0) reject('EVIDENCE_FROM_THE_FUTURE');
  if (age > MAX_EVIDENCE_AGE_MS) reject('EVIDENCE_STALE', 'older than ' + MAX_EVIDENCE_AGE_MS / 60000 + ' minutes');
  return ev;
}
function assertUnchanged(a, b) {
  if (a.env_fingerprint !== b.env_fingerprint) reject('ENV_CHANGED_CONCURRENTLY');
  return true;
}
// Promotion gate: ALL evidence must exist, be DISARMED, for this exact project/team/runtime, be recent, and be identical to the fresh read taken right now.
function assertPromotionAllowed({ preflight, staged, fresh, expect, now }) {
  const pre = assertDisarmedEvidence(preflight, expect), cur = assertDisarmedEvidence(fresh, expect);
  assertFresh(pre, now); assertFresh(cur, now); assertUnchanged(pre, cur);
  if (staged) { const st = assertDisarmedEvidence(staged, expect); assertFresh(st, now); assertUnchanged(pre, st); }
  return true;
}

module.exports = { SCHEMA, KNOWN_FLAGS, FLAG_GLOBAL, FLAG_NUMERIC, MAX_EVIDENCE_AGE_MS, NumericGuardError, isProgressionName, discoverRuntimeEnvNames, assertContractCoverage,
  evaluateProductionEnv, collectEvidence, attachDeploymentEnv, assertDisarmedEvidence, assertFresh, assertUnchanged, assertPromotionAllowed };
