'use strict';
// T603 — server callers decide the exposure start from database-stamped markers only; Coach decision times come from database-stamped records; the Client writes both.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const eff = require('../assets/progression-effective-prescription.js');
const F = require('./helpers/lifecycle-fixture.js');

const entries = (extra) => Object.assign({ log_2_0_0_s0: { done: true, prescriptionExerciseId: 'p', ts: 5, sts: 1000 } }, extra || {});
test('T603.1 trusted callers ignore entries.sts and ts: only start markers count; none = unknown order', () => {
  assert.deepEqual(eff.exposureStart(entries(), 'p', 2, 0, { markers: [] }), { started: true, at: null });
  assert.deepEqual(eff.exposureStart(entries(), 'p', 2, 0, { markers: [{ at: { seconds: 5, nanoseconds: 0 } }] }), { started: true, at: 5000 });
  assert.equal(eff.exposureStart(entries(), 'p', 2, 0, { markers: [{ at: 9000 }, { at: 7000 }] }).at, 7000, 'earliest wins');
  assert.deepEqual(eff.exposureStart({}, 'p', 2, 0, { markers: [{ at: 1 }] }), { started: false, at: null }, 'a marker without a persisted set starts nothing');
});
test('T603.2 display callers (no trust) keep using sts', () => { assert.equal(eff.exposureStart(entries(), 'p', 2, 0).at, 1000); });
test('T603.3 withServerDecisionTimes replaces the Coach device text only for interventions that have a database record', () => {
  const out = eff.withServerDecisionTimes([{ id: 'a', decidedAt: '2020-01-01T00:00:00.000Z' }, { id: 'b', decidedAt: 'x' }, { decidedAt: 'y' }], { a: { seconds: 1700000000, nanoseconds: 0 } });
  assert.equal(out[0].decidedAt, new Date(1700000000000).toISOString()); assert.equal(out[0].decidedAtServerVerified, true); assert.equal(out[1].decidedAt, 'x'); assert.equal(out[2].decidedAt, 'y');
});
test('T603.4 evaluateOverlay (trusted): marker before the plan revision keeps the overlay; marker after / missing invalidates; untrusted sts cannot rescue it', () => {
  const sc = F.scenario(), a = F.applied(sc), t = a.overlay.target, key = 'log_' + t.week + '_' + t.dayIndex + '_0_s0', EDIT = Date.parse('2026-09-28T09:00:00.000Z');
  const mk = (markers, sts) => { const i = F.effectiveInput(a, { canonicalOverlayRead: true }); i.plan = Object.assign({}, a.plan, { updatedAt: new Date(EDIT).toISOString() }); i.trustedStarts = true; i.startMarkers = markers;
    i.entries = Object.assign({}, a.entries, { [key]: { done: true, carga: '100', reps: '10', unit: 'KG', prescriptionExerciseId: sc.pid, ts: 1, sts } }); return eff.evaluateOverlay(i).usable; };
  assert.equal(mk([{ at: EDIT - 60000 }], EDIT + 60000), true, 'marker (database) says it started first; a forged-late sts is irrelevant');
  assert.equal(mk([{ at: EDIT + 60000 }], EDIT - 60000), false, 'marker says it started after the revision; a forged-early sts cannot backdate it');
  assert.equal(mk([], EDIT - 60000), false, 'no marker: fail closed');
});
const HTML = fs.readFileSync('vdsen-cliente.html', 'utf8'), COACH = fs.readFileSync('vdsen-coach.html', 'utf8');
test('T603.5 the Client creates the start marker with serverTimestamp right after the log write, once per exposure, never blocking the save', () => {
  assert.match(HTML, /var ref = FB\.doc\(FB\.db, 'logs', uid, 'starts', id\);/);
  assert.match(HTML, /FB\.setDoc\(ref, \{ planId: planId, week: Number\(m\[1\]\), dayIndex: Number\(m\[2\]\), exerciseIndex: Number\(m\[3\]\), setKey: k, at: FB\.serverTimestamp\(\) \}\)/);
  assert.ok(HTML.indexOf("_writeStartMarkers(_uidAtStart, ACTIVE_PLAN_ID, _dE.set)") > HTML.indexOf("_mesoP = _fbWriteOrQueue(FB.setDoc(FB.doc(FB.db, 'logs', _uidAtStart, 'mesos'"), 'issued behind the meso write');
  assert.match(HTML, /_resolveStartMarkerFailure\(mk, ref, error\)/);
});
test('T603.6 every Coach EXERCISE decision is written with its database-stamped record in the SAME commit (batch / transaction)', () => {
  assert.match(COACH, /_wb\.set\(doc\(db, 'clients', _clientIdSnap, 'decisions', String\(record\.id\)\), _decisionRecord\(record\)\)/);
  assert.match(COACH, /tx\.set\(doc\(db, 'clients', clientId, 'decisions', String\(intervention\.id\)\), _decisionRecord\(intervention\)\)/);
  assert.match(COACH, /at: serverTimestamp\(\) \};/);
});
test('T603.7 firestore.rules: markers are create-only with at == request.time after a persisted set; decisions are create-only for the owner Coach; nothing else widened', () => {
  const r = fs.readFileSync('firestore.t603.rules', 'utf8'), s = r.slice(r.indexOf('match /starts/{startId}'), r.indexOf('match /mesos/{planId}')), d = r.slice(r.indexOf('match /decisions/{decisionId}'), r.indexOf('match /exercises/'));
  assert.match(s, /request\.resource\.data\.at == request\.time/); assert.match(s, /get\(\/databases\/\$\(database\)\/documents\/logs\/\$\(userId\)\/mesos\//); assert.doesNotMatch(s, /allow (update|delete|write)/);
  assert.match(d, /request\.resource\.data\.at == request\.time/); assert.match(d, /ownsClient\(clientId\)/); assert.doesNotMatch(d, /allow (update|delete|write)/);
});

test('T603.8 the candidate Rules are the deployed runtime Rules plus exactly the two additive blocks', () => {
  const state = JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
  const cand = fs.readFileSync('firestore.t603.rules', 'utf8');
  const base = state.release_mode === 'rules_only' || state.published_rules   // once FE151 is published, firestore.rules at HEAD is the candidate itself: the deployed-runtime Rules come from the pinned runtime
    ? execFileSync('git', ['show', state.runtime_sha + ':firestore.rules'], { encoding: 'utf8' })
    : fs.readFileSync('firestore.rules', 'utf8');
  const stripped = cand.replace(/      \/\/ T603: COACH DECISION RECORD[^]*?\n      \}\n/, '').replace(/      \/\/ T603: EXPOSURE START MARKER[^]*?\n      \}\n/, '');
  assert.equal(stripped, base);
  assert.ok(cand.length > base.length);
  if (state.release_mode === 'rules_only') assert.equal(fs.readFileSync('firestore.rules', 'utf8'), cand);
});
