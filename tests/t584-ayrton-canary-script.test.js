'use strict';
// T584: the Ayrton pilot script manages ONLY the two Firestore fences for ONE athlete; dry-run by default; refuses to widen the scope. No network: the HTTP layer is injected.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scripts/pilot/ayrton-canary.cjs');

const UID = 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34';   // synthetic value with the format of a Firebase UID; the script never looks one up and no real UID is stored in the repository
const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'string' ? { stringValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = (v) => v.stringValue !== undefined ? v.stringValue : v.integerValue !== undefined ? +v.integerValue : v.booleanValue !== undefined ? v.booleanValue : v.nullValue !== undefined ? null
  : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : undefined;
const docOf = (o) => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)])) });

const NOW = new Date('2026-11-01T10:00:00.000Z');
// Fake Firestore: GET returns the doc with an updateTime (its version counter); COMMIT applies ALL writes or NONE, honouring currentDocument preconditions.
function fakeHttp(state, hooks) {
  const calls = [], ver = {}; hooks = hooks || {};
  const fn = async (method, p, token, body) => {
    calls.push({ method, p, body });
    if (method === 'GET') { const d = state[p]; return d === undefined ? { status: 404, body: null } : { status: 200, body: Object.assign(docOf(d), { updateTime: 'v' + (ver[p] || 0) }) }; }
    if (method === 'COMMIT') {
      if (hooks.beforeCommit) hooks.beforeCommit(state, ver);
      const paths = body.writes.map((w) => w.update.name.replace(/^projects\/[^/]+\/databases\/\(default\)\/documents\//, ''));
      for (let i = 0; i < body.writes.length; i++) {
        const cd = body.writes[i].currentDocument, p2 = paths[i];
        if (cd && cd.exists === false && state[p2] !== undefined) return { status: 400, body: null };
        if (cd && cd.updateTime && cd.updateTime !== 'v' + (ver[p2] || 0)) return { status: 400, body: null };
      }
      body.writes.forEach((w, i) => { const mask = w.updateMask.fieldPaths; state[paths[i]] = Object.assign({}, state[paths[i]] || {}, Object.fromEntries(mask.map((k) => [k, dec(w.update.fields[k])]))); ver[paths[i]] = (ver[paths[i]] || 0) + 1; });
      return { status: 200, body: {} };
    }
    throw new Error('unexpected method ' + method);
  };
  fn.calls = calls; return fn;
}
const baseState = () => ({ ['clients/' + UID]: { coachId: 'coach-abc-123456', activePlanId: 'plan-xyz-123456', role: 'client' }, 'coaches/coach-abc-123456': { role: 'coach' },
  'plans/plan-xyz-123456': { days: [{ exercises: [{ prescriptionExerciseId: 'p1' }, { prescriptionExerciseId: 'p2' }, { exerciseName: 'sin pid' }] }] } });
const run = (argv, state, extra) => { const http = fakeHttp(state), lines = []; return main(argv, http, lines, extra).then((r) => ({ r, http, lines })); };
const main = (argv, http, lines, extra) => S.main(argv, Object.assign({ http, token: () => 'test-token', log: (l) => lines.push(l), now: NOW }, extra || {}));
const runH = (argv, state, hooks) => { const http = fakeHttp(state, hooks), lines = []; return main(argv, http, lines).then((r) => ({ r, http, lines })); };

test('T584-P1 only a single, well-formed Firebase UID is accepted (no wildcard, list, path or short value)', () => {
  assert.equal(S.validateUid(UID), UID);
  for (const bad of ['*', '', 'abc', UID + '/x', ' ' + UID, [UID], { uid: UID }, null, undefined, 'a'.repeat(41), 'a b c d e f g h i j k l m n']) assert.throws(() => S.validateUid(bad), /UID inválido/, JSON.stringify(bad));
});

test('T584-P2 the documents it builds list exactly ONE athlete and nothing else; stop keeps the list but disables', () => {
  assert.deepEqual(S.releaseDoc(UID, true, '2026-11-02T10:00:00Z'), { schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [UID], expiresAt: '2026-11-02T10:00:00Z' });
  assert.throws(() => S.releaseDoc(UID, true), /expiresAt obligatorio/); assert.throws(() => S.releaseDoc(UID, true, 'mañana'), /expiresAt obligatorio/);
  assert.deepEqual(S.canaryField(UID, true), { enabled: true, clientIds: [UID], prescriptionExerciseIds: [] });
  assert.equal(S.releaseDoc(UID, false, '2026-11-01T10:00:00Z').enabled, false); assert.equal(S.canaryField(UID, false).enabled, false);
});

test('T584-P3 status is read-only and reports the athlete / fences without writing', async () => {
  const { r, http, lines } = await run(['--uid', UID, '--mode', 'status'], baseState());
  assert.equal(r.wrote, 0); assert.ok(http.calls.every((c) => c.method === 'GET')); assert.ok(lines.some((l) => /ejercicios=3 con prescriptionExerciseId=2/.test(l))); assert.ok(lines.some((l) => /Allowlist release: \(ausente\)/.test(l)));
});

test('T584-P4 enable WITHOUT --confirm is a dry run: nothing is written', async () => {
  const state = baseState(), before = JSON.stringify(state); const { r, http, lines } = await run(['--uid', UID, '--mode', 'enable'], state);
  assert.equal(r.wrote, 0); assert.ok(http.calls.every((c) => c.method === 'GET')); assert.equal(JSON.stringify(state), before); assert.ok(lines.some((l) => /SIMULACIÓN/.test(l)) && lines.some((l) => /no se escribió nada/.test(l)));
});

test('T584-P5 enable --confirm writes exactly the two fences in ONE atomic commit with field masks, for this athlete only (T657: with expiry)', async () => {
  const state = baseState(); const { r, http } = await runH(['--uid', UID, '--mode', 'enable', '--confirm'], state);
  assert.equal(r.wrote, 2); const commits = http.calls.filter((c) => c.method === 'COMMIT'); assert.equal(commits.length, 1, 'one commit, no sequential PATCHes'); assert.ok(!http.calls.some((c) => c.method === 'PATCH'));
  const w = commits[0].body.writes; assert.deepEqual(w.map((x) => x.updateMask.fieldPaths), [['schema', 'enabled', 'clientIds', 'expiresAt'], ['autoApplyCanary']]);
  assert.deepEqual(w.map((x) => x.currentDocument), [{ exists: false }, { updateTime: 'v0' }], 'create-only for the absent release doc; version precondition for the Coach doc');
  assert.equal(state['releaseControl/autonomousProgression'].expiresAt, '2026-11-02T10:00:00Z', 'default 24 h');
  assert.equal(state['releaseControl/autonomousProgression'].enabled, true); assert.deepEqual(state['releaseControl/autonomousProgression'].clientIds, [UID]); assert.deepEqual(state['coaches/coach-abc-123456'].autoApplyCanary, { enabled: true, clientIds: [UID], prescriptionExerciseIds: [] });
  assert.equal(state['clients/' + UID].activePlanId, 'plan-xyz-123456', 'the client / plan / logbook documents are never written');
});

test('T584-P6 stop --confirm disables both fences (immediate effect: the executor re-reads them inside every transaction)', async () => {
  const state = baseState(); await run(['--uid', UID, '--mode', 'enable', '--confirm'], state); await run(['--uid', UID, '--mode', 'stop', '--confirm'], state);
  assert.equal(state['releaseControl/autonomousProgression'].expiresAt, '2026-11-01T10:00:00Z'); assert.equal(state['releaseControl/autonomousProgression'].enabled, false); assert.deepEqual(state['releaseControl/autonomousProgression'].clientIds, [UID]); assert.equal(state['coaches/coach-abc-123456'].autoApplyCanary.enabled, false);
});

test('T584-P7 it never widens the scope: another athlete already listed => refused unless --replace; an unknown UID writes nothing', async () => {
  const state = baseState(); state['releaseControl/autonomousProgression'] = { schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: ['someoneElseUid1234567890abc'] };
  const refused = await runH(['--uid', UID, '--mode', 'enable', '--confirm'], state); assert.equal(refused.r.refused, true); assert.equal(refused.r.wrote, 0); assert.ok(refused.http.calls.every((c) => c.method === 'GET'));
  await assert.rejects(() => run(['--uid', 'Q'.repeat(28), '--mode', 'enable', '--confirm'], baseState()), /No existe clients/);
  await assert.rejects(() => run(['--uid', '*', '--mode', 'enable', '--confirm'], baseState()), /UID inválido/);
  const noPlan = baseState(); delete noPlan['clients/' + UID].activePlanId; await assert.rejects(() => run(['--uid', UID, '--mode', 'enable', '--confirm'], noPlan), /sin|no tiene/i);
});

test('T584-P8 it never touches Vercel variables, CRON or any other collection (static contract)', () => {
  const src = require('node:fs').readFileSync('scripts/pilot/ayrton-canary.cjs', 'utf8');
  assert.ok(!/vercel|CRON_SECRET|NUMERIC_APPLY|env add|env rm/i.test(src.replace(/\/\/.*$/gm, '')), 'no Vercel / CRON code'); assert.ok(!/DELETE/.test(src), 'no deletes');
  assert.deepEqual(Object.keys(S).sort(), ['PROJECT', 'RELEASE_PATH', 'RELEASE_SCHEMA', 'canaryField', 'main', 'planWrites', 'releaseDoc', 'validateTtlHours', 'validateUid']);
});

test('T657-A a failed or contended commit leaves BOTH fences untouched (no partial activation)', async () => {
  // The Coach doc changes between our read and our commit: the version precondition fails the whole commit.
  const state = baseState(), before = JSON.stringify(state);
  await assert.rejects(() => runH(['--uid', UID, '--mode', 'enable', '--confirm'], state, { beforeCommit: (st, ver) => { ver['coaches/coach-abc-123456'] = 7; } }), /commit atómico falló.*NINGUNA/);
  assert.equal(JSON.stringify(state), before, 'neither the release fence nor the canary was written');
  // The release doc is created by someone else in the meantime: the exists:false precondition fails the whole commit.
  const s2 = baseState();
  await assert.rejects(() => runH(['--uid', UID, '--mode', 'enable', '--confirm'], s2, { beforeCommit: (st) => { st['releaseControl/autonomousProgression'] = { enabled: true, clientIds: ['other'] }; } }), /commit atómico falló/);
  assert.equal(s2['coaches/coach-abc-123456'].autoApplyCanary, undefined, 'the Coach fence was not written');
  assert.deepEqual(s2['releaseControl/autonomousProgression'], { enabled: true, clientIds: ['other'] }, 'the other fence is not overwritten');
});

test('T657-B --ttl-hours is validated (1..168), defaults to 24 h and sets expiresAt; a missing Coach doc writes nothing', async () => {
  for (const bad of ['0', '169', '1.5', '-1', 'abc', '24h']) await assert.rejects(() => run(['--uid', UID, '--mode', 'enable', '--confirm', '--ttl-hours', bad], baseState()), /ttl-hours inválido/, bad);
  const st = baseState(); await run(['--uid', UID, '--mode', 'enable', '--confirm', '--ttl-hours', '2'], st); assert.equal(st['releaseControl/autonomousProgression'].expiresAt, '2026-11-01T12:00:00Z');
  const noCoach = baseState(); delete noCoach['coaches/coach-abc-123456']; const h = fakeHttp(noCoach);
  await assert.rejects(() => main(['--uid', UID, '--mode', 'enable', '--confirm'], h, []), /No existe coaches/); assert.ok(h.calls.every((c) => c.method === 'GET'));
});
