'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function fn(name) {
  const i = html.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name);
  const end = html.indexOf('\n}', i);
  assert.ok(end > i, name);
  return html.slice(i, end + 2);
}

function fixture() {
  const reads = [], renders = [], timers = [];
  const tab = { style: { display: 'block' } };
  const box = {
    USER: { uid: 'athlete' }, ACTIVE_PLAN_ID: 'plan', CURRENT_WEEK: 1, REAL_WEEK: 1, DIA_ACTIVO: 0,
    LOGS: {}, _saveLogsTimer: null, _logsWriteInFlight: 0, _trustedProgressionRefreshSeq: 0,
    document: { activeElement: null, getElementById: () => tab },
    LIFECYCLE_STATE: { uid: 'athlete', planId: 'plan', candidatePlanDoc: {}, records: {}, overlays: {}, receipts: {} },
    FB: {
      db: {},
      doc(_db, ...parts) { return parts.join('/'); },
      getDoc(ref) { return new Promise(resolve => reads.push({ ref, resolve })); }
    },
    _getSessionLifecycleState() { return box.state || 'NOT_STARTED'; },
    getSesiones() { return [{}, {}]; },
    setTimeout(fn) { timers.push(fn); },
    renderEntrenamiento() { renders.push('training'); },
    renderResumen() { renders.push('summary'); }
  };
  vm.createContext(box);
  vm.runInContext([
    '_refreshProgressionAtSessionEntry', '_acceptTrustedProgressionSnapshot',
    '_flushTrustedProgressionRender', '_refreshTrustedProgression'
  ].map(fn).join('\n'), box);
  return { box, reads, renders, timers, tab };
}

function snap(planId, version, metadata = {}) {
  return {
    exists: () => true,
    data: () => ({ planId, nextExposureOverlays: { key: { version } } }),
    metadata
  };
}

test('entry reads only the visible pending active-week session, without a listener', async () => {
  const { box, reads, renders, tab } = fixture();
  tab.style.display = 'none';
  box._refreshProgressionAtSessionEntry();
  tab.style.display = 'block';
  box.state = 'IN_PROGRESS';
  box._refreshProgressionAtSessionEntry();
  box.state = 'COMPLETE';
  box._refreshProgressionAtSessionEntry();
  box.state = 'NOT_STARTED';
  box.CURRENT_WEEK = 0;
  box._refreshProgressionAtSessionEntry();
  assert.equal(reads.length, 0);
  box.CURRENT_WEEK = 1;
  box._refreshProgressionAtSessionEntry();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].ref, 'logs/athlete/mesos/plan');
  reads[0].resolve(snap('plan', 1));
  await Promise.resolve();
  assert.equal(box.LIFECYCLE_STATE.overlays.key.version, 1);
  assert.deepEqual(renders, ['training', 'summary']);
});

test('ignores cache and pending snapshots, then paints confirmed state only after capture and saves clear', async () => {
  const { box, reads, renders, timers } = fixture();
  box._refreshProgressionAtSessionEntry();
  reads[0].resolve(snap('plan', 1, { fromCache: true }));
  await Promise.resolve();
  timers.shift()();
  reads[1].resolve(snap('plan', 2, { hasPendingWrites: true }));
  await Promise.resolve();
  timers.shift()();
  assert.deepEqual(box.LIFECYCLE_STATE.overlays, {});
  box.document.activeElement = { offsetParent: {}, matches: () => true };
  reads[2].resolve(snap('plan', 3));
  await Promise.resolve();
  assert.deepEqual(renders, []);
  box.document.activeElement = null;
  box._logsWriteInFlight = 1;
  box._flushTrustedProgressionRender();
  assert.deepEqual(renders, []);
  box._logsWriteInFlight = 0;
  box._saveLogsTimer = {};
  box._flushTrustedProgressionRender();
  assert.deepEqual(renders, []);
  box._saveLogsTimer = null;
  box._flushTrustedProgressionRender();
  assert.equal(box.LIFECYCLE_STATE.overlays.key.version, 3);
  assert.deepEqual(renders, ['training', 'summary']);
});

test('does not adopt a late response after leaving or starting the session, changing account or plan, or selecting a different day', async () => {
  for (const invalidate of [
    ({ tab }) => { tab.style.display = 'none'; },
    ({ box }) => { box.state = 'IN_PROGRESS'; },
    ({ box }) => { box.USER = { uid: 'another' }; },
    ({ box }) => { box.ACTIVE_PLAN_ID = 'new-plan'; },
    ({ box }) => { box.DIA_ACTIVO = 1; }
  ]) {
    const f = fixture();
    f.box._refreshProgressionAtSessionEntry();
    invalidate(f);
    f.reads[0].resolve(snap('plan', 1));
    await Promise.resolve();
    assert.deepEqual(f.box.LIFECYCLE_STATE.overlays, {});
    assert.deepEqual(f.renders, []);
  }
});

test('discard wrong-plan data and stale responses from a previous entry', async () => {
  const { box, reads, renders } = fixture();
  box._refreshProgressionAtSessionEntry();
  box._refreshProgressionAtSessionEntry();
  reads[1].resolve(snap('wrong', 2));
  reads[0].resolve(snap('plan', 1));
  await Promise.resolve();
  assert.deepEqual(box.LIFECYCLE_STATE.overlays, {});
  assert.deepEqual(renders, []);
});

test('the training entry and day selection reuse the one-shot reader; rendering does not register it', () => {
  for (const caller of ['goTab', 'selDia']) assert.match(fn(caller), /_refreshProgressionAtSessionEntry\(\)/);
  assert.doesNotMatch(fn('renderEntrenamiento'), /_refreshProgressionAtSessionEntry|onSnapshot/);
});
