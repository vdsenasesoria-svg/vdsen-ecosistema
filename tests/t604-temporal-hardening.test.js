'use strict';

// T604: a marker may be retried after a transport rejection, but never duplicated
// locally; Coach reconciliation must pass the server-stamped temporal references.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const HTML = fs.readFileSync('vdsen-cliente.html', 'utf8');
const COACH = fs.readFileSync('vdsen-coach.html', 'utf8');
const start = HTML.indexOf('var _startMarked = {}');
const end = HTML.indexOf('async function _doSaveLogs()', start);
assert.ok(start >= 0 && end > start, 'marker implementation present');

function markerHarness(impl) {
  const calls = [], reads = [];
  const ctx = {
    REAL_WEEK: 2,
    Promise,
    FB: {
      db: {}, serverTimestamp: () => 'SERVER_TS',
      doc: (_db, _logs, uid, _starts, id) => ({ uid, id }),
      setDoc: (ref, value) => { calls.push({ ref, value }); return impl.set(ref, value, calls.length); },
      getDoc: ref => { reads.push(ref); return impl.get(ref); }
    }
  };
  vm.runInNewContext(HTML.slice(start, end) + '\nthis.write = _writeStartMarkers; this.marked = _startMarked; this.retries = _startMarkerRetries;', ctx);
  return { ctx, calls, reads };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const setMap = { log_2_0_0_s0: { done: true } };

test('T604.1 marker has one local in-flight create and confirms it after success', async () => {
  let resolve;
  const h = markerHarness({ set: () => new Promise(r => { resolve = r; }), get: () => Promise.resolve({ exists: () => false }) });
  h.ctx.write('u', 'p', setMap); h.ctx.write('u', 'p', setMap);
  assert.equal(h.calls.length, 1, 'no duplicate local create while pending');
  resolve(); await flush();
  assert.equal(h.ctx.marked['u/p_2_0_0'], 'CONFIRMED');
});

test('T604.2 transient marker rejection is retried once by a later save, without touching the log', async () => {
  const h = markerHarness({ set: (_ref, _value, n) => n === 1 ? Promise.reject({ code: 'unavailable' }) : Promise.resolve(), get: () => Promise.resolve({ exists: () => false }) });
  h.ctx.write('u', 'p', setMap); await flush(); await flush();
  assert.equal(h.ctx.marked['u/p_2_0_0'], undefined); assert.equal(h.ctx.retries['u/p_2_0_0'], 1);
  h.ctx.write('u', 'p', setMap); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.ctx.marked['u/p_2_0_0'], 'CONFIRMED');
});

test('T604.3 a create-only race is recognized as an existing server marker; a permanent missing marker is not retried', async () => {
  const exists = markerHarness({ set: () => Promise.reject({ code: 'permission-denied' }), get: () => Promise.resolve({ exists: () => true }) });
  exists.ctx.write('u', 'p', setMap); await flush(); await flush();
  assert.equal(exists.ctx.marked['u/p_2_0_0'], 'EXISTS'); assert.equal(exists.reads.length, 1);
  exists.ctx.write('u', 'p', setMap); assert.equal(exists.calls.length, 1);

  const denied = markerHarness({ set: () => Promise.reject({ code: 'permission-denied' }), get: () => Promise.resolve({ exists: () => false }) });
  denied.ctx.write('u', 'p', setMap); await flush(); await flush();
  assert.equal(denied.ctx.marked['u/p_2_0_0'], 'PERMANENT');
  denied.ctx.write('u', 'p', setMap); assert.equal(denied.calls.length, 1);
});

test('T604.4 Coach reconciliation supplies immutable start and decision references to consumption', () => {
  const at = COACH.indexOf('async function _reconcileAppliedOverlays');
  const body = COACH.slice(at, COACH.indexOf('// Phase 2A:', at));
  assert.match(body, /start: function\(markerPlanId, week, dayIndex, exerciseIndex\)/);
  assert.match(body, /'logs', clientId, 'starts', markerPlanId \+ '_' \+ week \+ '_' \+ dayIndex \+ '_' \+ exerciseIndex/);
  assert.match(body, /decision: function\(id\).*?'clients', clientId, 'decisions', String\(id\)/s);
  assert.ok(body.indexOf('consumeOverlayTransaction(tx, refs') > body.indexOf('start: function'), 'consume receives trusted refs');
});

