'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../api/_numericPilotContract');
const now = Date.parse('2026-11-04T12:00:00Z');
const w = { schema: 'vdsen-numeric-pilot-v1', mode: 'NUMERIC_APPLY', uid: C.UID, planId: C.PLAN, pid: C.PID,
  runtimeSha: 'a'.repeat(40), operationId: 'operation-01', startsAt: '2026-11-04T12:00:00Z', expiresAt: '2026-11-05T12:00:00Z' };
const scope = { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] };
const plan = { days: [{ exercises: [{ prescriptionExerciseId: C.PID }] }] };
test('numeric scope requires exactly the authorized UID and PID in the plan', () => {
  assert.equal(C.scopeValid(scope, C.UID, C.PID, plan), true);
  for (const patch of [{ enabled: false }, { clientIds: [] }, { clientIds: [C.UID, C.UID] }, { clientIds: ['*'] },
    { prescriptionExerciseIds: [] }, { prescriptionExerciseIds: [C.PID, C.PID] }, { prescriptionExerciseIds: ['*'] }, { prescriptionExerciseIds: ['other'] }]) {
    assert.equal(C.scopeValid({ ...scope, ...patch }, C.UID, C.PID, plan), false);
  }
  assert.equal(C.scopeValid(scope, 'other', C.PID, plan), false);
  assert.equal(C.scopeValid(scope, C.UID, C.PID, { days: [] }), false);
});
test('numeric window binds identity and a strict 24-hour interval', () => {
  assert.equal(C.windowValid(w, now), true);
  assert.equal(C.windowValid(w, Date.parse(w.expiresAt)), false);
  for (const patch of [{ uid: 'other' }, { planId: 'other' }, { pid: 'other' }, { mode: 'STAGE1_SHADOW' },
    { runtimeSha: '' }, { operationId: '' }, { startsAt: 'bad' }, { expiresAt: '2026-11-05T12:00:01Z' }]) {
    assert.equal(C.windowValid({ ...w, ...patch }, now), false);
  }
});
test('direct executor calls cannot apply without explicit numeric authorization', async () => {
  const executor = require('../api/_autonomousProgression');
  const db = new Proxy({}, { get() { throw new Error('database must not be touched'); } });
  const keys = ['AUTONOMOUS_PROGRESSION_ENABLED', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'VDSEN_NUMERIC_PILOT_ENABLED',
    'VDSEN_NUMERIC_PILOT_RUNTIME_SHA', 'VDSEN_NUMERIC_PILOT_WINDOW'];
  const saved = keys.map(k => [k, process.env[k]]);
  try {
    keys.forEach(k => delete process.env[k]);
    for (const auth of [undefined, {}, { enabled: true, numericApplyEnabled: false, window: w },
      { enabled: true, numericApplyEnabled: true, window: w, runtimeSha: w.runtimeSha }]) {
      assert.deepEqual(await executor.applyPending(db, C.UID, C.PLAN, () => '2026-11-04T12:00:00Z', auth), []);
    }
  } finally { saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
});
test('runtime authorization requires all independent switches, bound runtime and no cron', () => {
  const env = { AUTONOMOUS_PROGRESSION_ENABLED: 'true', AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_ENABLED: 'true', VDSEN_NUMERIC_PILOT_RUNTIME_SHA: w.runtimeSha, VDSEN_NUMERIC_PILOT_WINDOW: JSON.stringify(w) };
  assert.deepEqual(C.runtimeAuthorization(env, now), w);
  for (const patch of [{ AUTONOMOUS_PROGRESSION_ENABLED: 'false' }, { AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'false' },
    { VDSEN_NUMERIC_PILOT_ENABLED: 'false' }, { VDSEN_NUMERIC_PILOT_RUNTIME_SHA: 'b'.repeat(40) }, { CRON_SECRET: 'configured' },
    { VDSEN_NUMERIC_PILOT_WINDOW: '{' }]) assert.equal(C.runtimeAuthorization({ ...env, ...patch }, now), null);
  assert.equal(C.runtimeAuthorization(env, Date.parse(w.expiresAt)), null);
});
test('sandbox handler flag alone cannot grant server numeric authority', () => {
  assert.equal(C.runtimeAuthorization({ E2E_NUMERIC: '1' }, now), null);
  assert.equal(C.runtimeAuthorization({ E2E_NUMERIC: '1', AUTONOMOUS_PROGRESSION_ENABLED: 'true',
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true' }, now), null);
});
