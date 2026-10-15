'use strict';
// Firebase Storage Rules lane: LIVE READBACK, PLAN, and (library-only, blocked) APPLY / ROLLBACK.
//
// Why this is separate from firebase.json: firebase.json is part of the hashed, publicly served
// product surface (.release/deployed-product.json) and T540 pins its shape. The release lanes talk
// to the Firebase Rules REST API directly (like live.cjs does for Firestore), so Storage is registered
// in `.release/storage-rules.json` instead. Nothing here is reachable from `firebase deploy`.
//
// Stages are strictly separated and every one is fail-closed:
//   readback        READ ONLY  live release -> ruleset -> content hash, compared with storage.rules
//   capture         READ ONLY  writes the rollback artifact from the CURRENT live rules
//   plan            READ ONLY  refuses unless live is readable AND the artifact equals what is live now
//   verify-artifact READ ONLY  integrity + provenance + (optional) custody digest of a stored artifact
//   apply/rollback  MUTATION   library-only; blocked unless a caller acknowledges non-atomicity
// No workflow in this repository calls apply/rollback. Responses/tokens are never logged.
//
// CONCURRENCY - stated honestly. The Firebase Rules REST API (projects.releases.patch) documents NO
// precondition/etag/generation match: a PATCH of rulesetName cannot be made conditional on "the live
// ruleset is still X". The re-read-before-publish below narrows the window, it does NOT close it.
// Therefore ATOMIC_PRECONDITION_AVAILABLE is false and apply()/rollback() refuse to run unless a caller
// passes allowNonAtomic:true (used only by the synthetic rehearsal; the CLI cannot). Do not flip this
// constant without a demonstrated atomic primitive.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const API = 'https://firebaserules.googleapis.com/v1/';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const SHA_RE = /^[0-9a-f]{64}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{2,62}$/;
const ATOMIC_PRECONDITION_AVAILABLE = false;
const CANONICAL_REPOSITORY = 'vdsenasesoria-svg/vdsen-ecosistema';
const CANONICAL_REF = 'refs/heads/codex/client-app-next';
const RELEASE_SERVICE_ACCOUNT = 'vdsen-release-bot@vdsen-ecosistema.iam.gserviceaccount.com';
const READONLY_SA_RE = /^vdsen-storage-readonly@vdsen-ecosistema\.iam\.gserviceaccount\.com$/;

class StorageRulesError extends Error {
  constructor(category, status = null) { super(category); this.category = category; this.httpStatus = status; }
}
const httpCategory = s => ([400, 401, 403, 404, 409, 422, 429].includes(s) ? 'HTTP_' + s : s >= 500 ? 'HTTP_5XX' : 'HTTP_OTHER');
const releaseName = (project, bucket) => 'projects/' + project + '/releases/firebase.storage/' + bucket;

function loadManifest(root = '.') {
  const m = JSON.parse(fs.readFileSync(path.join(root, '.release/storage-rules.json'), 'utf8'));
  assert.equal(m.schema, 'vdsen-storage-rules-v1', 'manifest schema');
  assert.match(m.firebase_project, /^[a-z0-9-]{4,30}$/, 'manifest project');
  assert.match(m.bucket, BUCKET_RE, 'manifest bucket');
  assert.ok(m.bucket.startsWith(m.firebase_project + '.'), 'bucket must belong to the project');
  assert.equal(m.rules_path, 'storage.rules');
  assert.equal(m.release_name, releaseName(m.firebase_project, m.bucket), 'manifest release_name');
  return m;
}

// The bucket is never invented: it must be the single production bucket the shipped apps already use.
function discoverBucket(root, project) {
  const found = new Set();
  for (const file of ['vdsen-cliente.html', 'vdsen-coach.html']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of text.matchAll(/storageBucket["']?\s*:\s*["']([^"']+)["']/g)) if (m[1].startsWith(project + '.')) found.add(m[1]);
  }
  assert.equal(found.size, 1, 'expected exactly one production storageBucket in the apps, found ' + found.size);
  return [...found][0];
}

function assertRulesSource(content) {
  assert.equal(typeof content, 'string', 'rules content');
  assert.ok(content.length > 0 && content.length < 256 * 1024, 'rules size');
  assert.match(content, /service\s+firebase\.storage\s*\{/, 'not a Storage rules source');
  assert.match(content, /rules_version\s*=\s*'2'/, 'rules_version');
  return content;
}

async function call(fetchImpl, token, name, method = 'GET', body) {
  if (!token) throw new StorageRulesError('NO_TOKEN');
  let r;
  try {
    r = await fetchImpl(API + name, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    if (e instanceof StorageRulesError) throw e;
    throw new StorageRulesError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR');
  }
  if (!r.ok) throw new StorageRulesError(httpCategory(r.status), r.status); // body deliberately never read
  try { const t = await r.text(); return t ? JSON.parse(t) : {}; } catch { throw new StorageRulesError('MALFORMED_RESPONSE', r.status); }
}

// GET-only transport: structurally cannot mutate, whatever the caller does.
function readOnlyFetch(fetchImpl = fetch) {
  return async (url, init = {}) => {
    if ((init.method || 'GET').toUpperCase() !== 'GET') throw new StorageRulesError('READ_ONLY_VIOLATION');
    return fetchImpl(url, init);
  };
}

// The Storage readback must run as a dedicated read-only service account. There is deliberately no
// fallback to the release bot (which holds write permissions): absence or equality is a hard failure.
function assertReadonlyIdentity(env) {
  const sa = env.GCP_STORAGE_READONLY_SERVICE_ACCOUNT;
  assert.ok(sa, 'GCP_STORAGE_READONLY_SERVICE_ACCOUNT is not set; refusing to fall back to another identity');
  assert.notEqual(sa, RELEASE_SERVICE_ACCOUNT, 'read-only lane must not use the release service account');
  assert.notEqual(sa, env.GCP_RELEASE_SERVICE_ACCOUNT, 'read-only lane must not use the release service account');
  assert.match(sa, READONLY_SA_RE, 'unexpected read-only service account identity');
  return sa;
}

// READ ONLY. Returns a result object instead of throwing so the report is always producible.
async function readLive({ manifest, token, fetchImpl = fetch }) {
  const out = { ok: false, release_name: manifest.release_name, ruleset_name: null, update_time: null, sha256: null, source: null, error: 'NONE', http_status: null, stage: 'release' };
  try {
    const rel = await call(fetchImpl, token, manifest.release_name);
    if (rel.name !== manifest.release_name) throw new StorageRulesError('ASSERTION_MISMATCH');
    if (typeof rel.rulesetName !== 'string' || !rel.rulesetName.startsWith('projects/' + manifest.firebase_project + '/rulesets/')) throw new StorageRulesError('NO_ACTIVE_RULESET');
    out.ruleset_name = rel.rulesetName; out.update_time = typeof rel.updateTime === 'string' ? rel.updateTime : null; out.stage = 'ruleset';
    const rs = await call(fetchImpl, token, rel.rulesetName);
    const files = rs.source?.files;
    if (rs.name !== rel.rulesetName || !Array.isArray(files) || files.length !== 1 || typeof files[0].content !== 'string') throw new StorageRulesError('ASSERTION_MISMATCH');
    out.source = { files: [{ name: manifest.rules_path, content: files[0].content }] };
    out.sha256 = sha256(files[0].content); out.ok = true; out.stage = 'done';
  } catch (e) {
    out.error = e instanceof StorageRulesError ? e.category : 'UNEXPECTED'; out.http_status = e.httpStatus ?? null;
  }
  return out;
}

function compare(localContent, live) {
  const local_sha256 = sha256(localContent);
  return { local_sha256, live_sha256: live?.sha256 ?? null, identical: !!live?.ok && live.sha256 === local_sha256 };
}

function readbackReport({ manifest, local, live, now = new Date() }) {
  const c = compare(local, live);
  return { schema: 'vdsen-storage-readback-v1', project: manifest.firebase_project, bucket: manifest.bucket, release_name: manifest.release_name,
    live_readback: live.ok ? 'PASS' : 'FAIL', error: live.error, http_status: live.http_status, ruleset_name: live.ruleset_name,
    live_sha256: c.live_sha256, local_sha256: c.local_sha256, rules_diff: !live.ok ? 'UNKNOWN' : c.identical ? 'IDENTICAL' : 'DIFFERENT',
    mutations_performed: false, timestamp: now.toISOString() };
}

// ---- rollback artifact: identity + version + hash + provenance -----------------------------------
// Provenance is CI-issued evidence, not a free-form label: only a run of the canonical repository on
// the canonical ref, with a numeric run id and a full commit SHA, is accepted.
function assertProvenance(p) {
  assert.ok(p && typeof p === 'object', 'provenance missing');
  assert.equal(p.repository, CANONICAL_REPOSITORY, 'provenance repository');
  assert.equal(p.ref, CANONICAL_REF, 'provenance ref');
  assert.match(String(p.run_id || ''), /^\d{1,20}$/, 'provenance run_id');
  assert.match(String(p.run_attempt || ''), /^\d{1,4}$/, 'provenance run_attempt');
  assert.match(String(p.commit || ''), /^[0-9a-f]{40}$/, 'provenance commit');
  assert.ok(typeof p.workflow === 'string' && p.workflow.length > 0, 'provenance workflow');
  return p;
}
function buildRollbackArtifact({ manifest, live, provenance, now = new Date() }) {
  assert.ok(live?.ok, 'cannot capture a rollback artifact without a readable live ruleset (fail-closed: no prior rules)');
  const content = live.source.files[0].content;
  assertRulesSource(content);
  assertProvenance(provenance);
  const meta = { schema: 'vdsen-storage-rollback-v1', firebase_project: manifest.firebase_project, bucket: manifest.bucket,
    release_name: manifest.release_name, ruleset_name: live.ruleset_name, release_update_time: live.update_time ?? null,
    rules_sha256: sha256(content), rules_bytes: Buffer.byteLength(content),
    captured_at: now.toISOString(), provenance: { source: 'firebase-rules-api-live-readback', ...provenance } };
  return { meta, content, rulesFile: 'storage.rules.' + meta.rules_sha256 + '.rules', metaFile: 'storage.rules.' + meta.rules_sha256 + '.json' };
}
function verifyRollbackArtifact(manifest, meta, content) {
  assert.ok(meta && typeof meta === 'object', 'artifact metadata missing');
  assert.equal(meta.schema, 'vdsen-storage-rollback-v1');
  for (const k of ['firebase_project', 'bucket', 'release_name']) assert.equal(meta[k], manifest[k], 'artifact identity mismatch: ' + k);
  assert.match(meta.rules_sha256 || '', SHA_RE, 'artifact hash format');
  assert.match(meta.ruleset_name || '', new RegExp('^projects/' + manifest.firebase_project + '/rulesets/[A-Za-z0-9_-]+$'), 'artifact ruleset identity');
  assert.equal(meta.provenance?.source, 'firebase-rules-api-live-readback', 'artifact provenance source');
  assertProvenance(meta.provenance);
  assert.ok(meta.captured_at && !Number.isNaN(Date.parse(meta.captured_at)), 'artifact captured_at');
  assertRulesSource(content);
  assert.equal(sha256(content), meta.rules_sha256, 'artifact content does not match its recorded hash');
  assert.equal(Buffer.byteLength(content), meta.rules_bytes, 'artifact size mismatch');
  return true;
}
// Digest over identity + hash + provenance + bytes. It is a TRUST ANCHOR only if recorded OUTSIDE the
// artifact store (approver ticket / PR review): anyone who can rewrite the store can also rewrite a
// digest stored next to it. Workflow-artifact retention is temporary, and immutability is NOT proven.
function custodyDigest(meta, content) { return sha256(JSON.stringify(meta) + '\n' + content); }
function loadRollbackArtifact(manifest, dir, sha) {
  assert.match(sha || '', SHA_RE, 'rollback sha');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'storage.rules.' + sha + '.json'), 'utf8'));
  const content = fs.readFileSync(path.join(dir, 'storage.rules.' + sha + '.rules'), 'utf8');
  assert.equal(meta.rules_sha256, sha, 'artifact file name does not match its hash');
  verifyRollbackArtifact(manifest, meta, content);
  return { meta, content };
}

// ---- plan (pure, read-only) ----------------------------------------------------------------------
function plan({ manifest, local, live, artifact }) {
  const blockers = [];
  try { assertRulesSource(local); } catch { blockers.push('LOCAL_RULES_INVALID'); }
  if (!live?.ok) blockers.push('LIVE_RULES_UNREADABLE:' + (live?.error || 'NONE'));
  if (!artifact) blockers.push('ROLLBACK_ARTIFACT_MISSING');
  else {
    try { verifyRollbackArtifact(manifest, artifact.meta, artifact.content); } catch { blockers.push('ROLLBACK_ARTIFACT_INVALID'); }
    if (live?.ok && artifact.meta?.rules_sha256 !== live.sha256) blockers.push('ROLLBACK_ARTIFACT_NOT_CURRENT_LIVE');
    if (live?.ok && artifact.meta?.ruleset_name !== live.ruleset_name) blockers.push('ROLLBACK_ARTIFACT_RULESET_MISMATCH');
  }
  if (!ATOMIC_PRECONDITION_AVAILABLE) blockers.push('NO_ATOMIC_PRECONDITION_IN_RULES_API');
  const same = live?.ok && sha256(local || '') === live.sha256;
  const status = blockers.length === 1 && blockers[0] === 'NO_ATOMIC_PRECONDITION_IN_RULES_API' ? (same ? 'NOOP_ALREADY_LIVE' : 'READY_BLOCKED_NON_ATOMIC') : 'BLOCKED';
  return { status, blockers, target_sha256: local ? sha256(local) : null, live_sha256: live?.sha256 ?? null };
}

// ---- mutations (gated; never reached by any workflow in this repo) -------------------------------
function assertMutationAuthorized(env, targetSha) {
  assert.equal(env.STORAGE_RULES_RELEASE_ENABLED, 'true', 'STORAGE_RULES_RELEASE_ENABLED is not true; Storage lane is disarmed');
  assert.equal(env.STORAGE_RULES_APPROVED_SHA, targetSha, 'approved sha does not match the rules to publish');
}
function assertNonAtomicAcknowledged(allowNonAtomic) {
  assert.ok(ATOMIC_PRECONDITION_AVAILABLE || allowNonAtomic === true,
    'MUTATION_BLOCKED_NO_ATOMIC_PRECONDITION: the Rules API offers no conditional release update');
}
async function publish({ manifest, content, token, fetchImpl }) {
  assertRulesSource(content);
  const rs = await call(fetchImpl, token, 'projects/' + manifest.firebase_project + '/rulesets', 'POST', { source: { files: [{ name: manifest.rules_path, content }] } });
  assert.match(rs.name || '', new RegExp('^projects/' + manifest.firebase_project + '/rulesets/[A-Za-z0-9_-]+$'), 'created ruleset identity');
  await call(fetchImpl, token, manifest.release_name, 'PATCH', { release: { name: manifest.release_name, rulesetName: rs.name }, updateMask: 'rulesetName' });
  return rs.name;
}
const UNCERTAIN = new Set(['TIMEOUT', 'NETWORK_ERROR', 'HTTP_5XX', 'MALFORMED_RESPONSE', 'HTTP_429']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// After a publish whose outcome is unknown (timeout/5xx), decide from READ-ONLY evidence only.
async function settle({ manifest, token, fetchImpl, targetSha, previousSha, attempts, delayMs }) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await readLive({ manifest, token, fetchImpl });
    if (last.ok && last.sha256 === targetSha) return { state: 'TARGET_LIVE', live: last };
    if (last.ok && last.sha256 !== previousSha) return { state: 'FOREIGN_LIVE', live: last };
    if (i < attempts - 1) await sleep(delayMs);
  }
  return { state: last?.ok ? 'PREVIOUS_LIVE' : 'UNREADABLE', live: last };
}
// Best-effort drift guard (see CONCURRENCY): a change between this read and the PATCH is not excluded.
async function assertNoDrift({ manifest, token, fetchImpl, expected }) {
  const now = await readLive({ manifest, token, fetchImpl });
  assert.ok(now.ok, 'live rules unreadable immediately before publish');
  assert.equal(now.ruleset_name, expected.ruleset_name, 'LIVE_DRIFT: active ruleset changed since plan');
  assert.equal(now.sha256, expected.sha256, 'LIVE_DRIFT: active rules changed since plan');
  if (expected.update_time) assert.equal(now.update_time, expected.update_time, 'LIVE_DRIFT: release updateTime changed since plan');
  return now;
}
async function apply({ manifest, local, artifact, token, env, fetchImpl = fetch, allowNonAtomic = false, settleAttempts = 3, settleDelayMs = 2000 }) {
  assertNonAtomicAcknowledged(allowNonAtomic);
  const target = sha256(local);
  assertMutationAuthorized(env, target);
  const live = await readLive({ manifest, token, fetchImpl });
  const p = plan({ manifest, local, live, artifact });
  assert.equal(p.status, 'READY_BLOCKED_NON_ATOMIC', 'plan not ready: ' + p.blockers.join(','));
  await assertNoDrift({ manifest, token, fetchImpl, expected: live });
  const previousSha = artifact.meta.rules_sha256;
  try {
    await publish({ manifest, content: local, token, fetchImpl });
  } catch (e) {
    if (!(e instanceof StorageRulesError) || !UNCERTAIN.has(e.category)) throw e; // definite failure: nothing applied
    const s = await settle({ manifest, token, fetchImpl, targetSha: target, previousSha, attempts: settleAttempts, delayMs: settleDelayMs });
    if (s.state === 'TARGET_LIVE') return { status: 'APPLIED_VERIFIED_DEFERRED', sha256: target };
    if (s.state === 'PREVIOUS_LIVE') return { status: 'NOT_APPLIED_VERIFIED', sha256: previousSha };
    return { status: 'UNKNOWN_STATE_MANUAL_INTERVENTION', sha256: s.live?.sha256 ?? null, reason: s.state }; // never overwrite what we do not understand
  }
  const after = await readLive({ manifest, token, fetchImpl });
  if (after.ok && after.sha256 === target) return { status: 'APPLIED_VERIFIED', sha256: target };
  if (after.ok && after.sha256 !== previousSha) // neither ours nor the previous: someone else changed it, do not stomp
    return { status: 'UNKNOWN_STATE_MANUAL_INTERVENTION', sha256: after.sha256, reason: 'FOREIGN_LIVE' };
  try { await publish({ manifest, content: artifact.content, token, fetchImpl }); }
  catch (e) { return { status: 'ROLLBACK_PUBLISH_FAILED_UNVERIFIED', sha256: null, reason: e.category || 'ERROR' }; }
  const s2 = await settle({ manifest, token, fetchImpl, targetSha: previousSha, previousSha: target, attempts: settleAttempts, delayMs: settleDelayMs });
  return s2.state === 'TARGET_LIVE' ? { status: 'VERIFY_FAILED_ROLLED_BACK', sha256: previousSha }
    : { status: 'VERIFY_FAILED_ROLLBACK_UNVERIFIED', sha256: s2.live?.sha256 ?? null };
}
// expectedLiveSha is REQUIRED: a rollback must only replace the rules this release put there.
async function rollback({ manifest, artifact, expectedLiveSha, token, env, fetchImpl = fetch, allowNonAtomic = false, settleAttempts = 3, settleDelayMs = 2000 }) {
  assertNonAtomicAcknowledged(allowNonAtomic);
  verifyRollbackArtifact(manifest, artifact.meta, artifact.content);
  assertMutationAuthorized(env, artifact.meta.rules_sha256);
  assert.match(expectedLiveSha || '', SHA_RE, 'expectedLiveSha required');
  const now = await readLive({ manifest, token, fetchImpl });
  assert.ok(now.ok, 'live rules unreadable before rollback');
  assert.equal(now.sha256, expectedLiveSha, 'LIVE_DRIFT: live rules are not the ones this release published; refusing to overwrite');
  try { await publish({ manifest, content: artifact.content, token, fetchImpl }); }
  catch (e) { if (!(e instanceof StorageRulesError) || !UNCERTAIN.has(e.category)) throw e; }
  const s = await settle({ manifest, token, fetchImpl, targetSha: artifact.meta.rules_sha256, previousSha: expectedLiveSha, attempts: settleAttempts, delayMs: settleDelayMs });
  if (s.state === 'TARGET_LIVE') return { status: 'ROLLED_BACK_VERIFIED', sha256: artifact.meta.rules_sha256 };
  return { status: 'ROLLBACK_UNVERIFIED', sha256: s.live?.sha256 ?? null, reason: s.state };
}

// ---- CLI: read-only commands only ---------------------------------------------------------------
async function main(argv = process.argv.slice(2), env = process.env) {
  const cmd = argv[0];
  const manifest = loadManifest('.');
  const out = 'release-output';
  fs.mkdirSync(out, { recursive: true });
  if (cmd === 'verify-artifact') {
    const a = loadRollbackArtifact(manifest, env.STORAGE_ROLLBACK_DIR || '.release/rollback', env.STORAGE_ROLLBACK_SHA);
    const digest = custodyDigest(a.meta, a.content);
    if (env.STORAGE_CUSTODY_DIGEST) assert.equal(digest, env.STORAGE_CUSTODY_DIGEST, 'custody digest differs from the approved one');
    console.log('STORAGE_ARTIFACT_VERIFIED=' + a.meta.rules_sha256 + ' CUSTODY_DIGEST=' + digest);
    return 0;
  }
  assert.equal(discoverBucket('.', manifest.firebase_project), manifest.bucket, 'bucket drift between apps and manifest');
  const local = assertRulesSource(fs.readFileSync(manifest.rules_path, 'utf8'));
  if (cmd === 'readback' || cmd === 'capture') {
    if (env.GITHUB_ACTIONS === 'true') assertReadonlyIdentity(env);
    const live = await readLive({ manifest, token: env.GOOGLE_ACCESS_TOKEN, fetchImpl: readOnlyFetch() });
    const report = readbackReport({ manifest, local, live });
    fs.writeFileSync(path.join(out, 'storage-readback.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('STORAGE_LIVE_READBACK=' + report.live_readback + ' RULES_DIFF=' + report.rules_diff + ' ERROR=' + report.error);
    if (cmd === 'capture' && live.ok) {
      const a = buildRollbackArtifact({ manifest, live, provenance: { repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF, run_id: env.GITHUB_RUN_ID,
        run_attempt: env.GITHUB_RUN_ATTEMPT, commit: env.GITHUB_SHA, workflow: env.GITHUB_WORKFLOW } });
      fs.writeFileSync(path.join(out, a.rulesFile), a.content);
      fs.writeFileSync(path.join(out, a.metaFile), JSON.stringify(a.meta, null, 2) + '\n');
      const digest = custodyDigest(a.meta, a.content);
      fs.writeFileSync(path.join(out, 'storage-custody.json'), JSON.stringify({ rules_sha256: a.meta.rules_sha256, custody_digest: digest,
        retention: 'TEMPORARY_WORKFLOW_ARTIFACT', immutability: 'NOT_DEMONSTRATED', record_digest_out_of_band: true }, null, 2) + '\n');
      console.log('STORAGE_ROLLBACK_ARTIFACT=' + a.meta.rules_sha256 + ' CUSTODY_DIGEST=' + digest);
    }
    return live.ok ? 0 : 1;
  }
  if (cmd === 'plan') {
    const live = await readLive({ manifest, token: env.GOOGLE_ACCESS_TOKEN, fetchImpl: readOnlyFetch() });
    const artifact = env.STORAGE_ROLLBACK_SHA ? loadRollbackArtifact(manifest, env.STORAGE_ROLLBACK_DIR || '.release/rollback', env.STORAGE_ROLLBACK_SHA) : null;
    const p = plan({ manifest, local, live, artifact });
    fs.writeFileSync(path.join(out, 'storage-plan.json'), JSON.stringify(p, null, 2) + '\n');
    console.log('STORAGE_PLAN=' + p.status + ' ' + p.blockers.join(','));
    return p.status === 'BLOCKED' ? 1 : 0;
  }
  throw new Error('usage: storage-rules.cjs readback|capture|plan|verify-artifact   (apply/rollback are library-only by design)');
}
if (require.main === module) main().then(c => { process.exitCode = c; }).catch(e => { console.error('storage-rules failed: ' + (e.category || e.message)); process.exitCode = 1; });

module.exports = { loadManifest, discoverBucket, releaseName, assertRulesSource, readLive, readOnlyFetch, assertReadonlyIdentity, compare, readbackReport,
  buildRollbackArtifact, verifyRollbackArtifact, loadRollbackArtifact, custodyDigest, assertProvenance, plan, apply, rollback, publish,
  assertMutationAuthorized, StorageRulesError, sha256, ATOMIC_PRECONDITION_AVAILABLE };
