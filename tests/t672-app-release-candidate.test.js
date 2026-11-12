'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const D = require('../scripts/release/deployed-product.cjs');
const G = require('../scripts/release/numeric-guard.cjs');
const packet = JSON.parse(fs.readFileSync('.release/t671-app-candidate.json', 'utf8'));
const RUNTIME = 'a8cf462c78c4bd795cc9f485a82f64429c179f00';
const BASELINE = '21dc0e2b211facfb0df9f3079c58488c2f86952c';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

test('T672 the prepared candidate binds the canonical T671 commit and full Git tree without claiming publication', () => {
  assert.equal(packet.runtime_sha, RUNTIME); assert.equal(packet.git_tree_sha, git('rev-parse', RUNTIME + '^{tree}'));
  git('merge-base', '--is-ancestor', RUNTIME, 'HEAD');
  assert.equal(packet.status, 'PREPARED_BLOCKED_NOT_DEPLOYED');
  assert.equal(packet.production_mutation_authorized, false); assert.equal(packet.pilot_renewal_authorized, false);
  assert.equal(packet.release_mode, 'app_only'); assert.equal(packet.numeric_apply_enabled, false);
  assert.equal(packet.workflow, '.github/workflows/vdsen-app-release-prod.yml');
});

test('T672 candidate browser/config and trusted server source hashes match immutable blobs; product delta is exactly T671', () => {
  const expected = [...new Set([...D.SERVED, 'api/autonomous-progression-trigger.js', 'api/_autonomousProgression.js', 'api/_autonomousProgressionSweep.js', 'api/_firebaseAdmin.js'])].sort();
  assert.deepEqual(Object.keys(packet.files).sort(), expected);
  const changed = [];
  for (const p of expected) {
    assert.equal(packet.files[p], D.hashCommitFile(RUNTIME, p), p);
    if (D.hashCommitFile(BASELINE, p) !== packet.files[p]) changed.push(p);
  }
  assert.deepEqual(changed, ['api/autonomous-progression-trigger.js', 'vdsen-cliente.html']);
  assert.deepEqual(packet.changed_product_surfaces, changed);
  assert.ok(D.verifyCandidate(RUNTIME).paths > 0);
});

test('T672 the candidate preserves its historical deployed baseline and a sensitive progression flag still blocks the release', () => {
  // Bind the packet to the immutable preparation snapshot. A later verified release must be able to rebaseline current production.
  const state = JSON.parse(git('show', RUNTIME + ':.release/vdsen-client.json'));
  assert.equal(state.runtime_sha, BASELINE); assert.equal(state.production_deployment, packet.baseline.deployment);
  assert.equal(D.hashCommitFile(RUNTIME, '.release/deployed-product.json'), packet.baseline.deployed_product_sha256);
  assert.equal(D.hashCommitFile(RUNTIME, '.release/vdsen-client.json'), packet.baseline.release_state_sha256);
  const frozen = JSON.parse(git('show', RUNTIME + ':.release/deployed-product.json'));
  for (const [p, sha] of Object.entries(frozen.files)) assert.equal(D.hashCommitFile(BASELINE, p), sha, p);
  assert.throws(() => G.evaluateProductionEnv([{ key: G.FLAG_NUMERIC, type: 'sensitive', target: ['production'] }]), e => e.code === 'VALUE_NOT_READABLE');
  assert.equal(G.evaluateProductionEnv([]).status, 'DISARMED');
});
