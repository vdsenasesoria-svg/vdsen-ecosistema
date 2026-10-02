// T537: unit-level guards for the Firestore canonical write boundary (the rules themselves are proven by tests/t536-rules-security.cjs on the emulator).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const { functionSource } = require('./helpers/coach-materializer.js');
const rules = read('firestore.rules'), client = read('vdsen-cliente.html'), coach = read('vdsen-coach.html'), sw = read('sw.js');

const CANONICAL = ['progressionApplications', 'nextExposureOverlays', 'progressionApplicationSummary'];

test('T537.1 the canonical key list in firestore.rules is exactly what the lifecycle code writes (no drift)', () => {
  const m = /function canonicalKeys\(\) \{\s*return \[([^\]]*)\];/.exec(rules);
  assert.ok(m, 'canonicalKeys() present');
  assert.deepEqual(m[1].split(',').map(x => x.trim().replace(/'/g, '')), CANONICAL);
  const commit = /function _commitLifecycle\(tx, refs, w\) \{([\s\S]*?)\n  \}/.exec(strip(read('assets/progression-application-consumer.js')))[1];
  for (const k of CANONICAL) assert.ok(commit.includes(k), k);
  const written = new Set(); commit.replace(/\b(progression\w+|nextExposure\w+)\s*:/g, (_, k) => written.add(k));
  assert.deepEqual([...written].sort(), CANONICAL.slice().sort());
});

test('T537.2 the athlete-owned execution fields never intersect the canonical keys; the athlete save payload is execution-only', () => {
  const save = functionSource(client, '_doSaveLogs');
  const m = /const _payload = \{([^}]*)\};/.exec(save);
  const keys = m[1].split(',').map(x => x.split(':')[0].trim());
  assert.deepEqual(keys.sort(), ['currentWeek', 'entries', 'exerciseHistory', 'exerciseUnits', 'planId', 'updatedAt']);
  for (const k of CANONICAL) assert.ok(!keys.includes(k));
  assert.ok(/mergeFields: _ownedFields/.test(save));
});

test('T537.3 the athlete app has NO canonical writer: no record creation, no queue, no overlay/summary payload; only the receipt path writes into the lifecycle area', () => {
  const c = strip(client);
  for (const name of ['_recordShadowProgression', '_queueShadowProgression', '_drainShadowProgression', '_readShadowQueue', '_writeShadowQueue']) assert.ok(!c.includes(name + '('), name);
  for (const k of CANONICAL) assert.ok(!new RegExp(k + '\\s*:').test(c), 'client never writes ' + k);
  assert.ok(!/lifecycleTransition|buildRecord|materializeRecords|markStale/.test(c));
  assert.ok(/recordConsumptionReceiptTransaction/.test(c));
  const cons = strip(read('assets/progression-application-consumer.js'));
  assert.ok(/function _commitReceipt\(tx, refs, payload\) \{ tx\.set\(refs\.meso, payload, \{ merge: true \}\); \}/.test(cons));
  const fn = /async function recordConsumptionReceiptTransaction[\s\S]*?\n  \}\n/.exec(cons)[0];
  assert.ok(/payload\.consumptionReceipts\[r\.key\] = receipt/.test(fn) && !/_commitLifecycle|progressionApplications\s*:/.test(fn), 'the receipt payload is the only thing the athlete path builds');
});

test('T537.4 PENDING records have exactly one writer: the owner-Coach materializer (guards: coach ownership, active plan, client identity, no LOG rewrite, no plan write)', () => {
  const body = functionSource(coach, '_materializeShadowRecords');
  assert.ok(/clientData\.coachId !== actorId/.test(body) && /clientData\.activePlanId !== planId/.test(body) && /_detailClientId !== clientId/.test(body));
  assert.ok(!/entries\s*:/.test(body.replace(/entries: auth\.entries \|\| \{\}/, '')) && !/tx\.set\(planRef|tx\.update\(/.test(body));
  const allCoachWriters = coach.match(/buildRecord\(|materializeRecords\(/g) || [];
  assert.equal(allCoachWriters.length, 1, 'materializeRecords is called once, from the materializer');
});

test('T537.5 shadow.materializeRecords: creates PENDING from persisted evidence, idempotent, stales an exposure that started, supersedes an older PENDING, rejects key collisions', () => {
  const PID = 'pid-A', t0 = Date.parse('2026-09-27T12:00:00.000Z');
  const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [{ prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'X', sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 })) }] })) };
  const logs = {}; [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { logs['log_' + w + '_' + d + '_0_s' + s] = { carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 3, prescriptionExerciseId: PID, ts: t0 + d * 1000 + s }; }));
  const rec = { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'X', action: 'increase_load', newLoad: 5 };
  const entries = Object.assign({ progrec_1_2: { calculatedAt: '2026-09-27T12:00:00.000Z', recommendations: [rec] } }, logs);
  const base = { clientId: 'c', planId: 'p', activePlanId: 'p', plan, interventions: [], entries, records: {}, at: '2026-09-28T00:00:00.000Z', isStarted: consumer.targetStarted };
  const a = shadow.materializeRecords(base);
  assert.equal(a.created.length, 1); assert.equal(a.records[a.created[0]].state, 'PENDING'); assert.equal(a.records[a.created[0]].magnitude.mode, 'SHADOW');
  assert.deepEqual(base.records, {}, 'inputs are never mutated');
  const again = shadow.materializeRecords(Object.assign({}, base, { records: a.records }));
  assert.equal(again.changed, false);
  const started = shadow.materializeRecords(Object.assign({}, base, { entries: Object.assign({ log_2_0_0_s0: { done: true } }, entries) }));
  assert.equal(started.records[started.created[0]].state, 'STALE'); assert.equal(started.records[started.created[0]].reasonCode, 'EXPOSURE_PASSED');
  const newer = { calculatedAt: '2026-09-27T12:30:00.000Z', recommendations: [rec] };
  const sup = shadow.materializeRecords(Object.assign({}, base, { records: a.records, entries: Object.assign({}, entries, { progrec_1_2: newer }) }));
  assert.deepEqual(Object.values(sup.records).map(r => r.state).sort(), ['PENDING', 'STALE']);
  const key = a.created[0], forged = Object.assign({}, a.records[key], { clientId: 'other' });
  assert.throws(() => shadow.materializeRecords(Object.assign({}, base, { records: { [key]: forged } })), /SHADOW_KEY_COLLISION/);
  assert.equal(shadow.materializeRecords(Object.assign({}, base, { activePlanId: 'other' })).changed, false, 'inactive plan: nothing');
  assert.equal(shadow.materializeRecords(Object.assign({}, base, { entries: { progrec_1_2: { recommendations: [rec] } } })).changed, false, 'evidence without calculatedAt is ignored');
});

test('T537.6 shadow.selectLogAuthority is equivalent to the athlete app selector (same evidence source on both sides)', () => {
  const ctx = {}; vm.createContext(ctx); ['_logDocHasEvidence', '_isLegacyUnboundLog', '_selectLogAuthority'].forEach(n => vm.runInContext(functionSource(client, n), ctx));
  const doc = (planId, updatedAt, keys) => ({ planId, updatedAt, entries: Object.fromEntries(keys.map(k => [k, { ts: 1 }])) });
  const cases = [];
  for (const m of [null, doc('p', 1, ['log_1_0_0_s0']), doc('p', 5, ['log_1_0_0_s0', 'done_1_0']), doc('q', 9, ['log_1_0_0_s0'])])
    for (const r of [null, doc('p', 2, ['log_1_0_0_s0']), doc('p', 2, ['log_1_0_0_s0', 'log_1_0_0_s1', 'done_1_0']), doc('q', 9, []), doc('p', 0, [])]) cases.push([m, r]);
  for (const [m, r] of cases) assert.deepEqual(shadow.selectLogAuthority(m, r, 'p'), ctx._selectLogAuthority(m, r, 'p'));
});

test('T537.7 SERVICE WORKER: cache version vdsen-v11 and every local script the athlete app needs is precached (canonical progression path included)', () => {
  assert.ok(/const CACHE = 'vdsen-v11';/.test(sw));
  const pre = new Set(/const PRECACHE = \[([\s\S]*?)\];/.exec(sw)[1].split(',').map(x => x.trim().replace(/['"]/g, '')).filter(Boolean));
  const needed = [...client.matchAll(/<script src="(assets\/[^"]+\.js)"><\/script>/g)].map(m => '/' + m[1]);
  assert.ok(needed.length >= 5);
  for (const f of needed) assert.ok(pre.has(f), 'precache misses ' + f);
  for (const f of ['progression-auto-apply-shadow.js', 'progression-magnitude-policy.js', 'progression-effective-prescription.js', 'progression-application-consumer.js']) {
    assert.ok(pre.has('/assets/' + f), f); assert.ok(fs.existsSync(path.join(root, 'assets', f)), f + ' exists');
  }
});

test('T537.8 rules text: the athlete branch of logs never grants canonical writes; the Coach branch requires ownership; receipts are append-only', () => {
  const logs = rules.slice(rules.indexOf('match /logs/{userId}'), rules.indexOf('match /fichas_onboarding'));
  for (const line of logs.split('\n').filter(l => /allow (create|update|delete)/.test(l) && /request\.auth\.uid == userId/.test(l)))
    assert.ok(/(createsCanonical|changesCanonical|holdsCanonical)\(\)/.test(line), 'athlete rule must exclude canonical fields: ' + line.trim());
  for (const line of logs.split('\n').filter(l => /allow (create|update|delete)/.test(l) && /isCoachUser\(\)/.test(l)))
    assert.ok(/ownsClient\(userId\)/.test(line), 'coach rule must require ownership for canonical fields: ' + line.trim());
  assert.ok(/changedKeys\(\)\.size\(\) == 0/.test(rules) && /removedKeys\(\)\.size\(\) == 0/.test(rules));
  assert.ok(!/allow write: if request\.auth != null && exists\(\/databases\/\$\(database\)\/documents\/coaches/.test(rules.slice(rules.indexOf('match /exercises'), rules.indexOf('match /plans'))), 'exercise catalog is no longer writable by any coach');
});
