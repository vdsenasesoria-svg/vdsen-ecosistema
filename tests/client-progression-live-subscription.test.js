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
  const watched = [], renders = [];
  const box = {
    USER: { uid: 'athlete' }, ACTIVE_PLAN_ID: 'plan', _loadPlanSeq: 3,
    _liveUnsubProgression: null, _liveUnsubClient: null, _liveUnsubPlan: null,
    _liveUnsubLogs: null, _waitUnsubClientDoc: null, _waitUnsubActivePlan: null,
    _saveLogsTimer: null, _logsWriteInFlight: 0, _trustedProgressionRefreshSeq: 0, document: { activeElement: null },
    LIFECYCLE_STATE: { uid: 'athlete', planId: 'plan', candidatePlanDoc: {}, records: {}, overlays: {}, receipts: {} },
    FB: {
      db: {},
      doc(_db, ...parts) { return parts.join('/'); },
      onSnapshot(ref, options, callback) {
        const listener = { ref, options, callback, unsubscribed: 0 };
        watched.push(listener);
        return () => { listener.unsubscribed++; };
      }
    },
    renderEntrenamiento() { renders.push('training'); },
    renderResumen() { renders.push('summary'); }
  };
  vm.createContext(box);
  vm.runInContext([
    '_watchTrustedProgression', '_acceptTrustedProgressionSnapshot', '_flushTrustedProgressionRender',
    '_clearLiveProgressionListener', '_clearLiveListeners', '_refreshTrustedProgression'
  ].map(fn).join('\n'), box);
  return { box, watched, renders };
}

function snap(planId, version, metadata = {}) {
  return {
    exists: () => true,
    data: () => ({ planId, nextExposureOverlays: { key: { version } } }),
    metadata
  };
}

test('reads the current mesocycle; only confirmed progression changes trigger one UI refresh', () => {
  const { box, watched, renders } = fixture();
  assert.equal(box._watchTrustedProgression('wrong', 'plan', 3), null);
  assert.equal(box._watchTrustedProgression('athlete', 'old-plan', 3), null);
  assert.equal(box._watchTrustedProgression('athlete', 'plan', 2), null);
  assert.equal(watched.length, 0);
  box._watchTrustedProgression('athlete', 'plan', 3);
  assert.equal(watched[0].ref, 'logs/athlete/mesos/plan');
  assert.equal(watched[0].options.includeMetadataChanges, true);
  const push = watched[0].callback;
  push(snap('plan', 1, { fromCache: true }));
  push(snap('plan', 1, { hasPendingWrites: true }));
  push(snap('old-plan', 9));
  assert.deepEqual(box.LIFECYCLE_STATE.overlays, {});
  assert.deepEqual(renders, []);
  push(snap('plan', 1));
  push(snap('plan', 1));
  assert.equal(box.LIFECYCLE_STATE.overlays.key.version, 1);
  assert.deepEqual(renders, ['training', 'summary']);
});

test('defers redraw across editing and saves, then paints the latest server snapshot', () => {
  const { box, watched, renders } = fixture();
  box._watchTrustedProgression('athlete', 'plan', 3);
  box.document.activeElement = { offsetParent: {}, matches: () => true };
  watched[0].callback(snap('plan', 1));
  box.document.activeElement = null;
  box._logsWriteInFlight = 1;
  watched[0].callback(snap('plan', 2));
  box._logsWriteInFlight = 0;
  box._saveLogsTimer = {};
  box._flushTrustedProgressionRender();
  assert.deepEqual(renders, []);
  assert.equal(box.LIFECYCLE_STATE.progressionRenderPending, true);
  box._saveLogsTimer = null;
  box._flushTrustedProgressionRender();
  box._flushTrustedProgressionRender();
  assert.equal(box.LIFECYCLE_STATE.overlays.key.version, 2);
  assert.deepEqual(renders, ['training', 'summary']);
});

test('rejects superseded callbacks and clears the owned subscription on listener teardown', () => {
  const { box, watched, renders } = fixture();
  box._liveUnsubProgression = box._watchTrustedProgression('athlete', 'plan', 3);
  const mine = watched[0];
  box._loadPlanSeq = 4;
  mine.callback(snap('plan', 3));
  box._loadPlanSeq = 3;
  box.USER = { uid: 'another' };
  mine.callback(snap('plan', 3));
  box.USER = { uid: 'athlete' };
  box.ACTIVE_PLAN_ID = 'new-plan';
  mine.callback(snap('plan', 3));
  box.ACTIVE_PLAN_ID = 'plan';
  box._clearLiveListeners();
  box._clearLiveListeners();
  mine.callback(snap('plan', 3));
  assert.equal(mine.unsubscribed, 1);
  assert.equal(box._liveUnsubProgression, null);
  assert.deepEqual(renders, []);
});

test('loadPlan owns the plan subscription and stops it before the existing plan-change reload', () => {
  assert.match(html, /_liveUnsubProgression = _watchTrustedProgression\(user.uid, activePlanId, _mySeq\);/);
  assert.match(html, /if \(newPlanId && newPlanId !== activePlanId\) \{\s*if \(_mySeq === _loadPlanSeq\) _clearLiveProgressionListener\(\);[\s\S]+?location\.reload\(\)/);
});

test('a new listener snapshot supersedes an in-flight older one-shot refresh', async () => {
  const { box, watched, renders } = fixture();
  let finishRead;
  box.FB.getDoc = () => new Promise(resolve => { finishRead = resolve; });
  box._watchTrustedProgression('athlete', 'plan', 3);
  box._refreshTrustedProgression('athlete', 'plan');
  watched[0].callback(snap('plan', 2));
  finishRead(snap('plan', 1));
  await Promise.resolve();
  assert.equal(box.LIFECYCLE_STATE.overlays.key.version, 2);
  assert.deepEqual(renders, ['training', 'summary']);
});
