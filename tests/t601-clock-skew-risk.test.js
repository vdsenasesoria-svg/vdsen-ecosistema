'use strict';
// T601 characterized the residual risk of T599-R (order inferred from the athlete's DEVICE clock). T602 removes the device clock from the authorization: the start of the exposure is the
// database's own commit time of the first working set (`sts`, Firestore serverTimestamp), so a wrong device date can neither revive an invalidated overlay nor drop a legitimate one.
// These are the T601 scenarios, now asserting SAFETY for every skew. (Before T602, offsets of -6 min / -30 min made `usableWithDeviceOffset` return true.)
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./helpers/lifecycle-fixture.js');
const eff = require('../assets/progression-effective-prescription.js');

const EDIT = Date.parse('2026-09-28T09:00:00.000Z');          // Coach revises the plan
const SERVER_START_AFTER = EDIT + 5 * 60 * 1000;             // the athlete's first set is committed 5 minutes AFTER the edit (overlay invalid)
const SERVER_START_BEFORE = EDIT - 5 * 60 * 1000;            // ... or 5 minutes BEFORE it (overlay legitimately started)
const MIN = 60 * 1000;
function usable(serverStart, deviceOffsetMs) {   // device `ts` = true time + offset; `sts` = server commit time (what the database recorded)
  const sc = F.scenario(), a = F.applied(sc), input = F.effectiveInput(a, { canonicalOverlayRead: true }), t = a.overlay.target;
  input.plan = Object.assign({}, a.plan, { updatedAt: new Date(EDIT).toISOString() });
  input.entries = Object.assign({}, a.entries, { ['log_' + t.week + '_' + t.dayIndex + '_0_s0']: { done: true, carga: '100', reps: '10', unit: 'KG', rir_real: 2, prescriptionExerciseId: sc.pid, ts: serverStart + deviceOffsetMs, sts: { seconds: Math.floor(serverStart / 1000), nanoseconds: 0 } } });
  return eff.evaluateOverlay(input).usable;
}
const OFFSETS = [0, -5 * MIN, -6 * MIN, -30 * MIN, +30 * MIN, -24 * 60 * MIN];
test('T602-clock.1 edit BEFORE the first set: invalidated for every device clock (correct, -5, -6, -30 min, +30 min, -1 day)', () => {
  for (const off of OFFSETS) assert.equal(usable(SERVER_START_AFTER, off), false, 'offset ' + off / MIN + ' min');
});
test('T602-clock.2 edit AFTER the first set: the legitimate start is retained for every device clock', () => {
  for (const off of OFFSETS) assert.equal(usable(SERVER_START_BEFORE, off), true, 'offset ' + off / MIN + ' min');
});
test('T602-clock.3 a first set WITHOUT a server-confirmed time (historical data / pre-T602 Client) fails closed when an invalidation exists, and is untouched when none exists', () => {
  const sc = F.scenario(), a = F.applied(sc), t = a.overlay.target, key = 'log_' + t.week + '_' + t.dayIndex + '_0_s0';
  const legacy = { done: true, carga: '100', reps: '10', unit: 'KG', rir_real: 2, prescriptionExerciseId: sc.pid, ts: SERVER_START_BEFORE };   // device clock only
  const edited = F.effectiveInput(a, { canonicalOverlayRead: true }); edited.plan = Object.assign({}, a.plan, { updatedAt: new Date(EDIT).toISOString() }); edited.entries = Object.assign({}, a.entries, { [key]: legacy });
  assert.equal(eff.evaluateOverlay(edited).usable, false, 'edit present + unknown order -> no authority (the training record itself is untouched)');
  const clean = F.effectiveInput(a, { canonicalOverlayRead: true }); clean.entries = Object.assign({}, a.entries, { [key]: legacy });
  assert.equal(eff.evaluateOverlay(clean).usable, true, 'no invalidation: legacy data keeps working');
});
test('T602-clock.4 server commit times are read from every shape the SDKs produce', () => {
  for (const v of [1000, { seconds: 1, nanoseconds: 0 }, { _seconds: 1, _nanoseconds: 0 }, { toMillis: () => 1000 }]) assert.equal(eff.serverMillis(v), 1000);
  for (const v of [null, undefined, 'x', {}, NaN]) assert.equal(eff.serverMillis(v), null);
});
