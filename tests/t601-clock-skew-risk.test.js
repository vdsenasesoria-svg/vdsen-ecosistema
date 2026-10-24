'use strict';
// T601 — CHARACTERIZATION of the residual risk documented by T599-R: the order "plan revision / Coach decision vs. first working set" is inferred from two clocks
// (plan.updatedAt and decidedAt are written by the Coach app / server time; the set `ts` is the athlete DEVICE clock). These tests pin what happens under skew so the risk is
// measured, not assumed. They do NOT claim safety: with a device clock behind the Coach clock by more than the gap between the edit and the first set, an overlay that was
// invalidated before the exposure can still be judged "started first" and keep its authority. Numeric Apply must stay NO-GO until the start time comes from a server clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./helpers/lifecycle-fixture.js');
const eff = require('../assets/progression-effective-prescription.js');

const EDIT = Date.parse('2026-09-28T09:00:00.000Z');          // Coach clock: plan revised
const TRUE_START = EDIT + 5 * 60 * 1000;                     // the athlete really starts 5 minutes LATER (edit BEFORE start: the overlay must be invalid)
function usableWithDeviceOffset(offsetMs) {   // device clock = true time + offset
  const sc = F.scenario(), a = F.applied(sc), input = F.effectiveInput(a, { canonicalOverlayRead: true }), t = a.overlay.target;
  input.plan = Object.assign({}, a.plan, { updatedAt: new Date(EDIT).toISOString() });
  input.entries = Object.assign({}, a.entries, { ['log_' + t.week + '_' + t.dayIndex + '_0_s0']: { done: true, carga: '100', reps: '10', unit: 'KG', rir_real: 2, prescriptionExerciseId: sc.pid, ts: TRUE_START + offsetMs } });
  return eff.evaluateOverlay(input).usable;
}
test('T601-clock.1 synchronized or ahead device clocks: the pre-start edit invalidates the overlay (safe)', () => {
  assert.equal(usableWithDeviceOffset(0), false); assert.equal(usableWithDeviceOffset(+60 * 1000), false); assert.equal(usableWithDeviceOffset(+60 * 60 * 1000), false);
});
test('T601-clock.2 a device clock BEHIND by less than the edit→start gap is still safe; beyond it the order is misread (KNOWN RESIDUAL RISK)', () => {
  assert.equal(usableWithDeviceOffset(-4 * 60 * 1000), false, 'behind 4 min < 5 min gap: still invalidated');
  assert.equal(usableWithDeviceOffset(-6 * 60 * 1000), true, 'behind 6 min > 5 min gap: the invalidated overlay keeps authority (documented risk, NOT acceptable for Numeric Apply)');
  assert.equal(usableWithDeviceOffset(-60 * 60 * 1000), true);
});
test('T601-clock.3 the opposite skew (edit really AFTER the start, device clock ahead) fails safe: the overlay is dropped mid-exposure', () => {
  const sc = F.scenario(), a = F.applied(sc), input = F.effectiveInput(a, { canonicalOverlayRead: true }), t = a.overlay.target;
  const trueStart = EDIT - 5 * 60 * 1000;   // the athlete started BEFORE the edit: the overlay must stay
  input.plan = Object.assign({}, a.plan, { updatedAt: new Date(EDIT).toISOString() });
  for (const [offset, expected] of [[0, true], [+4 * 60 * 1000, true], [+6 * 60 * 1000, false]]) {
    input.entries = Object.assign({}, a.entries, { ['log_' + t.week + '_' + t.dayIndex + '_0_s0']: { done: true, carga: '100', reps: '10', unit: 'KG', rir_real: 2, prescriptionExerciseId: sc.pid, ts: trueStart + offset } });
    assert.equal(eff.evaluateOverlay(input).usable, expected, 'offset ' + offset);
  }
});
