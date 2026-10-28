'use strict';
// T641 — the reviewed release state can say, separately and honestly, which Rules are bundled with the pinned runtime and which Rules a recorded Rules release run PUBLISHED.
// Fixtures are synthetic; no production value is invented as a historical fact (the run ids / instants below exist only inside these tests).
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const lib = require('../scripts/release/lib.cjs');
const check = require('../scripts/release/check.cjs');

const SCHEMA = lib.json('.release/schema/release-state.schema.json');
// These tests model the transition FROM the reviewed rules_only package (PR #147 head, immutable); once the committed state moved to app_only (T658-B) they keep modelling that package.
const COMMITTED = lib.json('.release/vdsen-client.json');
const CURRENT = COMMITTED.release_mode === 'rules_only' ? COMMITTED : JSON.parse(lib.git('show', '4fba5fe49388882ca3db8933aba61f6b6418b8d7:.release/vdsen-client.json'));
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const BA172 = 'ba172a4f2e9831e55fb0a10c369b4a073193efb56eb5ea61245a0f178043e1e6', FE151 = 'fe1517306bebd4bd529adfc51a406c5e97cac6b2dfd7fcae61c87318dd2e21e0';
const clone = (x) => JSON.parse(JSON.stringify(x));
const throws = (fn, re, label) => { try { fn(); assert.fail(label + ' did not throw'); } catch (e) { assert.match(String(e.message), re, label + ' :: ' + e.message); } };

// The state that precedes an App release: app_only, runtime pinned to the SERVED production runtime, with the AUTHENTIC record of the release that put it there
// (run 40055779147 — verified separately against GitHub in T641) and the Rules bundled with that runtime as `target_sha256`.
function appOnlyBefore() {
  const s = clone(CURRENT);
  s.release_mode = 'app_only'; s.release_status = 'READY'; delete s.rules_sha;
  s.rules_transition.target_sha256 = BA172;                                   // hash of firestore.rules AT b5f53af (what the deployed-product manifest proves)
  s.app_release = { runtime_sha: s.runtime_sha, deployment: s.production_deployment, promotion_model: 'staged_production', previous_deployment: s.rollback_deployment,
    previous_runtime_sha: s.rollback_runtime_sha, verified_surfaces: 25, source_release_run: '40055779147', completed_at: '2026-10-24T03:38:01Z' };
  return s;
}
const published = (over) => Object.assign({ sha256: FE151, rules_sha: HEAD, source_release_run: '123456789', completed_at: '2026-11-01T12:00:00Z' }, over || {});

test('T641.S1 the pre-release app_only state validates and is coherent; the bundled-runtime Rules hash is BA172 (what b5f53af carries), not the candidate FE151', () => {
  const s = appOnlyBefore();
  lib.validate(s, SCHEMA); check.assertAppReleaseCoherence(s);
  assert.equal(lib.hash(lib.git('show', s.runtime_sha + ':firestore.rules')), s.rules_transition.target_sha256, 'target is the hash of the Rules bundled with the pinned runtime');
  assert.equal(s.app_release.runtime_sha, s.runtime_sha); assert.equal(s.app_release.deployment, s.production_deployment);
  assert.equal(s.production_deployment, 'dpl_4wyBNxUCNAMYHy5KwuaZ7SnnsoEw', 'production deployment stays the real one');
  assert.equal(s.numeric_apply_enabled, false);
  throws(() => check.assertPublishedRulesCoherence(s) && lib.validate(Object.assign(clone(s), { published_rules: {} }), SCHEMA), /missing/, 'an empty published_rules is not a record');
});
test('T641.S2 after a Rules release the state can say FE151 is LIVE while BA172 stays the bundled-runtime hash: the two facts are separate and bound to evidence', () => {
  const s = appOnlyBefore(); s.published_rules = published();
  lib.validate(s, SCHEMA); check.assertAppReleaseCoherence(s); check.assertPublishedRulesCoherence(s);
  assert.notEqual(s.rules_transition.target_sha256, s.published_rules.sha256, 'bundled (BA172) and published (FE151) are different facts');
  assert.equal(s.rules_transition.rollback_sha256, BA172, 'the rollback Rules are untouched');
  assert.equal(lib.hash(lib.git('show', s.published_rules.rules_sha + ':firestore.rules')), s.published_rules.sha256, 'the hash is bound to the bytes of a reviewed commit');
});
test('T641.S3 published_rules is never inferred or fabricated: absent is valid; a rules_only package cannot carry it; malformed, extra or unbound values are rejected', () => {
  assert.doesNotThrow(() => check.assertPublishedRulesCoherence(CURRENT), 'the current rules_only package has none');
  const withRecord = Object.assign(clone(CURRENT), { published_rules: published() });
  throws(() => check.assertPublishedRulesCoherence(withRecord), /only valid for app_only/, 'rules_only + published_rules');
  const base = appOnlyBefore();
  for (const [label, rec, re] of [
    ['hash does not match the commit bytes', published({ sha256: BA172 }), /must be the hash of firestore\.rules/],
    ['bad instant', published({ completed_at: '2026-13-45T00:00:00Z' }), /real instant/], ['not UTC', published({ completed_at: '2026-11-01T12:00:00' }), /ISO-8601 UTC/],
    ['unknown commit', published({ rules_sha: 'a'.repeat(40) }), /./]]) {
    throws(() => check.assertPublishedRulesCoherence(Object.assign(clone(base), { published_rules: rec })), re, label);
  }
  for (const [label, rec] of [['extra property', Object.assign(published(), { note: 'x' })], ['short sha', published({ sha256: 'abc' })], ['run not digits', published({ source_release_run: 'run-1' })],
    ['commit not 40 hex', published({ rules_sha: 'abc' })], ['missing field', (() => { const p = published(); delete p.completed_at; return p; })()]]) {
    throws(() => lib.validate(Object.assign(clone(base), { published_rules: rec }), SCHEMA), /./, label);
  }
});
test('T641.S4 the transition keeps the app_only contract intact: the Rules-lane and App-lane guards still refuse each other\'s state, and T572 coherence still rejects a state that invents history', () => {
  const rulesOnly = CURRENT, appOnly = appOnlyBefore();
  throws(() => lib.assertReleaseMode(rulesOnly, 'app_only', 'Client App release lane'), /requires release_mode=app_only/, 'app lane refuses rules_only');
  throws(() => lib.assertReleaseMode(appOnly, 'rules_only', 'rules lane'), /requires release_mode=rules_only/, 'rules lane refuses app_only');
  for (const [label, mutate, re] of [
    ['app_release for another runtime', (s) => { s.app_release.runtime_sha = 'c'.repeat(40); }, /app_release\.runtime_sha must equal runtime_sha/],
    ['deployment is a Preview, not production', (s) => { s.app_release.deployment = 'dpl_PreviewNotProduction0001'; }, /app_release\.deployment must equal production_deployment/],
    ['invented run id', (s) => { s.app_release.source_release_run = 'abc'; }, /digits only/], ['invented instant', (s) => { s.app_release.completed_at = '2026-02-30T00:00:00Z'; }, /real instant|survive a round trip/],
    ['no app_release at all', (s) => { delete s.app_release; }, /requires app_release/]]) {
    const s = appOnlyBefore(); mutate(s); throws(() => check.assertAppReleaseCoherence(s), re, label);
  }
});
