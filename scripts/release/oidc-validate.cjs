'use strict';
// Dedicated read-only path: no production release imports, client-data requests or mutation verbs.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { json, validate, environmentContract } = require('./lib.cjs');
const output = 'release-output/oidc-validation.json';
const state = () => validate(json('.release/vdsen-client.json'), json('.release/schema/release-state.schema.json'));
function base(s) {
  return {
    repository: 'vdsenasesoria-svg/vdsen-ecosistema', ref: 'refs/heads/codex/client-app-next',
    gcp_project: s.firebase_project, release_service_account: 'vdsen-release-bot@vdsen-ecosistema.iam.gserviceaccount.com',
    configuration: 'GAP', oidc_auth: 'GAP', project_metadata_read: 'GAP', firestore_index_metadata_read: 'GAP',
    firebase_rules_metadata_read: 'GAP', vercel_project_read: 'GAP', production_release_enabled: process.env.PRODUCTION_RELEASE_ENABLED === 'true',
    project_metadata_endpoint: 'GCP_PROJECT_METADATA', project_metadata_http_status: null, project_metadata_error: 'NONE',
    firestore_index_metadata_endpoint: 'FIRESTORE_INDEX_METADATA', firestore_index_metadata_http_status: null, firestore_index_metadata_error: 'NONE',
    firebase_rules_metadata_endpoint: 'FIREBASE_RULES_RELEASE_METADATA', firebase_rules_metadata_http_status: null, firebase_rules_metadata_error: 'NONE',
    vercel_project_endpoint: 'VERCEL_PROJECT_METADATA', vercel_project_http_status: null, vercel_project_error: 'NONE',
    kill_switch_configuration: process.env.PRODUCTION_RELEASE_ENABLED === 'false' ? 'EXPECTED_FALSE' : process.env.PRODUCTION_RELEASE_ENABLED === 'true' ? 'TRUE' : process.env.PRODUCTION_RELEASE_ENABLED === undefined || process.env.PRODUCTION_RELEASE_ENABLED === '' ? 'UNSET' : 'INVALID',
    firestore_index_api_error_code: null, firestore_index_api_error_status: 'ABSENT', firestore_index_api_error_reason: 'ABSENT', firestore_index_api_error_field: 'ABSENT',
    vercel_api_error_code: 'ABSENT', vercel_api_error_scope_type: 'ABSENT', vercel_api_error_team_match: 'ABSENT',
    mutations_performed: false, least_privilege_verification: 'GAP',
    least_privilege_note: 'Metadata success does not prove absence of IAM/key/client-data permissions; no destructive probes or client-data reads performed',
    validation_status: 'FAIL', error: null, timestamp: new Date().toISOString()
  };
}
class MetadataError extends Error {
  constructor(endpoint, httpStatus, category, detail = null) {
    super(category);
    this.endpoint = endpoint;
    this.httpStatus = httpStatus;
    this.category = category;
    this.detail = detail; // Already sanitized, bounded fields only; never the response body.
  }
}
// NETWORK_ERROR is reserved for transport failures; every received HTTP status gets an HTTP_* category.
function httpCategory(status) {
  if ([400, 401, 403, 404, 422].includes(status)) return 'HTTP_' + status;
  if (status >= 500) return 'HTTP_5XX';
  return 'HTTP_OTHER';
}
const GOOGLE_STATUSES = new Set(['INVALID_ARGUMENT', 'PERMISSION_DENIED', 'FAILED_PRECONDITION', 'UNAUTHENTICATED', 'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL', 'OUT_OF_RANGE', 'ABORTED', 'ALREADY_EXISTS', 'DEADLINE_EXCEEDED', 'UNIMPLEMENTED', 'CANCELLED', 'UNKNOWN']);
const bounded = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : null;
// Google error body is parsed in memory only; just bounded identifiers survive (never messages, descriptions or values).
function googleDetail(body) {
  const e = body && typeof body === 'object' ? body.error : null;
  if (!e || typeof e !== 'object') return null;
  const details = Array.isArray(e.details) ? e.details.slice(0, 16).filter(d => d && typeof d === 'object') : [];
  const violation = details.flatMap(d => Array.isArray(d.fieldViolations) ? d.fieldViolations.slice(0, 16) : []).find(v => v && typeof v === 'object');
  const info = details.find(d => typeof d.reason === 'string');
  const reason = bounded(info?.reason, /^[A-Z][A-Z0-9_]{0,63}$/);
  const field = bounded(violation?.field, /^[A-Za-z][A-Za-z0-9_.]{0,63}$/);
  return {
    code: Number.isInteger(e.code) && e.code >= 100 && e.code <= 599 ? e.code : null,
    status: typeof e.status === 'string' ? (GOOGLE_STATUSES.has(e.status) ? e.status : 'OTHER') : 'ABSENT',
    reason: reason || (info ? 'OTHER' : violation ? 'FIELD_VIOLATION' : 'ABSENT'),
    field: field || (violation ? 'OTHER' : 'ABSENT')
  };
}
// Vercel error body is parsed in memory only; foreign team identifiers are compared, never stored.
function vercelDetail(body, expectedTeam) {
  const e = body && typeof body === 'object' ? body.error : null;
  if (!e || typeof e !== 'object') return null;
  const teams = [e.teamId, e.team_id, e.accountId, e.scope].filter(v => typeof v === 'string' && v.startsWith('team_'));
  const scoped = [e.teamId, e.team_id, e.accountId, e.scope].some(v => typeof v === 'string' && v);
  const teamMatch = teams.length === 0 ? 'ABSENT' : teams.every(t => t === expectedTeam) ? 'MATCH' : 'MISMATCH';
  const rawCode = typeof e.code === 'string' ? e.code.toLowerCase() : '';
  const scopeMessage = typeof e.message === 'string' && /scope/i.test(e.message);
  let code;
  if (e.invalidToken === true || rawCode === 'invalidtoken' || rawCode === 'invalid_token') code = 'invalid_token';
  else if (rawCode === 'unauthorized') code = 'unauthorized';
  else if (rawCode === 'forbidden') code = teamMatch === 'MISMATCH' ? 'team_scope_mismatch' : teamMatch === 'MATCH' ? 'project_access_denied' : scopeMessage ? 'scope_mismatch' : 'forbidden';
  else code = rawCode ? 'unknown' : 'ABSENT';
  return { code, scopeType: teams.length ? 'team' : scoped ? 'other' : 'ABSENT', teamMatch };
}
function save(r) {
  validate(r, json('.release/schema/oidc-validation.schema.json'));
  fs.mkdirSync('release-output', { recursive: true });
  fs.writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
}
function configuration(s) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
  assert.equal(process.env.GITHUB_REPOSITORY, 'vdsenasesoria-svg/vdsen-ecosistema');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/client-app-next');
  environmentContract(s); // Shared canonical configuration; intentionally no mutation kill-switch guard.
}
function init() {
  const s = state(), r = base(s);
  try { configuration(s); r.configuration = 'PASS'; }
  catch { r.configuration = 'FAIL'; r.error = 'CANONICAL_CONFIGURATION_OR_PUSH_CONTEXT_INVALID'; }
  save(r);
  return r.configuration === 'PASS' ? 0 : 1;
}
async function get(endpoint, url, token, sanitize) {
  if (!token) throw new MetadataError(endpoint, null, 'HTTP_401');
  let response;
  try {
    response = await fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  } catch (error) {
    throw new MetadataError(endpoint, null, error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR');
  }
  if (!response.ok) {
    let detail = null;
    if (sanitize) { try { detail = sanitize(await response.json()); } catch { detail = null; } } // In-memory only; raw bodies and credentials are never logged or persisted.
    throw new MetadataError(endpoint, response.status, httpCategory(response.status), detail);
  }
  return { data: await response.json(), status: response.status };
}
function diagnose(r, prefix, endpoint, httpStatus, error) {
  r[prefix + '_endpoint'] = endpoint;
  r[prefix + '_http_status'] = httpStatus;
  r[prefix + '_error'] = error;
}
function applyDetail(r, prefix, detail) {
  if (!detail) return;
  if (prefix === 'firestore_index_metadata') {
    r.firestore_index_api_error_code = detail.code; r.firestore_index_api_error_status = detail.status;
    r.firestore_index_api_error_reason = detail.reason; r.firestore_index_api_error_field = detail.field;
  } else if (prefix === 'vercel_project') {
    r.vercel_api_error_code = detail.code; r.vercel_api_error_scope_type = detail.scopeType; r.vercel_api_error_team_match = detail.teamMatch;
  }
}
async function probe(s, r) {
  configuration(s);
  assert.equal(process.env.OIDC_AUTH_OUTCOME, 'success');
  assert.ok(process.env.GOOGLE_ACCESS_TOKEN);
  r.configuration = 'PASS'; r.oidc_auth = 'PASS';
  const attempts = [
    ['project_metadata_read', 'project_metadata', async () => {
      const result = await get('GCP_PROJECT_METADATA', 'https://cloudresourcemanager.googleapis.com/v1/projects/' + s.firebase_project + '?fields=projectId', process.env.GOOGLE_ACCESS_TOKEN);
      if (result.data.projectId !== s.firebase_project) throw new MetadataError('GCP_PROJECT_METADATA', result.status, 'ASSERTION_MISMATCH');
      return { endpoint: 'GCP_PROJECT_METADATA', status: result.status };
    }],
    ['firestore_index_metadata_read', 'firestore_index_metadata', async () => {
      // Canonical request has no pageSize parameter: the live control probe proved pageSize=1 is rejected with HTTP 400.
      const result = await get('FIRESTORE_INDEX_METADATA', 'https://firestore.googleapis.com/v1/projects/' + s.firebase_project + '/databases/(default)/collectionGroups/' + s.required_index.collectionGroup + '/indexes', process.env.GOOGLE_ACCESS_TOKEN, googleDetail);
      if (!(result.data.indexes === undefined || Array.isArray(result.data.indexes))) throw new MetadataError('FIRESTORE_INDEX_METADATA', result.status, 'ASSERTION_MISMATCH');
      return { endpoint: 'FIRESTORE_INDEX_METADATA', status: result.status };
    }],
    ['firebase_rules_metadata_read', 'firebase_rules_metadata', async () => {
      const release = await get('FIREBASE_RULES_RELEASE_METADATA', 'https://firebaserules.googleapis.com/v1/projects/' + s.firebase_project + '/releases/cloud.firestore?fields=name,rulesetName', process.env.GOOGLE_ACCESS_TOKEN);
      if (typeof release.data.rulesetName !== 'string' || !new RegExp('^projects/' + s.firebase_project + '/rulesets/[A-Za-z0-9_-]+$').test(release.data.rulesetName)) throw new MetadataError('FIREBASE_RULES_RELEASE_METADATA', release.status, 'ASSERTION_MISMATCH');
      const ruleset = await get('FIREBASE_RULESET_METADATA', 'https://firebaserules.googleapis.com/v1/' + release.data.rulesetName + '?fields=name,metadata', process.env.GOOGLE_ACCESS_TOKEN);
      if (ruleset.data.name !== release.data.rulesetName) throw new MetadataError('FIREBASE_RULESET_METADATA', ruleset.status, 'ASSERTION_MISMATCH');
      return { endpoint: 'FIREBASE_RULESET_METADATA', status: ruleset.status };
    }],
    ['vercel_project_read', 'vercel_project', async () => {
      const result = await get('VERCEL_PROJECT_METADATA', 'https://api.vercel.com/v9/projects/' + s.production_project + '?teamId=' + encodeURIComponent(s.vercel_team), process.env.VERCEL_TOKEN, body => vercelDetail(body, s.vercel_team));
      if (result.data.id !== s.production_project || result.data.accountId !== s.vercel_team) throw new MetadataError('VERCEL_PROJECT_METADATA', result.status, 'ASSERTION_MISMATCH');
      return { endpoint: 'VERCEL_PROJECT_METADATA', status: result.status };
    }]
  ];
  await Promise.all(attempts.map(async ([key, prefix, run]) => {
    try {
      const result = await run(); r[key] = 'PASS'; diagnose(r, prefix, result.endpoint, result.status, 'NONE');
    } catch (error) {
      r[key] = 'FAIL';
      diagnose(r, prefix, error instanceof MetadataError ? error.endpoint : r[prefix + '_endpoint'], error instanceof MetadataError ? error.httpStatus : null, error instanceof MetadataError ? error.category : 'NETWORK_ERROR');
      if (error instanceof MetadataError) applyDetail(r, prefix, error.detail);
    }
  }));
  r.validation_status = attempts.every(([key]) => r[key] === 'PASS') ? 'PASS' : 'FAIL';
  if (r.validation_status === 'FAIL') r.error = 'METADATA_CAPABILITY_VALIDATION_FAILED';
  return r;
}
async function run() {
  const s = state(), r = fs.existsSync(output) ? json(output) : base(s);
  try { await probe(s, r); }
  catch { r.validation_status = 'FAIL'; r.oidc_auth = 'FAIL'; r.error = 'CANONICAL_CONFIGURATION_OR_OIDC_AUTH_FAILED'; }
  save(r);
  return r.validation_status === 'PASS' ? 0 : 1;
}
function finalize() {
  const r = fs.existsSync(output) ? json(output) : base(state());
  if (process.env.OIDC_AUTH_OUTCOME !== 'success') {
    r.oidc_auth = r.configuration === 'FAIL' ? 'GAP' : 'FAIL';
    r.validation_status = 'FAIL'; r.error ||= 'OIDC_AUTH_NOT_COMPLETED';
  }
  if (process.env.VALIDATION_OUTCOME !== 'success') {
    r.validation_status = 'FAIL'; r.error ||= 'VALIDATION_NOT_COMPLETED';
  }
  save(r);
}
if (require.main === module) {
  const command = { init, run, finalize }[process.argv[2]];
  if (!command) { console.error('Expected init, run or finalize'); process.exitCode = 1; }
  else Promise.resolve().then(command).then(code => { process.exitCode = code || 0; }).catch(() => { console.error('OIDC validation failed; details withheld'); process.exitCode = 1; });
}
module.exports = { base, configuration, probe, init, run, finalize };
