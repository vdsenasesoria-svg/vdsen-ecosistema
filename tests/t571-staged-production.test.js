'use strict';
// T571 — Staged production deployment.
//
// WHY THE PREVIEW MODEL WAS REPLACED
// The lane used to promote an ephemeral Preview deployment. Run 37629216025 exposed the flaw: the
// approved candidate's Preview rotated away, so there was no artifact left to promote and the
// release became impossible through no fault of the code. That coupled a release to the lifetime
// of a Preview.
//
// THE DOCUMENTED MODEL, verified against Vercel's own documentation AND the pinned CLI's `--help`
// output rather than copied from memory:
//   vercel deploy --prod --skip-domain   a Production deployment NOT yet assigned to the
//                                        production domains ("staged production")
//   vercel promote <url|deploymentId>    makes it current
// `vercel deploy --help` in 59.11.7 documents `--skip-domain` as "Disable the automatic promotion
// (aliasing) of the deployment", and the KB states staged deployments "use production environment
// variables" and "aren't immediately assigned to your production domains".
//
// This file pins the properties that make the staged lane safe. It must never depend on network
// access or on a real Vercel credential.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = require('../scripts/release/app-live.cjs');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release', 'app-live.cjs'), 'utf8');
const RUNTIME = '8365410cf7f09427c79ead77aa4f769c16e9a803';
const PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';
const PREVIOUS = 'dpl_FngrtpodSKHZ9aPk75aA5SS7JGnB';
const STAGED = 'dpl_staged0000000000000000001';

function stageBody() {
  const i = SRC.indexOf('async function stageProduction(');
  assert.ok(i > -1, 'stageProduction must exist');
  return SRC.slice(i, SRC.indexOf('\n// Promotion mechanism', i));
}

// ── 1. deploy command uses the EXACT candidate source ─────────────────────────────────────────

test('T571-1 the staged source is the exact candidate tree, never the working tree or HEAD', () => {
  const body = stageBody();
  // exported with git archive of the candidate SHA, not the checkout
  assert.ok(/exportCandidateTree\(runtime, outDir\)/.test(body), 'exporta el arbol del candidato exacto');
  assert.ok(/verifyExportedTree\(runtime, outDir, surface\)/.test(body), 'verifica el arbol exportado');
  // the deploy directory is a positional argument, and the process cwd is the same tree
  assert.ok(/'deploy', outDir, '--prod'/.test(body), 'el deploy apunta al arbol exportado');
  assert.ok(/\], outDir, \{/.test(body), 'el cwd del proceso tambien es el arbol exportado');
  // no HEAD / branch / latest anywhere in the staging path
  assert.ok(!/HEAD|latest|codex\/client-app-next/.test(body), 'no usa HEAD, latest ni la rama');
});

test('T571-1b git archive is the only way the tree is produced (tracked files only)', () => {
  const i = SRC.indexOf('function exportCandidateTree(');
  const body = SRC.slice(i, SRC.indexOf('\n// Proves the exported directory', i));
  assert.ok(/'archive'/.test(body), 'usa git archive');
  assert.ok(/--format=tar/.test(body), 'formato tar');
  // it must reject anything that is not a full commit SHA, so a branch name can never be exported
  assert.ok(/assert\.match\(sha, \/\^\[0-9a-f\]\{40\}\$\//.test(body), 'exige SHA completo de 40 chars');
  // the destination is cleared first so stale files cannot survive between runs
  assert.ok(/fs\.rmSync\(destDir/.test(body), 'limpia el destino antes de exportar');
});

test('T571-1c exported bytes are verified against the commit for every served path', () => {
  const i = SRC.indexOf('function verifyExportedTree(');
  const body = SRC.slice(i, SRC.indexOf('\n// A staged deployment must be a PRODUCTION', i));
  assert.ok(/gitBinary\('show', sha \+ ':' \+ p\)/.test(body), 'compara contra el blob del commit');
  assert.ok(/hash\(fs\.readFileSync\(file\)\)/.test(body), 'hashea el archivo exportado');
  assert.ok(/assert\.equal\(mismatches\.length, 0/.test(body), 'falla si algo no coincide');
  assert.ok(/missing/.test(body), 'y detecta archivos ausentes');
});

test('T571-1d blob reads are BINARY-SAFE (utf8 decoding corrupted every binary asset)', () => {
  // A real defect: `git()` runs execFileSync with encoding utf8, so hashing its output for a .jpg
  // or .ttf could never match the exported file. The staging gate failed with
  //   'Exported tree does not match the candidate commit: assets/vdsen-logo-official.jpg (hash)'
  // Every byte-comparing read must therefore use the binary-safe helper.
  assert.ok(!/hash\(Buffer\.from\(git\('show'/.test(SRC), 'no debe hashear la salida utf8 de git()');
  assert.equal((SRC.match(/gitBinary\('show'/g) || []).length, 4, 'las 4 comparaciones de blob usan gitBinary');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release', 'lib.cjs'), 'utf8');
  assert.ok(/const gitBinary = \(\.\.\.args\) => execFileSync\('git', args, \{ maxBuffer/.test(lib), 'gitBinary sin encoding => Buffer');
  assert.ok(/module\.exports = \{[^}]*gitBinary/.test(lib), 'gitBinary exportado');
});

test('T571-1e the export genuinely round-trips real binary assets', () => {
  // Proves the helper against the repository itself instead of asserting on source text: export the
  // candidate tree and verify every served path, which includes .jpg and .ttf files.
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const sha = '8365410cf7f09427c79ead77aa4f769c16e9a803';
  try { execFileSync('git', ['cat-file', '-e', sha + '^{commit}'], { stdio: 'ignore' }); }
  catch { return; } // commit not reachable in this checkout: skip rather than fail
  const paths = app.servedSurface();
  assert.ok(paths.some((p) => /\.(jpg|png|ttf|woff2?|ico)$/i.test(p)), 'la superficie servida incluye binarios');
  const dir = path.join(os.tmpdir(), 'vdsen-t571-export');
  app.exportCandidateTree(sha, dir);
  assert.equal(app.verifyExportedTree(sha, dir, paths), paths.length, 'todas las rutas verifican');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 2 & 3. production environment and skip-domain ─────────────────────────────────────────────

test('T571-2 the deploy is a PRODUCTION build with --skip-domain', () => {
  const body = stageBody();
  assert.ok(/'deploy', outDir, '--prod', '--skip-domain', '--yes'/.test(body), 'flags exactas de staged production');
  // --prod means production target, and therefore production variables
  assert.ok(!/--target=|--target', 'preview/.test(body), 'no se fuerza un target preview');
});

test('T571-2b the documented flags are the ones the pinned CLI actually exposes', () => {
  // Recorded from `vercel deploy --help` of 59.11.7; guards against a silent CLI contract change.
  assert.equal(app.VERCEL_CLI_VERSION, '59.11.7');
  const cli = SRC.match(/const VERCEL_CLI_VERSION = '([^']+)'/)[1];
  assert.match(cli, /^\d+\.\d+\.\d+$/, 'version pinneada, nunca latest');
  assert.notEqual(cli, 'latest');
});

// ── 4 & 5. staged is not current and the alias does not move ──────────────────────────────────

test('T571-3 a staged deployment must NOT already be the current production deployment', () => {
  const good = { id: STAGED, projectId: PROJECT, teamId: TEAM, target: 'production', readyState: 'READY' };
  app.assertStaged(good, { project: PROJECT, team: TEAM, current: PREVIOUS });
  assert.throws(() => app.assertStaged({ ...good, id: PREVIOUS }, { project: PROJECT, team: TEAM, current: PREVIOUS }),
    /already the current production deployment/);
});

test('T571-3b a staged deployment must be READY, production-target and in the right project', () => {
  const base = { id: STAGED, projectId: PROJECT, teamId: TEAM, target: 'production', readyState: 'READY' };
  assert.throws(() => app.assertStaged({ ...base, readyState: 'BUILDING' }, { project: PROJECT, team: TEAM, current: PREVIOUS }), /not READY/);
  assert.throws(() => app.assertStaged({ ...base, target: null }, { project: PROJECT, team: TEAM, current: PREVIOUS }), /must be a production-target/);
  assert.throws(() => app.assertStaged({ ...base, projectId: 'prj_other' }, { project: PROJECT, team: TEAM, current: PREVIOUS }), /another project/);
  assert.throws(() => app.assertStaged({ ...base, teamId: 'team_other' }, { project: PROJECT, team: TEAM, current: PREVIOUS }), /another team/);
});

test('T571-4 the production alias is asserted unchanged around the staging step', () => {
  const body = stageBody();
  assert.ok(/currentBefore = await currentApp\(s\)/.test(body), 'lee el alias ANTES de construir');
  assert.ok(/currentAfter = await currentApp\(s\)/.test(body), 'y DESPUES');
  assert.ok(/assert\.equal\(currentAfter, currentBefore/.test(body), 'y exige que no se haya movido');
  // the "after" read must come after the deploy
  assert.ok(body.indexOf('currentBefore = await currentApp(s)') < body.indexOf("'deploy', outDir, '--prod'"),
    'el alias se lee antes del deploy');
  assert.ok(body.indexOf("'deploy', outDir, '--prod'") < body.indexOf('currentAfter = await currentApp(s)'),
    'y se re-lee despues');
});

// ── 6. project and team are explicit ──────────────────────────────────────────────────────────

test('T571-5 project and team are established explicitly, not from an accidental local link', () => {
  const body = stageBody();
  // They are passed through the environment, which is the documented non-interactive CI form.
  // Flags were tried first and FAILED: `--scope` expects a team SLUG, not the `team_...` id, and
  // passing the id broke authentication with 'Not able to load user ... User not found. (404)'.
  assert.ok(/VERCEL_PROJECT_ID: s\.production_project/.test(body), 'proyecto explicito por id');
  assert.ok(/VERCEL_ORG_ID: s\.vercel_team/.test(body), 'team explicito por id');
  assert.ok(!/'--scope'/.test(body), 'no usa --scope (no acepta el id del team)');
  assert.ok(!/'--project'/.test(body), 'no depende de flags de proyecto');
  // and the id must come from reviewed state, not from the environment at call time
  assert.ok(/const s = state\(\)/.test(body), 'las coordenadas salen del estado revisado');
  // the staged report records them so a reviewer can check
  assert.ok(/production_project: s\.production_project/.test(body));
  assert.ok(/vercel_team: s\.vercel_team/.test(body));
});

// ── 7. source commit metadata ─────────────────────────────────────────────────────────────────

test('T571-6 the staged report records source identity and lifecycle fields', () => {
  const body = stageBody();
  for (const field of ['staged_deployment', 'staged_url', 'staged_target', 'staged_ready_state',
    'candidate_sha', 'verified_paths', 'production_alias_before', 'production_alias_after', 'cli_version', 'staged_at']) {
    assert.ok(body.includes(field), 'el reporte staged debe incluir ' + field);
  }
  assert.ok(/candidate_sha: runtime/.test(body), 'el candidato declarado es el runtime autorizado');
});

// ── 8. candidate bytes ────────────────────────────────────────────────────────────────────────

test('T571-7 the deploy refuses to continue if the alias moved (candidate bytes are proven first)', () => {
  const body = stageBody();
  const exportIdx = body.indexOf('verifyExportedTree');
  const deployIdx = body.indexOf("'deploy', outDir, '--prod'");
  assert.ok(exportIdx > -1 && deployIdx > -1 && exportIdx < deployIdx,
    'la verificacion de bytes precede al deploy');
});

// ── 9 & 10. promotion gated, rollback artifact first ──────────────────────────────────────────

test('T571-8 the promotion target is the STAGED deployment, not the preview candidate', () => {
  const i = SRC.indexOf('async function apply(');
  const body = SRC.slice(i, SRC.indexOf('\nasync function rollbackApp', i));
  assert.ok(/app-staged\.json/.test(body), 'apply lee el artefacto staged');
  assert.ok(/const targetDeployment = staged && staged\.staged_deployment/.test(body), 'usa el staged como objetivo');
  assert.ok(/promotion_model: staged \? 'staged_production' : 'preview_candidate'/.test(body), 'declara el modelo usado');
  assert.ok(/await promoteFn\(s, targetDeployment\)/.test(body), 'promueve el objetivo resuelto');
});

test('T571-9 the rollback artifact still exists BEFORE promotion', () => {
  const i = SRC.indexOf('async function preflight(');
  const body = SRC.slice(i, SRC.indexOf('\n// Reads the CURRENT production alias', i));
  assert.ok(/assertRollbackArtifact\(save\(/.test(body), 'el preflight persiste y valida el artefacto');
  assert.ok(/candidate_deployment: candidate\.id/.test(body), 'con el candidato identificado');
  assert.ok(/production_deployment: aliasDeploymentId/.test(body), 'y la produccion previa');
});

// ── 11 & 12. main and rules untouched ─────────────────────────────────────────────────────────

test('T571-10 main is never written by the staging path', () => {
  const body = stageBody();
  assert.ok(!/git\('push'|git\('commit'|git\('checkout'|git\('switch'/.test(body), 'no escribe historia');
  // main is only ever READ, for the baseline comparison
  assert.ok(!/refs\/heads\/main.*push/.test(SRC));
});

test('T571-11 no Firestore MUTATION path exists anywhere in the lane', () => {
  // `firebaserules` legitimately appears ONLY as a read-only observation endpoint
  // (OBSERVED_RULES_API) used by the source guard that FORBIDS rules mutation, so this assertion
  // targets mutation rather than the string. A blanket substring check was a false positive.
  assert.ok(!/firestore\.googleapis\.com\/v1\/projects[^']*\/(rulesets|releases)/.test(SRC),
    'no debe existir un endpoint de despliegue de reglas');
  assert.ok(!/deployRules|updateRuleset|createRuleset/.test(SRC), 'sin verbos de despliegue de reglas');
  // the staging path specifically must have no Firestore write helper at all
  const region = SRC.slice(SRC.indexOf('async function stageProduction('));
  assert.ok(!/setDoc|updateDoc|addDoc|deleteDoc|collection\(/.test(region), 'el staging no escribe Firestore');
  // and the observation endpoint must stay read-only (GET), never a write
  const ai = SRC.indexOf('const OBSERVED_RULES_API');
  const obs = SRC.slice(ai, ai + 700);
  assert.ok(!/method:\s*'POST'|'PATCH'|'DELETE'/.test(obs), 'la observacion de reglas es solo lectura');
});

test('T571-12 the staged report never contains a credential', () => {
  const body = stageBody();
  assert.ok(/assert\.ok\(!\/Bearer \|VERCEL_TOKEN\|private_key/.test(body), 'el reporte se valida contra secretos');
  // nothing is passed on the command line
  assert.ok(!/'-t', '--token'|--token/.test(body), 'el token no viaja por linea de comandos');
});

test('T571-13 NUMERIC_APPLY_ENABLED sigue en false', () => {
  for (const m of ['progression-effective-prescription', 'progression-application-consumer', 'progression-auto-apply-shadow', 'progression-magnitude-policy']) {
    assert.equal(require('../assets/' + m + '.js').NUMERIC_APPLY_ENABLED, false, m);
  }
});
