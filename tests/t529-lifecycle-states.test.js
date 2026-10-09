// T529: canonical lifecycle states on the EXISTING progression application record (no second state machine) + transition firewall.
const test = require('node:test');
const assert = require('node:assert/strict');
const shipped = require('../assets/progression-auto-apply-shadow.js');
const { build } = require('./helpers/lifecycle-sandbox.js');
const on = build(true).shadow;

const pending = () => ({ key: 'v1_aaaaaaaaaaaaaaaa', clientId: 'c', planId: 'p', prescriptionExerciseId: 'pid', state: 'PENDING', reasonCode: 'MAGNITUDE_POLICY_MISSING', revision: 1,
  events: [{ state: 'PENDING', operationKey: 'v1_aaaaaaaaaaaaaaaa' }], createdAt: 't0', updatedAt: 't0' });
const T = (api, rec, to, o = {}) => api.lifecycleTransition(rec, to, Object.assign({ expectedRevision: rec.revision, operationKey: 'op:' + to + ':' + rec.revision, at: '2026-09-29T10:00:00.000Z', actorId: 'coach' }, o));

test('T529.1 states are the minimum coherent set on the existing record', () => {
  assert.deepEqual(Object.keys(shipped.STATES).sort(), ['APPLIED', 'CONSUMED', 'OVERRIDDEN', 'PENDING', 'REJECTED', 'REVERTED', 'STALE']);
});
test('T529.2 the transition table is explicit and exactly as decided', () => {
  assert.deepEqual(shipped.ALLOWED_TRANSITIONS.PENDING.slice().sort(), ['APPLIED', 'REJECTED', 'STALE']);
  assert.deepEqual(shipped.ALLOWED_TRANSITIONS.APPLIED.slice().sort(), ['CONSUMED', 'OVERRIDDEN', 'REVERTED', 'STALE']);
  for (const s of ['CONSUMED', 'OVERRIDDEN', 'REVERTED', 'STALE']) assert.deepEqual(shipped.ALLOWED_TRANSITIONS[s], [], s + ' is terminal');
});
test('T529.3 shipped flag false: APPLIED can never be created', () => {
  assert.equal(shipped.NUMERIC_APPLY_ENABLED, false);
  const r = T(shipped, pending(), 'APPLIED');
  assert.equal(r.ok, false); assert.equal(r.reasonCode, 'NUMERIC_APPLY_DISABLED');
});
test('T529.4 flag-on sandbox: PENDING -> APPLIED bumps revision, appends the event with the deterministic operationKey and lifecycle facts', () => {
  const r = T(on, pending(), 'APPLIED', { operationKey: 'apply:v1_aaaaaaaaaaaaaaaa', patch: { overlayKey: 'ovl_v1_aaaaaaaaaaaaaaaa', appliedAt: 'X' } });
  assert.equal(r.ok, true); assert.equal(r.idempotent, false);
  assert.equal(r.record.state, 'APPLIED'); assert.equal(r.record.revision, 2);
  assert.equal(r.record.lifecycle.overlayKey, 'ovl_v1_aaaaaaaaaaaaaaaa');
  const ev = r.record.events[r.record.events.length - 1];
  assert.deepEqual([ev.state, ev.operationKey, ev.actorId], ['APPLIED', 'apply:v1_aaaaaaaaaaaaaaaa', 'coach']);
});
test('T529.5 idempotent: the same operationKey never duplicates the event or bumps the revision', () => {
  const a = T(on, pending(), 'APPLIED', { operationKey: 'apply:k' }).record;
  const again = on.lifecycleTransition(a, 'APPLIED', { expectedRevision: 1, operationKey: 'apply:k', at: 'later' });
  assert.equal(again.ok, true); assert.equal(again.idempotent, true); assert.equal(again.record.revision, 2); assert.equal(again.record.events.length, a.events.length);
});
test('T529.6 stale revision is refused', () => {
  const r = on.lifecycleTransition(pending(), 'APPLIED', { expectedRevision: 7, operationKey: 'op1', at: 'x' });
  assert.deepEqual([r.ok, r.reasonCode], [false, 'REVISION_CONFLICT']);
});
test('T529.7 every allowed edge works; every other edge is refused', () => {
  const all = Object.keys(on.STATES);
  const reach = { APPLIED: p => T(on, p, 'APPLIED').record };
  for (const from of all) for (const to of all) {
    if (from === to) continue;
    const rec = Object.assign(pending(), { state: from, reasonCode: from === 'REJECTED' ? 'COACH_KEEP_ORIGINAL' : 'X' });
    const r = T(on, rec, to);
    const allowed = on.ALLOWED_TRANSITIONS[from].includes(to) && to !== 'PENDING';
    assert.equal(r.ok, allowed, from + '->' + to);
  }
  void reach;
});
test('T529.8 no resurrection: CONSUMED->REVERTED/APPLIED, REVERTED/OVERRIDDEN/STALE->APPLIED all refused, even with a fresh operationKey', () => {
  for (const [from, to] of [['CONSUMED', 'REVERTED'], ['CONSUMED', 'APPLIED'], ['REVERTED', 'APPLIED'], ['OVERRIDDEN', 'APPLIED'], ['STALE', 'APPLIED'], ['CONSUMED', 'OVERRIDDEN'], ['CONSUMED', 'STALE']]) {
    const r = T(on, Object.assign(pending(), { state: from }), to, { operationKey: 'fresh-' + Math.random() });
    assert.deepEqual([r.ok, r.reasonCode], [false, 'INVALID_TRANSITION'], from + '->' + to);
  }
});
test('T529.9 markStale respects the firewall: only PENDING/APPLIED can become STALE', () => {
  for (const s of ['CONSUMED', 'REVERTED', 'OVERRIDDEN']) { const rec = Object.assign(pending(), { state: s }); assert.equal(on.markStale(rec, 'PLAN_CHANGED', 't'), rec); }
  assert.equal(on.markStale(Object.assign(pending(), { state: 'APPLIED' }), 'PLAN_CHANGED', 't').state, 'STALE');
  assert.equal(on.markStale(pending(), 'PLAN_CHANGED', 't').state, 'STALE');
});
test('T529.10 summary counts every state; autoCount stays the PENDING count', () => {
  const recs = {}; ['PENDING', 'APPLIED', 'CONSUMED', 'OVERRIDDEN', 'REVERTED', 'STALE', 'REJECTED'].forEach((s, i) => { recs['k' + i] = Object.assign(pending(), { key: 'k' + i, state: s, updatedAt: 't' + i }); });
  const sum = shipped.summarize(recs, 'p');
  assert.equal(sum.autoCount, 1); assert.deepEqual(sum.counts, { PENDING: 1, APPLIED: 1, CONSUMED: 1, OVERRIDDEN: 1, REVERTED: 1, STALE: 1, REJECTED: 1 });
});
test('T529.11 existing Coach KEEP_ORIGINAL / REVERT_DECISION transitions are unchanged', () => {
  const k = shipped.transition(pending(), 'KEEP_ORIGINAL', 1, 'op-k', 't', 'coach');
  assert.equal(k.record.state, 'REJECTED');
  assert.equal(shipped.transition(k.record, 'REVERT_DECISION', 2, 'op-r', 't', 'coach').record.state, 'PENDING');
});
