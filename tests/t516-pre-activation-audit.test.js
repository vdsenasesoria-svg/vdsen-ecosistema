// T516: final PRE-ACTIVATION audit of the whole canonical chain. Expected end state:
//   legacy operational authority 0 | name-based mutation authority 0 | athlete prescription authority 0
//   canonical progression 1 | canonical application path 1 | real numeric application OFF
//   equipment identity as complete as the repository permits | increments only if explicitly authored
//   ready candidates possible (synthetic) | blockers explicit and localized
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const client = read('vdsen-cliente.html'), coach = read('vdsen-coach.html');
const code = f => strip(read(f));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));
const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));
const queue = require(path.join(root, 'scripts/equipment-readiness-report.cjs')).build();
const replay = require(path.join(root, 'scripts/replay-application-readiness.cjs')).replay();

test('T516.1 LEGACY OPERATIONAL AUTHORITY = 0: no legacy symbol can write, prefill, resize, retarget or recommend', () => {
  const removed = ['_progAutoApply', '_progRecStale', '_progCargaConv', '_progRepsApply', '_isFreshPidProgRec', '_buildSessionTargetBanner', '_maybeSuggestExtraSet', 'addExtraSetNow',
    'showExModModal', 'saveExMod', '_buildNextExposureHtml', 'headerRecHtml', 'addSetsBannerHtml', '_isFreeBarbell', 'Considera sustituir por'];
  for (const n of removed) assert.ok(!code('vdsen-cliente.html').includes(n), n);
  for (const n of ['_applyAllModuloD', '_applyRecLoadsToMonitor', '_buildRecApplyPreview', '_confirmApplyRecModal', '_resolveExerciseInFreshPlan', '_buildPlanChangeSummary'])
    assert.ok(!code('vdsen-coach.html').includes(n), n);
  assert.equal(client.split('_getProgRecForExercise(').length - 1, 1, 'legacy progrec adapter has no consumer');
  assert.ok(/id="_legacyProgEvidence"/.test(coach));
});

test('T516.2 NAME-BASED MUTATION AUTHORITY = 0: names are labels; identity is exact PID / exact ids', () => {
  for (const f of ['assets/progression-magnitude-policy.js', 'assets/progression-auto-apply-shadow.js', 'assets/progression-application-consumer.js', 'assets/progression-equipment-resolver.js', 'assets/equipment-context.js'])
    assert.ok(!/\b(toLowerCase|_normName|localeCompare)\b/.test(code(f).replace(/localeCompare/g, '')) || f === 'assets/equipment-context.js', f);
  assert.ok(!/toLowerCase|_normName/.test(code('assets/progression-application-consumer.js')));
  // client history: PID-first, name only when the exercise has no PID
  assert.ok(client.includes('if (pidKey) return EXERCISE_HISTORY[pidKey] || {};'));
  assert.ok(coach.includes('return pidCount === 1 ? foundByPid : null;'));
  // equipment refs are built from the exact exerciseId, never from an exercise name
  const eq = read('assets/equipment-context.js');
  assert.ok(/e\.exerciseId === exerciseId/.test(eq) && !/exerciseName/.test(strip(eq)));
  // plan comparison / validation helpers that use names are read-only diagnostics
  const f26 = coach.slice(coach.indexOf('function _resolveMatchF26'), coach.indexOf('window._resolveMatchF26'));
  assert.ok(!/updateDoc|setDoc|addDoc/.test(f26));
});

test('T516.3 ATHLETE PRESCRIPTION AUTHORITY = 0: the athlete authors execution only', () => {
  const c = code('vdsen-cliente.html');
  assert.ok(!c.includes('exmod_'));
  assert.ok(!/(updateDoc|setDoc|addDoc)\([^;]*['"]plans['"]/.test(c));
  assert.ok(client.includes('substitutedFrom') && client.includes('rirDefaulted'));
  assert.ok(/function getAdjustedRIR\(baseRIR, week, exName\) \{\s*var base = parseInt\(baseRIR\);\s*return isFinite\(base\) \? base : 2;\s*\}/.test(client));
});

test('T516.4 CANONICAL PROGRESSION = 1 and CANONICAL APPLICATION PATH = 1', () => {
  assert.equal(code('assets/progression-application-consumer.js').split('tx.set(').length - 1, 2, 'one canonical (overlay/lifecycle) writer + one athlete receipt writer');
  for (const f of ['vdsen-cliente.html', 'vdsen-coach.html', 'assets/progression-auto-apply-shadow.js', 'assets/progression-magnitude-policy.js'])
    assert.ok(!/nextExposureOverlays\s*:/.test(read(f)), f + ' never writes overlays');
  assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
  assert.ok(typeof policy.evaluate === 'function' && typeof shadow.buildRecord === 'function');
  assert.ok(!coach.includes('applyOverlayTransaction'), 'the Coach only plans (dry-run); it never calls the transaction');
});

test('T516.5 REAL NUMERIC APPLICATION = OFF everywhere; no APPLIED state', () => {
  assert.deepEqual([shadow.NUMERIC_APPLY_ENABLED, policy.NUMERIC_APPLY_ENABLED, consumer.NUMERIC_APPLY_ENABLED], [false, false, false]);
  assert.equal(shadow.lifecycleTransition({ state: 'PENDING', revision: 1, events: [] }, 'APPLIED', { expectedRevision: 1, operationKey: 'x', at: 't' }).reasonCode, 'NUMERIC_APPLY_DISABLED');
  assert.equal(read('assets/progression-application-consumer.js').split('var NUMERIC_APPLY_ENABLED = false;').length - 1, 1);
  for (const r of replay.rows) assert.notEqual(r.state, 'EXECUTABLE', r.name);
});

test('T516.6 EQUIPMENT IDENTITY is as complete as the repository permits; every unresolved item has a documented reason', () => {
  const resolved = queue.filter(r => r.identityStatus !== 'UNRESOLVED'), unresolved = queue.filter(r => r.identityStatus === 'UNRESOLVED');
  assert.deepEqual([resolved.length, unresolved.length], [39, 2]);
  const g = catalog.gyms['smart-fit-san-diego'], all = g.entries.concat(g.legacyEntries);
  assert.equal(all.length - unresolved.reduce((n, r) => n + r.exerciseCount, 0), 69, 'exercises with a canonical equipment identity');
  for (const r of unresolved) assert.ok(['GENERIC_LABEL', 'ATTACHMENT_NOT_LOAD_IMPLEMENT'].includes(r.identityReason), r.name);
});

test('T516.7 EQUIPMENT INCREMENTS: only explicitly authored values exist (none shipped); unknown stays unresolved', () => {
  assert.deepEqual(Object.keys(resolver.INCREMENT_METADATA), []);
  assert.ok(!/loadIncrement|smallestPlate|barWeight/.test(read('assets/exercise-visual-catalog.js')));
  assert.equal(queue.filter(r => r.incrementState === 'CONFIGURED').length, 0);
  assert.equal(queue.filter(r => r.status === 'READY').length, 0);
  const src = code('assets/equipment-context.js') + code('assets/progression-equipment-resolver.js');
  assert.ok(!/(equipmentType|type)\s*===?\s*['"](machine|barbell|free_weight|cable)/.test(src), 'no per-type increments');
  assert.ok(/source: 'COACH_CONFIGURED'|meta\.source = 'COACH_CONFIGURED'/.test(code('assets/progression-equipment-resolver.js')));
});

test('T516.8 READY candidates are possible (synthetic) and BLOCKERS are explicit and localized', () => {
  const s = replay.summary;
  assert.ok(s.readyButDisabled >= 2 && s.executable === 0);
  assert.ok(!('NOT_ELIGIBLE' in s.blockersByReason));
  const by = Object.fromEntries(replay.rows.map(r => [r.name, r]));
  assert.deepEqual(by['C rest ready, first occurrence (independent of equipment)'].blockers, [], 'Rule C is not blocked by equipment or science');
  assert.deepEqual(by['A-load ready (synthetic shared step)'].blockers, []);
  for (const r of replay.rows.filter(x => x.scienceGaps.length)) assert.ok(/D\/E|D branch/.test(r.name), 'science blocks only D/E branches: ' + r.name);
  const labelled = coach.slice(coach.indexOf('function _dryRunLine'), coach.indexOf('function _renderShadowAutoFeed'));
  for (const c of Object.values(consumer.BLOCKERS).filter(c => !['STALE_CALLBACK', 'REVISION_CONFLICT', 'NOT_CANONICAL_RECORD'].includes(c))) assert.ok(new RegExp('\\b' + c + ':').test(labelled), c);
});

test('T516.9 the activation guard has 19 checks and the pre-activation documents are current', () => {
  assert.equal(consumer.GUARD_CHECKS.length, 19);
  const { spawnSync } = require('node:child_process');
  for (const s of ['equipment-increment-inventory.cjs', 'equipment-readiness-report.cjs', 'replay-application-readiness.cjs'])
    assert.equal(spawnSync(process.execPath, [path.join(root, 'scripts', s), '--check']).status, 0, s);
  const doc = read('docs/PROGRESSION_AUTHORITY.md');
  for (const t of ['Estado pre-activación', 'Guardia de activación', 'Matriz de autoridad final', 'READY_BUT_DISABLED']) assert.ok(doc.includes(t), t);
});
