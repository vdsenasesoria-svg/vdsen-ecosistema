'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
// Binary-safe git read. `git(...)` decodes stdout as utf8, which CORRUPTS binary blobs: hashing
// the decoded string of a .jpg or .ttf never matches the real file. Anything comparing bytes of a
// committed blob (not text) must use this.
const gitBinary = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
// Deliberately limited schema vocabulary. Unknown validation keywords fail closed.
function validate(value, schema, path = '$') {
  const supported = new Set(['$schema', '$id', 'title', 'description', 'type', 'const', 'enum', 'pattern', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'if', 'then', 'minimum']);
  for (const key of Object.keys(schema)) assert.ok(supported.has(key), 'Unsupported schema keyword: ' + key);
  if (schema.type) assert.ok([].concat(schema.type).some(t => t === 'null' ? value === null : t === 'array' ? Array.isArray(value) : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === t), path + ': type');
  if ('const' in schema) assert.deepEqual(value, schema.const, path + ': const');
  if (schema.enum) assert.ok(schema.enum.includes(value), path + ': enum');
  if (schema.pattern && typeof value === 'string') assert.match(value, new RegExp(schema.pattern), path);
  if (schema.minimum !== undefined && typeof value === 'number') assert.ok(value >= schema.minimum, path + ': minimum');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), path + ': missing ' + key);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(child, schema.properties[key], path + '.' + key);
      else if (schema.additionalProperties === false) assert.fail(path + ': unexpected ' + key);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems) assert.ok(value.length >= schema.minItems, path + ': minItems');
    if (schema.items) value.forEach((x, i) => validate(x, schema.items, path + '[' + i + ']'));
  }
  // Conditional requirement: when the instance satisfies `if`, `then` is enforced. Used to make
  // `release_mode: app_only` REQUIRE the `app_release` block instead of merely allowing it.
  // Evaluated AFTER the structural checks so a missing required key inside `then` fails with its
  // concrete path rather than a generic condition error.
  if (schema.if !== undefined && schema.then !== undefined) {
    let matched = true;
    try { validate(value, schema.if, path); } catch (e) { matched = false; }
    if (matched) validate(value, schema.then, path);
  }
  return value;
}
function indexMatches(expected, live) {
  const fields = live.fields?.filter(x => x.fieldPath !== '__name__');
  return live.queryScope === expected.queryScope && fields?.length === expected.fields.length &&
    expected.fields.every((x, i) => x.fieldPath === fields[i].fieldPath && x.order === fields[i].order && x.arrayConfig === fields[i].arrayConfig);
}
// Fail-closed release-mode gate. A state that records one kind of release must not be used to
// drive the other kind: after an app release the state says `app_only`, and the Firestore rules
// lane must refuse rather than treat that state as approval to deploy rules. Pure and local, so it
// can be called BEFORE any network work.
function assertReleaseMode(state, required, lane) {
  assert.ok(state && typeof state === 'object', 'release state required');
  assert.equal(state.release_mode, required,
    lane + ' requires release_mode=' + required + ' but the reviewed state says ' + JSON.stringify(state.release_mode) +
    '; prepare a reviewed ' + required + ' state before dispatching');
  return state;
}
function verifyDeployment(d, state, sha, ref) {
  assert.equal(d.projectId, state.production_project);
  assert.equal(d.readyState, 'READY');
  assert.equal(d.meta?.githubCommitSha, sha);
  assert.equal(d.meta?.githubCommitOrg, 'vdsenasesoria-svg');
  assert.equal(d.meta?.githubCommitRepo, 'vdsen-ecosistema');
  if (ref) assert.equal(d.meta?.githubCommitRef, ref);
  return d;
}
function noSecrets(text, file) {
  const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*(?:\\n)?[A-Za-z0-9+/]{32,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, /\bAKIA[A-Z0-9]{16}\b/, /"type"\s*:\s*"service_account"/];
  assert.ok(!patterns.some(p => p.test(text)), 'Potential private credential in ' + file + ' (value withheld)');
}
function environmentContract(s) {
  assert.equal(process.env.GCP_PROJECT_ID, s.firebase_project, 'GCP project mismatch');
  assert.equal(process.env.VERCEL_PROJECT_ID, s.production_project, 'Vercel project mismatch');
  assert.equal(process.env.VERCEL_ORG_ID, s.vercel_team, 'Vercel organization mismatch');
  assert.equal(process.env.GCP_RELEASE_SERVICE_ACCOUNT, 'vdsen-release-bot@vdsen-ecosistema.iam.gserviceaccount.com');
  assert.match(process.env.GCP_WORKLOAD_IDENTITY_PROVIDER || '', /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[A-Za-z0-9_-]+\/providers\/[A-Za-z0-9_-]+$/);
}
module.exports = { hash, json, git, gitBinary, validate, indexMatches, assertReleaseMode, verifyDeployment, noSecrets, environmentContract };
