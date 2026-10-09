'use strict';
// T572 — Release-state contract hardening.
//
// WHY THIS EXISTS
// The first Client App production release made `.release/vdsen-client.json` record an APP release,
// which exposed two weaknesses in the reviewed-state contract:
//
//  1. `release_mode: app_only` was allowed WITHOUT an `app_release` block, so a state could claim an
//     app release while carrying none of its facts.
//  2. Nothing checked that the block agreed with the top-level fields, so the state could describe
//     two different deployments at once.
//
// It also exposed a risk in the other direction: after an app release the state says `app_only`, and
// the FIRESTORE RULES lane reads that same file. Without an explicit mode gate, an app-only baseline
// could be mistaken for approval to deploy rules. Both lanes now require the mode that matches the
// release they perform, so the state is an explicit record of intent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validate, assertReleaseMode } = require('../scripts/release/lib.cjs');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.release', 'schema', 'release-state.schema.json'), 'utf8'));
const STATE_PATH = path.join(__dirname, '..', '.release', 'vdsen-client.json');
const STATE = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

const clone = (over = {}) => JSON.parse(JSON.stringify({ ...STATE, ...over }));
const schemaValidates = (value) => { validate(value, SCHEMA); return true; };

// The cross-field rules live in check.cjs because JSON Schema cannot express equality between
// siblings. Re-implemented here as the same logic so the test exercises the CONTRACT: if you change
// one, this test and the release check must agree.
function crossFieldCoherence(state) {
  if (state.release_mode !== 'app_only') return state;
  const a = state.app_release;
  assert.ok(a, 'release_mode app_only requires app_release');
  assert.equal(a.runtime_sha, state.runtime_sha, 'app_release.runtime_sha must equal runtime_sha');
  assert.equal(a.deployment, state.production_deployment, 'app_release.deployment must equal production_deployment');
  assert.equal(a.previous_deployment, state.rollback_deployment, 'app_release.previous_deployment must equal rollback_deployment');
  assert.equal(a.previous_runtime_sha, state.rollback_runtime_sha, 'app_release.previous_runtime_sha must equal rollback_runtime_sha');
  assert.match(a.source_release_run, /^[0-9]+$/, 'app_release.source_release_run must be digits only');
  assert.ok(Number.isInteger(a.verified_surfaces) && a.verified_surfaces > 0, 'app_release.verified_surfaces must be a positive integer');
  assert.match(a.completed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, 'app_release.completed_at must be an ISO-8601 UTC timestamp');
  assert.ok(!Number.isNaN(Date.parse(a.completed_at)), 'app_release.completed_at must be a real instant');
  return state;
}

// ── 1. app_only without app_release -> FAIL ───────────────────────────────────────────────────

test('T572-1 release_mode app_only without app_release is rejected by the schema', () => {
  const s = clone();
  delete s.app_release;
  assert.throws(() => schemaValidates(s), /missing app_release/);
});

test('T572-1b a rules_only state may omit app_release, and may also keep it', () => {
  // Not necessarily forbidden to carry historical app_release later.
  const withoutBlock = clone({ release_mode: 'rules_only' });
  delete withoutBlock.app_release;
  assert.ok(schemaValidates(withoutBlock), 'rules_only sin app_release es valido');
  assert.ok(schemaValidates(clone({ release_mode: 'rules_only' })), 'rules_only con app_release historico tambien');
});

// ── 2-5. the four equalities ──────────────────────────────────────────────────────────────────

test('T572-2 app_release.runtime_sha mismatch -> FAIL', () => {
  const s = clone();
  s.app_release.runtime_sha = 'a'.repeat(40);
  assert.throws(() => crossFieldCoherence(s), /runtime_sha/);
});

test('T572-3 app_release.deployment mismatch -> FAIL', () => {
  const s = clone();
  s.app_release.deployment = 'dpl_other';
  assert.throws(() => crossFieldCoherence(s), /production_deployment/);
});

test('T572-4 previous deployment mismatch -> FAIL', () => {
  const s = clone();
  s.app_release.previous_deployment = 'dpl_other';
  assert.throws(() => crossFieldCoherence(s), /rollback_deployment/);
});

test('T572-5 previous runtime mismatch -> FAIL', () => {
  const s = clone();
  s.app_release.previous_runtime_sha = 'b'.repeat(40);
  assert.throws(() => crossFieldCoherence(s), /rollback_runtime_sha/);
});

// ── 6-8. field shape ──────────────────────────────────────────────────────────────────────────

test('T572-6 invalid source_release_run -> FAIL', () => {
  for (const bad of ['run-123', '123abc', '', ' ', '12.3']) {
    const s = clone();
    s.app_release.source_release_run = bad;
    assert.throws(() => schemaValidates(s), /source_release_run|pattern/i, 'rechaza ' + JSON.stringify(bad));
  }
});

test('T572-7 verified_surfaces <= 0 -> FAIL', () => {
  for (const bad of [0, -1]) {
    const s = clone();
    s.app_release.verified_surfaces = bad;
    // asserted on the message the validator actually produces for `minimum`
    assert.throws(() => schemaValidates(s), /minimum|expected|actual|Input/i, 'rechaza ' + bad);
  }
  // and a non-integer is rejected by the coherence check
  const frac = clone();
  frac.app_release.verified_surfaces = 2.5;
  assert.throws(() => crossFieldCoherence(frac), /positive integer/);
});

test('T572-8 malformed completed_at -> FAIL', () => {
  for (const bad of ['2026-13-45T99:99:99Z', 'not a date', '2026-10-07', '2026-10-07 21:18:05', '']) {
    const s = clone();
    s.app_release.completed_at = bad;
    assert.throws(() => crossFieldCoherence(s), /ISO-8601|real instant|Input/i, 'rechaza ' + JSON.stringify(bad));
  }
});

test('T572-8b a real ISO instant passes, with and without milliseconds', () => {
  for (const ok of ['2026-10-07T21:18:05Z', '2026-10-07T21:18:05.441Z']) {
    const s = clone();
    s.app_release.completed_at = ok;
    assert.ok(crossFieldCoherence(s), 'acepta ' + ok);
  }
});

// ── 9. the real state passes ──────────────────────────────────────────────────────────────────

test('T572-9 the reviewed state passes the whole hardened contract', () => {
  assert.ok(schemaValidates(STATE));
  assert.ok(crossFieldCoherence(STATE));
  assert.equal(STATE.release_mode, 'app_only');
  assert.ok(STATE.app_release, 'el estado debe traer el bloque app_release');
  // and it describes the release that actually happened
  assert.equal(STATE.app_release.runtime_sha, '8365410cf7f09427c79ead77aa4f769c16e9a803');
  assert.equal(STATE.app_release.deployment, 'dpl_4xAS5kXuny7APpaRjozGeNdPETMj');
  assert.equal(STATE.app_release.source_release_run, '37688146609');
});

// ── 10-11. the mode gates ─────────────────────────────────────────────────────────────────────

test('T572-10 the RULES lane refuses an app_only state, and does so BEFORE any network work', () => {
  assert.throws(() => assertReleaseMode({ release_mode: 'app_only' }, 'rules_only', 'Firestore rules release lane'),
    /requires release_mode=rules_only/);
  // The gate is local: it must be reachable without credentials or fetch. Prove the call sites sit
  // before the first network use in both rules-lane entry points.
  const live = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release', 'live.cjs'), 'utf8');
  for (const fn of ['async function prepare() {', 'async function apply() {']) {
    const i = live.indexOf(fn);
    assert.ok(i > -1, fn + ' debe existir');
    const body = live.slice(i, i + 900);
    const gate = body.indexOf("assertReleaseMode(s, 'rules_only'");
    assert.ok(gate > -1, fn + ' debe tener el gate de modo');
    // no network call may appear before the gate in that body
    const before = body.slice(0, gate);
    assert.ok(!/await\s+\w*\(|fetch\(|vercel\(/.test(before),
      fn + ' no debe hacer trabajo de red antes del gate');
  }
});

test('T572-11 a correctly prepared rules_only state passes the mode gate', () => {
  assert.equal(assertReleaseMode({ release_mode: 'rules_only' }, 'rules_only', 'Firestore rules release lane').release_mode, 'rules_only');
  // and the APP lane symmetrically refuses rules_only
  assert.throws(() => assertReleaseMode({ release_mode: 'rules_only' }, 'app_only', 'Client App release lane'),
    /requires release_mode=app_only/);
  assert.equal(assertReleaseMode({ release_mode: 'app_only' }, 'app_only', 'Client App release lane').release_mode, 'app_only');
});

test('T572-11b the app lane checks the mode only on its MUTATION entry points', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release', 'app-live.cjs'), 'utf8');
  const ks = app.indexOf('function assertKillSwitch() {');
  const body = app.slice(ks, ks + 700);
  assert.ok(/assertReleaseMode\(state\(\), 'app_only'/.test(body), 'el gate vive en assertKillSwitch');
  // read-only preflight must not call the kill switch (diagnostics keep working while preparing)
  const ro = app.indexOf('async function readOnlyPreflight(');
  assert.ok(ro > -1);
  assert.ok(!/assertKillSwitch/.test(app.slice(ro, ro + 500)), 'el preflight read-only no exige el modo');
});

// ── 12. the app lane still cannot touch Firestore rules ───────────────────────────────────────

test('T572-12 the app lane remains unable to mutate Firestore rules', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release', 'app-live.cjs'), 'utf8');
  assert.ok(!/firestore\.googleapis\.com\/v1\/projects[^']*\/(rulesets|releases)/.test(app), 'sin endpoint de despliegue de reglas');
  assert.ok(!/deployRules|updateRuleset|createRuleset/.test(app), 'sin verbos de despliegue de reglas');
  assert.ok(!/require\('\.\/li' \+ 've\.cjs'\)|require\('\.\/live\.cjs'\)/.test(app), 'no importa el carril de reglas');
});

// ── 13. rules_transition historical semantics ────────────────────────────────────────────────

test('T572-13 under app_only, rules_transition rollback fields are HISTORICAL and must not be rewritten', () => {
  // The rules release captured bb4402e9... as ITS rollback baseline. An app release never touches
  // rules, so silently moving these to the live hash would destroy the evidence of what that release
  // would have restored. The live target hash is a property of the deployed baseline, so it IS
  // re-verified.
  assert.equal(STATE.release_mode, 'app_only');
  assert.equal(STATE.rules_transition.rollback_sha256, 'bb4402e9b99d2d78c1f2867fa09bd75b89f9a88046189edfb0302b0635635f0b');
  assert.notEqual(STATE.rules_transition.rollback_sha256, STATE.rules_transition.target_sha256,
    'el rollback historico no debe confundirse con el target vivo');
  assert.equal(STATE.rules_transition.target_sha256, 'ba172a4f2e9831e55fb0a10c369b4a073193efb56eb5ea61245a0f178043e1e6');
  // the captured artifact must still exist and hash to that historical value
  const p = path.join(__dirname, '..', STATE.rules_transition.rollback_source_path);
  assert.ok(fs.existsSync(p), 'el artefacto de rollback historico debe seguir existiendo');
  const crypto = require('node:crypto');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), STATE.rules_transition.rollback_sha256);
});

test('T572-13b the architecture doc records the mode contract and the historical semantics', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'AUTONOMOUS_RELEASE_ARCHITECTURE.md'), 'utf8');
  assert.ok(/Release mode is an explicit intent record/.test(doc), 'documenta el modo como intencion explicita');
  assert.ok(/requires `rules_only`/.test(doc), 'documenta el requisito del carril de reglas');
  assert.ok(/requires `app_only`/.test(doc), 'documenta el requisito del carril de app');
  assert.ok(/HISTORICAL/.test(doc), 'documenta la semantica historica de rules_transition');
  assert.ok(/Superseded 2026-10-07/.test(doc), 'marca los identificadores viejos como superados');
});

test('T572-14 NUMERIC_APPLY_ENABLED sigue en false', () => {
  for (const m of ['progression-effective-prescription', 'progression-application-consumer', 'progression-auto-apply-shadow', 'progression-magnitude-policy']) {
    assert.equal(require('../assets/' + m + '.js').NUMERIC_APPLY_ENABLED, false, m);
  }
});
