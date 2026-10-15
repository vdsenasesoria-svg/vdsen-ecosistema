'use strict';
// Firebase Storage Rules lane: LIVE READBACK, PLAN, APPLY and ROLLBACK for storage.rules.
//
// Why this is separate from firebase.json: firebase.json is part of the hashed, publicly served
// product surface (.release/deployed-product.json) and T540 pins its shape. The release lanes talk
// to the Firebase Rules REST API directly (like live.cjs does for Firestore), so Storage is registered
// in `.release/storage-rules.json` instead. Nothing here is reachable from `firebase deploy`.
//
// Stages are strictly separated and every one is fail-closed:
//   readback  READ ONLY   live release -> ruleset -> content hash, compared with storage.rules
//   capture   READ ONLY   writes the rollback artifact from the CURRENT live rules (identity+hash+provenance)
//   plan      READ ONLY   refuses unless live is readable AND the artifact equals what is live now
//   apply     MUTATION    gated by STORAGE_RULES_RELEASE_ENABLED=true + STORAGE_RULES_APPROVED_SHA == hash
//   rollback  MUTATION    same gate; restores ONLY from a verified artifact
// No workflow in this repository calls apply/rollback. Responses/tokens are never logged.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const API = 'https://firebaserules.googleapis.com/v1/';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const SHA_RE = /^[0-9a-f]{64}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{2,62}$/;

class StorageRulesError extends Error {
  constructor(category, status = null) { super(category); this.category = category; this.httpStatus = status; }
}
const httpCategory = s => ([400, 401, 403, 404, 409, 422, 429].includes(s) ? 'HTTP_' + s : s >= 500 ? 'HTTP_5XX' : 'HTTP_OTHER');

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
const releaseName = (project, bucket) => 'projects/' + project + '/releases/firebase.storage/' + bucket;

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
    throw new StorageRulesError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR');
  }
  if (!r.ok) throw new StorageRulesError(httpCategory(r.status), r.status); // body deliberately never read
  try { const t = await r.text(); return t ? JSON.parse(t) : {}; } catch { throw new StorageRulesError('MALFORMED_RESPONSE', r.status); }
}

// READ ONLY. Returns a result object instead of throwing so the report is always producible.
async function readLive({ manifest, token, fetchImpl = fetch }) {
  const out = { ok: false, release_name: manifest.release_name, ruleset_name: null, sha256: null, source: null, error: 'NONE', http_status: null, stage: 'release' };
  try {
    const rel = await call(fetchImpl, token, manifest.release_name);
    if (rel.name !== manifest.release_name) throw new StorageRulesError('ASSERTION_MISMATCH');
    if (typeof rel.rulesetName !== 'string' || !rel.rulesetName.startsWith('projects/' + manifest.firebase_project + '/rulesets/')) throw new StorageRulesError('NO_ACTIVE_RULESET');
    out.ruleset_name = rel.rulesetName; out.stage = 'ruleset';
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
function buildRollbackArtifact({ manifest, live, provenance, now = new Date() }) {
  assert.ok(live?.ok, 'cannot capture a rollback artifact without a readable live ruleset (fail-closed: no prior rules)');
  const content = live.source.files[0].content;
  assertRulesSource(content);
  const meta = { schema: 'vdsen-storage-rollback-v1', firebase_project: manifest.firebase_project, bucket: manifest.bucket,
    release_name: manifest.release_name, ruleset_name: live.ruleset_name, rules_sha256: sha256(content), rules_bytes: Buffer.byteLength(content),
    captured_at: now.toISOString(), provenance: { source: 'firebase-rules-api-live-readback', ...provenance } };
  return { meta, content, rulesFile: 'storage.rules.' + meta.rules_sha256 + '.rules', metaFile: 'storage.rules.' + meta.rules_sha256 + '.json' };
}
function verifyRollbackArtifact(manifest, meta, content) {
  assert.ok(meta && typeof meta === 'object', 'artifact metadata missing');
  assert.equal(meta.schema, 'vdsen-storage-rollback-v1');
  for (const k of ['firebase_project', 'bucket', 'release_name']) assert.equal(meta[k], manifest[k], 'artifact identity mismatch: ' + k);
  assert.match(meta.rules_sha256 || '', SHA_RE, 'artifact hash format');
  assert.match(meta.ruleset_name || '', new RegExp('^projects/' + manifest.firebase_project + '/rulesets/[A-Za-z0-9_-]+$'), 'artifact ruleset identity');
  assert.ok(meta.provenance && meta.provenance.source && meta.captured_at, 'artifact provenance missing');
  assertRulesSource(content);
  assert.equal(sha256(content), meta.rules_sha256, 'artifact content does not match its recorded hash');
  assert.equal(Buffer.byteLength(content), meta.rules_bytes, 'artifact size mismatch');
  return true;
}
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
  const same = live?.ok && sha256(local || '') === live.sha256;
  return { status: blockers.length ? 'BLOCKED' : same ? 'NOOP_ALREADY_LIVE' : 'READY', blockers, target_sha256: local ? sha256(local) : null, live_sha256: live?.sha256 ?? null };
}

// ---- mutations (gated; never reached by any workflow in this repo) -------------------------------
function assertMutationAuthorized(env, targetSha) {
  assert.equal(env.STORAGE_RULES_RELEASE_ENABLED, 'true', 'STORAGE_RULES_RELEASE_ENABLED is not true; Storage lane is disarmed');
  assert.equal(env.STORAGE_RULES_APPROVED_SHA, targetSha, 'approved sha does not match the rules to publish');
}
async function publish({ manifest, content, token, fetchImpl }) {
  assertRulesSource(content);
  const rs = await call(fetchImpl, token, 'projects/' + manifest.firebase_project + '/rulesets', 'POST', { source: { files: [{ name: manifest.rules_path, content }] } });
  assert.match(rs.name || '', new RegExp('^projects/' + manifest.firebase_project + '/rulesets/[A-Za-z0-9_-]+$'), 'created ruleset identity');
  await call(fetchImpl, token, manifest.release_name, 'PATCH', { release: { name: manifest.release_name, rulesetName: rs.name }, updateMask: 'rulesetName' });
  return rs.name;
}
async function apply({ manifest, local, artifact, token, env, fetchImpl = fetch }) {
  const target = sha256(local);
  assertMutationAuthorized(env, target);
  const live = await readLive({ manifest, token, fetchImpl });
  const p = plan({ manifest, local, live, artifact });
  assert.equal(p.status, 'READY', 'plan not READY: ' + p.blockers.join(','));
  await publish({ manifest, content: local, token, fetchImpl });
  const after = await readLive({ manifest, token, fetchImpl });
  if (after.ok && after.sha256 === target) return { status: 'APPLIED_VERIFIED', sha256: target };
  // Verification failed: restore the captured rules and verify the restoration.
  await publish({ manifest, content: artifact.content, token, fetchImpl });
  const restored = await readLive({ manifest, token, fetchImpl });
  const ok = restored.ok && restored.sha256 === artifact.meta.rules_sha256;
  return { status: ok ? 'VERIFY_FAILED_ROLLED_BACK' : 'VERIFY_FAILED_ROLLBACK_UNVERIFIED', sha256: restored.sha256 };
}
async function rollback({ manifest, artifact, token, env, fetchImpl = fetch }) {
  verifyRollbackArtifact(manifest, artifact.meta, artifact.content);
  assertMutationAuthorized(env, artifact.meta.rules_sha256);
  await publish({ manifest, content: artifact.content, token, fetchImpl });
  const live = await readLive({ manifest, token, fetchImpl });
  assert.ok(live.ok && live.sha256 === artifact.meta.rules_sha256, 'rollback verification failed');
  return { status: 'ROLLED_BACK_VERIFIED', sha256: live.sha256 };
}

// ---- CLI: read-only commands only ---------------------------------------------------------------
async function main(argv = process.argv.slice(2), env = process.env) {
  const cmd = argv[0];
  const manifest = loadManifest('.');
  assert.equal(discoverBucket('.', manifest.firebase_project), manifest.bucket, 'bucket drift between apps and manifest');
  const local = assertRulesSource(fs.readFileSync(manifest.rules_path, 'utf8'));
  const out = 'release-output';
  fs.mkdirSync(out, { recursive: true });
  if (cmd === 'readback' || cmd === 'capture') {
    const live = await readLive({ manifest, token: env.GOOGLE_ACCESS_TOKEN });
    const report = readbackReport({ manifest, local, live });
    fs.writeFileSync(path.join(out, 'storage-readback.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('STORAGE_LIVE_READBACK=' + report.live_readback + ' RULES_DIFF=' + report.rules_diff + ' ERROR=' + report.error);
    if (cmd === 'capture' && live.ok) {
      const a = buildRollbackArtifact({ manifest, live, provenance: { run_id: env.GITHUB_RUN_ID || 'local', repository: env.GITHUB_REPOSITORY || 'local', commit: env.GITHUB_SHA || 'local' } });
      fs.writeFileSync(path.join(out, a.rulesFile), a.content);
      fs.writeFileSync(path.join(out, a.metaFile), JSON.stringify(a.meta, null, 2) + '\n');
      console.log('STORAGE_ROLLBACK_ARTIFACT=' + a.meta.rules_sha256);
    }
    return live.ok ? 0 : 1;
  }
  if (cmd === 'plan') {
    const live = await readLive({ manifest, token: env.GOOGLE_ACCESS_TOKEN });
    const artifact = env.STORAGE_ROLLBACK_SHA ? loadRollbackArtifact(manifest, env.STORAGE_ROLLBACK_DIR || '.release/rollback', env.STORAGE_ROLLBACK_SHA) : null;
    const p = plan({ manifest, local, live, artifact });
    fs.writeFileSync(path.join(out, 'storage-plan.json'), JSON.stringify(p, null, 2) + '\n');
    console.log('STORAGE_PLAN=' + p.status + ' ' + p.blockers.join(','));
    return p.status === 'BLOCKED' ? 1 : 0;
  }
  throw new Error('usage: storage-rules.cjs readback|capture|plan   (apply/rollback are library-only by design)');
}
if (require.main === module) main().then(c => { process.exitCode = c; }).catch(e => { console.error('storage-rules failed: ' + (e.category || e.message)); process.exitCode = 1; });

module.exports = { loadManifest, discoverBucket, releaseName, assertRulesSource, readLive, compare, readbackReport, buildRollbackArtifact, verifyRollbackArtifact,
  loadRollbackArtifact, plan, apply, rollback, publish, assertMutationAuthorized, StorageRulesError, sha256 };
