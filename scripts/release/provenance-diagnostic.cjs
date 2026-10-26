'use strict';
// T618 — read-only provenance diagnostic for Firebase Rules and the served Vercel deployment.
// Contract: GET only; Rules source is processed IN MEMORY and never returned, logged or persisted (only a hash, a size and bounded metadata survive);
// every persisted field is built one by one from an allowlist (no object spreading, no response bodies, no headers, no tokens).
// Nothing here asserts that an API representation is byte-identical to a historical file, and nothing here marks a rollback as VERIFIED.
const crypto = require('node:crypto');

const SCHEMA = 'vdsen-provenance-diagnostic-v1';
const HASH_ALGORITHM = 'vdsen-rules-source-v1';
const KNOWN_RULES_SHA256 = Object.freeze({
  HISTORIC_FILE: 'ba172a4f2e9831e55fb0a10c369b4a073193efb56eb5ea61245a0f178043e1e6',
  T603_CANDIDATE_FILE: 'fe1517306bebd4bd529adfc51a406c5e97cac6b2dfd7fcae61c87318dd2e21e0'
});
const FIREBASE_TARGETS = Object.freeze({
  production: Object.freeze({ project: 'vdsen-ecosistema', projectNumber: '1066774387899' }),
  staging: Object.freeze({ project: 'vdsen-ecosistema-staging', projectNumber: '436059785391' })
});
const SHA256 = /^[0-9a-f]{64}$/, COMMIT = /^[0-9a-f]{40}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

class ProvenanceError extends Error {
  constructor(endpoint, httpStatus, category) { super(category); this.endpoint = endpoint; this.httpStatus = httpStatus; this.category = category; }
}
function httpCategory(status) {
  if ([400, 401, 403, 404, 422].includes(status)) return 'HTTP_' + status;
  if (status >= 500) return 'HTTP_5XX';
  return 'HTTP_OTHER';
}
// The ONLY network primitive of this module: method is fixed to GET, the only header is Authorization, redirects are errors, bodies are parsed in memory and returned to the caller only.
async function getJson(fetchImpl, endpoint, url, token) {
  if (!token) throw new ProvenanceError(endpoint, null, 'HTTP_401');
  let response;
  try { response = await fetchImpl(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch (error) { throw new ProvenanceError(endpoint, null, error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'TIMEOUT' : 'NETWORK_ERROR'); }
  if (!response.ok) throw new ProvenanceError(endpoint, response.status, httpCategory(response.status));
  let data;
  try { data = await response.json(); } catch { throw new ProvenanceError(endpoint, response.status, 'INVALID_JSON'); }
  return { data, status: response.status };
}

// ── Deterministic hashing of a (possibly multi-file) Rules source ─────────────────────────────────────────────
// vdsen-rules-source-v1:
//   1. Accept only a non-empty array of { name: non-empty well-formed string, content: well-formed string }; names must be unique (else INCONSISTENT).
//   2. Order files by the bytewise comparison of the UTF-8 encoding of `name` (never locale-dependent).
//   3. Canonical byte stream = ASCII "vdsen-rules-source-v1\n" + decimal(fileCount) + "\n", then for every file in that order:
//        decimal(byteLength(nameUtf8)) + ":" + nameUtf8 + decimal(byteLength(contentUtf8)) + ":" + contentUtf8
//      (length-prefixed, so no delimiter can be forged by file content; content is used exactly as returned: no newline, BOM or Unicode normalization).
//   4. digest = SHA-256 of that stream, lowercase hex. `canonical_bytes` = stream length; `content_bytes_total` = sum of content byte lengths.
//   5. Only when there is exactly ONE file is `raw_single_file_sha256` (SHA-256 of its content bytes alone) also reported: the only value comparable to a repository file hash.
function canonicalRulesDigest(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > 32) return { ok: false, reason: 'SOURCE_FILES_INVALID' };
  const items = [];
  for (const file of files) {
    if (!file || typeof file !== 'object' || typeof file.name !== 'string' || file.name === '' || typeof file.content !== 'string') return { ok: false, reason: 'SOURCE_FILE_INVALID' };
    if (!file.name.isWellFormed() || !file.content.isWellFormed()) return { ok: false, reason: 'SOURCE_ENCODING_INVALID' };
    items.push({ name: Buffer.from(file.name, 'utf8'), content: Buffer.from(file.content, 'utf8'), label: file.name });
  }
  if (new Set(items.map(i => i.name.toString('hex'))).size !== items.length) return { ok: false, reason: 'SOURCE_FILE_NAMES_NOT_UNIQUE' };
  items.sort((a, b) => Buffer.compare(a.name, b.name));
  const parts = [Buffer.from(HASH_ALGORITHM + '\n' + items.length + '\n', 'ascii')];
  for (const i of items) parts.push(Buffer.from(i.name.length + ':', 'ascii'), i.name, Buffer.from(i.content.length + ':', 'ascii'), i.content);
  const stream = Buffer.concat(parts);
  return {
    ok: true, sha256: crypto.createHash('sha256').update(stream).digest('hex'), canonicalBytes: stream.length,
    contentBytesTotal: items.reduce((n, i) => n + i.content.length, 0), fileCount: items.length,
    fileNames: items.map(i => i.label).filter(n => /^[A-Za-z0-9_.\/-]{1,100}$/.test(n)),
    rawSingleFileSha256: items.length === 1 ? crypto.createHash('sha256').update(items[0].content).digest('hex') : null
  };
}
function knownComparison(rawSingleFileSha256) {
  if (rawSingleFileSha256 === KNOWN_RULES_SHA256.HISTORIC_FILE) return 'RAW_SINGLE_FILE_MATCHES_HISTORIC_HASH';
  if (rawSingleFileSha256 === KNOWN_RULES_SHA256.T603_CANDIDATE_FILE) return 'RAW_SINGLE_FILE_MATCHES_T603_CANDIDATE_HASH';
  return rawSingleFileSha256 === null ? 'NOT_COMPARABLE_MULTI_FILE' : 'NO_MATCH';
}

const rulesetPath = (project) => new RegExp('^projects/' + project.replace(/[-]/g, '\\-') + '/rulesets/[A-Za-z0-9_-]{1,128}$');
const isoOrNull = (v) => typeof v === 'string' && ISO_MS.test(v) ? v : null;

// ── Firebase ──────────────────────────────────────────────────────────────────────────────────────────────────
function emptyFirebase(environment, status, error, httpStatus) {
  const t = FIREBASE_TARGETS[environment];
  return {
    environment, project: t.project, project_number: t.projectNumber, project_number_source: 'CONFIGURED_CONSTANT_NOT_API_VERIFIED',
    status, error: error || 'NONE', http_status: httpStatus === undefined ? null : httpStatus,
    release_name: null, release_update_time: null, release_create_time: null, ruleset_id: null, ruleset_create_time: null,
    hash_algorithm: HASH_ALGORITHM, source_file_count: null, source_file_names: [], canonical_sha256: null, canonical_bytes: null, content_bytes_total: null,
    raw_single_file_sha256: null, known_hash_comparison: 'NOT_COMPARABLE_NO_SOURCE', api_representation_byte_equivalence: 'NOT_ASSERTED',
    rollback_provenance: 'PARTIAL_NOT_VERIFIED', source_content_persisted: false,
    provenance: { release: 'GET firebaserules releases/cloud.firestore', ruleset: 'GET firebaserules rulesets/{id}', hash: 'COMPUTED_IN_MEMORY' }
  };
}
async function collectFirebase(environment, token, fetchImpl) {
  const target = FIREBASE_TARGETS[environment], out = emptyFirebase(environment, 'NOT_VERIFIED');
  if (!target) throw new Error('unknown environment');
  const base = 'https://firebaserules.googleapis.com/v1/';
  const releaseUrl = base + 'projects/' + target.project + '/releases/cloud.firestore?fields=name,rulesetName,createTime,updateTime';
  try {
    const release = await getJson(fetchImpl, 'FIREBASE_RULES_RELEASE', releaseUrl, token);
    const rd = release.data;
    if (!rd || rd.name !== 'projects/' + target.project + '/releases/cloud.firestore' || typeof rd.rulesetName !== 'string' || !rulesetPath(target.project).test(rd.rulesetName)) throw new ProvenanceError('FIREBASE_RULES_RELEASE', release.status, 'ASSERTION_MISMATCH');
    out.release_name = rd.name; out.release_update_time = isoOrNull(rd.updateTime); out.release_create_time = isoOrNull(rd.createTime);
    out.ruleset_id = rd.rulesetName.split('/').pop();
    const ruleset = await getJson(fetchImpl, 'FIREBASE_RULESET_SOURCE', base + rd.rulesetName + '?fields=name,createTime,source', token);
    const sd = ruleset.data;   // contains the Rules source: used in memory below, never copied into `out`
    if (!sd || sd.name !== rd.rulesetName) throw new ProvenanceError('FIREBASE_RULESET_SOURCE', ruleset.status, 'ASSERTION_MISMATCH');
    out.ruleset_create_time = isoOrNull(sd.createTime);
    const digest = canonicalRulesDigest(sd.source && sd.source.files);
    if (!digest.ok) throw new ProvenanceError('FIREBASE_RULESET_SOURCE', ruleset.status, 'INCONSISTENT_' + digest.reason);
    // the active release must not have moved while the source was read, else the hash would describe a different ruleset
    const again = await getJson(fetchImpl, 'FIREBASE_RULES_RELEASE', releaseUrl, token);
    if (!again.data || again.data.rulesetName !== rd.rulesetName || again.data.updateTime !== rd.updateTime) throw new ProvenanceError('FIREBASE_RULES_RELEASE', again.status, 'INCONSISTENT_RELEASE_CHANGED_DURING_READ');
    out.source_file_count = digest.fileCount; out.source_file_names = digest.fileNames.slice(0, 32);
    out.canonical_sha256 = digest.sha256; out.canonical_bytes = digest.canonicalBytes; out.content_bytes_total = digest.contentBytesTotal;
    out.raw_single_file_sha256 = digest.rawSingleFileSha256; out.known_hash_comparison = knownComparison(digest.rawSingleFileSha256);
    out.status = 'VERIFIED_READ_CONSISTENT';   // consistent read of the active ruleset; says nothing about byte equivalence with a repository file or about rollback fitness
    return out;
  } catch (error) {
    if (!(error instanceof ProvenanceError)) throw error;
    out.status = /^INCONSISTENT_/.test(error.category) || error.category === 'ASSERTION_MISMATCH' ? 'INCONSISTENT' : 'NOT_VERIFIED';
    out.error = error.category; out.http_status = error.httpStatus;
    out.canonical_sha256 = null; out.canonical_bytes = null; out.content_bytes_total = null; out.raw_single_file_sha256 = null; out.source_file_count = null; out.source_file_names = [];
    out.known_hash_comparison = 'NOT_COMPARABLE_NO_SOURCE';
    return out;
  }
}

// ── Vercel ────────────────────────────────────────────────────────────────────────────────────────────────────
function emptyVercel(s, domain, status, error, httpStatus) {
  return {
    team_id: s.vercel_team, project_id: s.production_project, domain, status, error: error || 'NONE', http_status: httpStatus === undefined ? null : httpStatus,
    project_identity: 'NOT_VERIFIED', alias_deployment_id: null, deployment_id: null, deployment_state: null, deployment_target: null, deployment_created_at: null,
    deployment_commit_sha: 'ABSENT', alias_to_deployment_correspondence: 'NOT_VERIFIED', correspondence_reason: 'NOT_EVALUATED',
    ready_means_functional_acceptance: false, deletion_inferred_from_http_404: false,
    provenance: { project: 'GET vercel /v9/projects/{id}', alias: 'GET vercel /v4/aliases/{alias}', deployment: 'GET vercel /v13/deployments/{id}', commit: 'deployment.meta.githubCommitSha|gitSource.sha' }
  };
}
async function collectVercel(s, domainUrl, token, fetchImpl) {
  const host = new URL(domainUrl).host, out = emptyVercel(s, host, 'NOT_VERIFIED');
  const team = encodeURIComponent(s.vercel_team), base = 'https://api.vercel.com/';
  try {
    const project = await getJson(fetchImpl, 'VERCEL_PROJECT', base + 'v9/projects/' + s.production_project + '?teamId=' + team, token);
    if (!project.data || project.data.id !== s.production_project || project.data.accountId !== s.vercel_team) throw new ProvenanceError('VERCEL_PROJECT', project.status, 'ASSERTION_MISMATCH');
    out.project_identity = 'VERIFIED';
    const alias = await getJson(fetchImpl, 'VERCEL_ALIAS', base + 'v4/aliases/' + encodeURIComponent(host) + '?teamId=' + team, token);
    const ad = alias.data;
    if (!ad || typeof ad.deploymentId !== 'string' || !/^dpl_[A-Za-z0-9]{8,64}$/.test(ad.deploymentId)) throw new ProvenanceError('VERCEL_ALIAS', alias.status, 'ASSERTION_MISMATCH');
    out.alias_deployment_id = ad.deploymentId;
    const dep = await getJson(fetchImpl, 'VERCEL_DEPLOYMENT', base + 'v13/deployments/' + ad.deploymentId + '?teamId=' + team, token);
    const dd = dep.data;
    if (!dd || dd.id !== ad.deploymentId) throw new ProvenanceError('VERCEL_DEPLOYMENT', dep.status, 'ASSERTION_MISMATCH');
    out.deployment_id = dd.id;
    out.deployment_state = typeof dd.readyState === 'string' && /^[A-Z_]{3,24}$/.test(dd.readyState) ? dd.readyState : null;
    out.deployment_target = dd.target === 'production' || dd.target === null || dd.target === undefined ? (dd.target || 'production_unspecified') : 'OTHER';
    out.deployment_created_at = Number.isFinite(dd.createdAt) ? new Date(dd.createdAt).toISOString() : null;
    const sha = (dd.meta && typeof dd.meta.githubCommitSha === 'string' && dd.meta.githubCommitSha) || (dd.gitSource && typeof dd.gitSource.sha === 'string' && dd.gitSource.sha) || null;
    out.deployment_commit_sha = sha && COMMIT.test(sha) ? sha : 'ABSENT';
    const aliasProject = ad.projectId === undefined ? null : ad.projectId, depProject = dd.projectId === undefined ? null : dd.projectId;
    let reason = 'OK';
    if (aliasProject !== s.production_project) reason = 'ALIAS_PROJECT_NOT_CONFIRMED';
    else if (depProject !== s.production_project) reason = 'DEPLOYMENT_PROJECT_NOT_CONFIRMED';
    else if (dd.target !== 'production') reason = 'DEPLOYMENT_TARGET_NOT_PRODUCTION';
    else if (Array.isArray(dd.alias) && !dd.alias.includes(host)) reason = 'ALIAS_NOT_LISTED_ON_DEPLOYMENT';
    out.correspondence_reason = reason;
    out.alias_to_deployment_correspondence = reason === 'OK' ? 'VERIFIED' : 'NOT_VERIFIED';
    out.status = out.alias_to_deployment_correspondence === 'VERIFIED' ? 'VERIFIED_READ_CONSISTENT' : 'NOT_VERIFIED';
    return out;
  } catch (error) {
    if (!(error instanceof ProvenanceError)) throw error;
    out.status = error.category === 'ASSERTION_MISMATCH' ? 'INCONSISTENT' : 'NOT_VERIFIED';
    out.error = error.category; out.http_status = error.httpStatus; out.correspondence_reason = 'FETCH_' + error.category;
    return out;
  }
}

// Staging is best effort: the release identity is scoped to production, so a 403/404 there is an expected, recorded outcome and never fails the validation.
async function collect({ state, googleToken, vercelToken, fetchImpl, domainUrl }) {
  const f = fetchImpl || fetch, url = domainUrl || 'https://vdsen-ecosistema.vercel.app';
  const production = await collectFirebase('production', googleToken, f), staging = await collectFirebase('staging', googleToken, f), vercel = await collectVercel(state, url, vercelToken, f);
  return {
    schema: SCHEMA, read_only: true, methods: ['GET'], source_content_persisted: false, secrets_persisted: false,
    firebase: { production, staging }, vercel,
    note: 'READY is not functional acceptance; an API representation is not asserted to be byte-identical to a repository file; a recorded hash does not verify a rollback.'
  };
}

module.exports = { SCHEMA, HASH_ALGORITHM, KNOWN_RULES_SHA256, FIREBASE_TARGETS, ProvenanceError, getJson, canonicalRulesDigest, knownComparison, collectFirebase, collectVercel, collect };
