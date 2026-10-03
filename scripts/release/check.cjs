'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { hash, json, git, validate, noSecrets } = require('./lib.cjs');
function check(runtime = process.env.RUNTIME_SHA) {
  const state = validate(json('.release/vdsen-client.json'), json('.release/schema/release-state.schema.json'));
  runtime ||= state.runtime_sha;
  assert.match(runtime, /^[0-9a-f]{40}$/);
  assert.equal(runtime, state.runtime_sha, 'Runtime must be the reviewed state SHA');
  git('cat-file', '-e', runtime + '^{commit}');
  git('merge-base', '--is-ancestor', runtime, 'origin/codex/client-app-next');
  const ref = process.env.GITHUB_REF;
  if (ref && process.env.GITHUB_EVENT_NAME !== 'pull_request') assert.equal(ref, 'refs/heads/codex/client-app-next');
  if (!ref) assert.equal(git('branch', '--show-current').trim(), 'codex/client-app-next');
  const changed = git('diff', '--name-only', runtime, 'HEAD').trim().split('\n').filter(Boolean);
  for (const file of changed) assert.ok(/^(docs\/|tests\/|scripts\/release\/|\.github\/|\.release\/|AGENTS\.md$)/.test(file), 'Runtime/package mismatch: ' + file);
  // Check committed bytes to avoid Windows checkout line ending conversions.
  assert.equal(hash(git('show', runtime + ':firestore.rules')), state.rules_transition.target_sha256);
  assert.equal(hash(git('show', 'HEAD:firestore.rules')), state.rules_transition.target_sha256);
  const indexes = JSON.parse(git('show', runtime + ':firestore.indexes.json'));
  assert.deepEqual(indexes.indexes, [state.required_index]);
  assert.deepEqual(indexes.fieldOverrides, []);
  assert.deepEqual(JSON.parse(git('show', runtime + ':package.json')), json('package.json'));
  for (const module of ['progression-effective-prescription', 'progression-application-consumer', 'progression-auto-apply-shadow', 'progression-magnitude-policy']) {
    assert.equal(require('../../assets/' + module + '.js').NUMERIC_APPLY_ENABLED, false, module);
  }
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  for (const file of files) {
    assert.ok(!/(^|\/)(?:\.env(?:\.local)?|.*\.(?:pem|p12|pfx)|gha-creds-.*\.json)$/.test(file), 'Forbidden credential file: ' + file);
    const bytes = fs.readFileSync(file);
    if (!bytes.includes(0)) noSecrets(bytes.toString('utf8'), file);
  }
  console.log('PASS release state / provenance / numeric flag / rules / index / package / tracked secret patterns');
  return state;
}
if (require.main === module) { try { check(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { check };
