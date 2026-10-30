'use strict';
// T579: the rest sheet names the exercise being rested from (the SIGUIENTE block already names the next set / exercise) and, at zero, it
// closes by itself while the DESCANSO TERMINADO alert is emitted. Navigation rules (T548 / T555) are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
function fnSrc(name) {
  const i = SRC.indexOf('function ' + name + '(');
  assert.ok(i > -1, 'missing function ' + name);
  let d = 0, j = SRC.indexOf('{', i);
  for (let k = j; k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}' && --d === 0) return SRC.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}

function sandbox(over) {
  const calls = { stop: 0, announce: [], setEj: [], scroll: 0 };
  const els = { restTimerOverlay: { style: { display: 'flex' } }, timerPill: { style: { display: 'flex' } } };
  const ctx = {
    console, Number, Math, JSON, Date, Object, Array, String, parseInt, isNaN,
    LOGS: {}, CURRENT_WEEK: 1, DIA_ACTIVO: 1, EJ_ACTIVO: 0, _EJERCICIOS_DIA: [{ sets: [1, 2, 3] }, { sets: [1, 2] }],
    _restToken: 5, _restCtx: { token: 5, week: 1, di: 1, ei: 0, si: 1, reqSeq: 3 }, _restSeconds: 0, _restAlertFired: true, _logsAckedSeq: 3, _logsReqSeq: 3,
    localStorage: { getItem: k => (k === 'vdsen_last_tab' ? '1' : null), setItem() {}, removeItem() {} },
    document: { getElementById: id => els[id] || null, activeElement: null },
    getTotalWeeks: () => 6,
    _resolveNextWorkoutAction: () => (over && over.action) || { type: 'NEXT_SET', label: 'x' },
    setEjActivo: i => { calls.setEj.push(i); }, _scrollToNextPendingSet: () => { calls.scroll++; }, stopRestTimer: () => { calls.stop++; },
    clearInterval() {}, setTimeout: () => 0, _tapGuard() {},
    _restTimer: 123,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['_restAdvanceDecision', '_restDoneCopy', '_restLiveState', '_restFinishFlow']) vm.runInContext(fnSrc(f), ctx);
  ctx._restAnnounce = (p, s) => { calls.announce.push([p, s]); };
  Object.assign(ctx, over && over.state);
  return { ctx, calls, els };
}

test('T579.1 at zero the sheet and the pill close and the alert is emitted (also when the app must NOT auto-advance)', () => {
  // manual navigation during the rest => no auto-advance; the sheet still closes
  const s = sandbox({ state: { EJ_ACTIVO: 1 } });
  s.ctx._restFinishFlow();
  assert.equal(s.els.restTimerOverlay.style.display, 'none');
  assert.equal(s.els.timerPill.style.display, 'none');
  assert.equal(s.ctx._restTimer, null, 'the interval stops counting past zero');
  assert.equal(s.calls.stop, 1, 'rest state is cleared (no ctx left)');
  assert.equal(s.calls.announce.length, 1);
  assert.equal(s.calls.announce[0][0], 'DESCANSO TERMINADO');
  assert.equal(s.calls.scroll + s.calls.setEj.length, 0, 'no navigation when the athlete moved on their own');
});

test('T579.2 at zero with an automatic advance: sheet closed, alert emitted, navigation as before', () => {
  const s = sandbox();
  s.ctx._restFinishFlow();
  assert.equal(s.els.restTimerOverlay.style.display, 'none');
  assert.equal(s.calls.announce.length, 1);
  assert.equal(s.calls.scroll, 1);
});

test('T579.3 a restored rest with no context (page reload) closes the sheet and alerts without navigating', () => {
  const s = sandbox();
  s.ctx._restCtx = null;
  s.ctx._restFinishFlow();
  assert.equal(s.els.restTimerOverlay.style.display, 'none');
  assert.equal(s.calls.announce.length, 1);
  assert.equal(s.calls.scroll + s.calls.setEj.length, 0);
});

test('T579.4 both rest sheets carry the current-exercise block and startRestTimer fills it from the rest context', () => {
  assert.equal((SRC.match(/id="restCurrentEx"/g) || []).length, 2, 'full sheet + compact sheet');
  const start = fnSrc('startRestTimer');
  assert.ok(start.includes("getElementById('restCurrentEx')") && start.includes('DESCANSANDO DE'));
  assert.ok(start.includes('textContent'), 'built with textContent (no HTML from plan data)');
  assert.ok(!/innerHTML[^;]*cname/.test(start));
  assert.ok(fnSrc('stopRestTimer').includes("getElementById('restCurrentEx')"), 'cleared on stop');
});
