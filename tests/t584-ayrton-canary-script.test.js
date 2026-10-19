'use strict';
// T584: the Ayrton pilot script manages ONLY the two Firestore fences for ONE athlete; dry-run by default; refuses to widen the scope. No network: the HTTP layer is injected.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scripts/pilot/ayrton-canary.cjs');

const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';   // format of the real owner UID (supplied by the owner in chat); the script never looks it up
const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'string' ? { stringValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = (v) => v.stringValue !== undefined ? v.stringValue : v.integerValue !== undefined ? +v.integerValue : v.booleanValue !== undefined ? v.booleanValue : v.nullValue !== undefined ? null
  : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : undefined;
const docOf = (o) => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)])) });

function fakeHttp(state) {
  const calls = [];
  const fn = async (method, p, token, body, mask) => {
    calls.push({ method, p, mask, body });
    if (method === 'GET') { const d = state[p]; return d === undefined ? { status: 404, body: null } : { status: 200, body: docOf(d) }; }
    state[p] = Object.assign({}, state[p] || {}, Object.fromEntries(Object.entries(body.fields).map(([k, v]) => [k, dec(v)]))); return { status: 200, body: {} };
  };
  fn.calls = calls; return fn;
}
const baseState = () => ({ ['clients/' + UID]: { coachId: 'coach-abc-123456', activePlanId: 'plan-xyz-123456', role: 'client' }, 'coaches/coach-abc-123456': { role: 'coach' },
  'plans/plan-xyz-123456': { days: [{ exercises: [{ prescriptionExerciseId: 'p1' }, { prescriptionExerciseId: 'p2' }, { exerciseName: 'sin pid' }] }] } });
const run = (argv, state, extra) => { const http = fakeHttp(state), lines = []; return main(argv, http, lines, extra).then((r) => ({ r, http, lines })); };
const main = (argv, http, lines, extra) => S.main(argv, Object.assign({ http, token: () => 'test-token', log: (l) => lines.push(l) }, extra || {}));

test('T584-P1 only a single, well-formed Firebase UID is accepted (no wildcard, list, path or short value)', () => {
  assert.equal(S.validateUid(UID), UID);
  for (const bad of ['*', '', 'abc', UID + '/x', ' ' + UID, [UID], { uid: UID }, null, undefined, 'a'.repeat(41), 'a b c d e f g h i j k l m n']) assert.throws(() => S.validateUid(bad), /UID inválido/, JSON.stringify(bad));
});

test('T584-P2 the documents it builds list exactly ONE athlete and nothing else; stop keeps the list but disables', () => {
  assert.deepEqual(S.releaseDoc(UID, true), { schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [UID] });
  assert.deepEqual(S.canaryField(UID, true), { enabled: true, clientIds: [UID], prescriptionExerciseIds: [] });
  assert.equal(S.releaseDoc(UID, false).enabled, false); assert.equal(S.canaryField(UID, false).enabled, false);
});

test('T584-P3 status is read-only and reports the athlete / fences without writing', async () => {
  const { r, http, lines } = await run(['--uid', UID, '--mode', 'status'], baseState());
  assert.equal(r.wrote, 0); assert.ok(http.calls.every((c) => c.method === 'GET')); assert.ok(lines.some((l) => /ejercicios=3 con prescriptionExerciseId=2/.test(l))); assert.ok(lines.some((l) => /Allowlist release: \(ausente\)/.test(l)));
});

test('T584-P4 enable WITHOUT --confirm is a dry run: nothing is written', async () => {
  const state = baseState(), before = JSON.stringify(state); const { r, http, lines } = await run(['--uid', UID, '--mode', 'enable'], state);
  assert.equal(r.wrote, 0); assert.ok(http.calls.every((c) => c.method === 'GET')); assert.equal(JSON.stringify(state), before); assert.ok(lines.some((l) => /SIMULACIÓN/.test(l)) && lines.some((l) => /no se escribió nada/.test(l)));
});

test('T584-P5 enable --confirm writes exactly the two fences with field masks, for this athlete only', async () => {
  const state = baseState(); const { r, http } = await run(['--uid', UID, '--mode', 'enable', '--confirm'], state);
  assert.equal(r.wrote, 2); const patches = http.calls.filter((c) => c.method === 'PATCH');
  assert.deepEqual(patches.map((c) => c.p), ['releaseControl/autonomousProgression', 'coaches/coach-abc-123456']); assert.deepEqual(patches.map((c) => c.mask), [['schema', 'enabled', 'clientIds'], ['autoApplyCanary']]);
  assert.equal(state['releaseControl/autonomousProgression'].enabled, true); assert.deepEqual(state['releaseControl/autonomousProgression'].clientIds, [UID]); assert.deepEqual(state['coaches/coach-abc-123456'].autoApplyCanary, { enabled: true, clientIds: [UID], prescriptionExerciseIds: [] });
  assert.equal(state['clients/' + UID].activePlanId, 'plan-xyz-123456', 'the client / plan / logbook documents are never written');
});

test('T584-P6 stop --confirm disables both fences (immediate effect: the executor re-reads them inside every transaction)', async () => {
  const state = baseState(); await run(['--uid', UID, '--mode', 'enable', '--confirm'], state); await run(['--uid', UID, '--mode', 'stop', '--confirm'], state);
  assert.equal(state['releaseControl/autonomousProgression'].enabled, false); assert.deepEqual(state['releaseControl/autonomousProgression'].clientIds, [UID]); assert.equal(state['coaches/coach-abc-123456'].autoApplyCanary.enabled, false);
});

test('T584-P7 it never widens the scope: another athlete already listed => refused unless --replace; an unknown UID writes nothing', async () => {
  const state = baseState(); state['releaseControl/autonomousProgression'] = { schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: ['someoneElseUid1234567890abc'] };
  const refused = await run(['--uid', UID, '--mode', 'enable', '--confirm'], state); assert.equal(refused.r.refused, true); assert.equal(refused.r.wrote, 0); assert.ok(refused.http.calls.every((c) => c.method === 'GET'));
  await assert.rejects(() => run(['--uid', 'Q'.repeat(28), '--mode', 'enable', '--confirm'], baseState()), /No existe clients/);
  await assert.rejects(() => run(['--uid', '*', '--mode', 'enable', '--confirm'], baseState()), /UID inválido/);
  const noPlan = baseState(); delete noPlan['clients/' + UID].activePlanId; await assert.rejects(() => run(['--uid', UID, '--mode', 'enable', '--confirm'], noPlan), /sin|no tiene/i);
});

test('T584-P8 it never touches Vercel variables, CRON or any other collection (static contract)', () => {
  const src = require('node:fs').readFileSync('scripts/pilot/ayrton-canary.cjs', 'utf8');
  assert.ok(!/vercel|CRON_SECRET|NUMERIC_APPLY|env add|env rm/i.test(src.replace(/\/\/.*$/gm, '')), 'no Vercel / CRON code'); assert.ok(!/DELETE/.test(src), 'no deletes');
  assert.deepEqual(Object.keys(S).sort(), ['PROJECT', 'RELEASE_PATH', 'RELEASE_SCHEMA', 'canaryField', 'main', 'planWrites', 'releaseDoc', 'validateUid']);
});
