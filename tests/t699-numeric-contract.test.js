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
