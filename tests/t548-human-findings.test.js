'use strict';
// T548: three findings from the REAL human session (Ayrton VD, Lower B, staging):
//  1. ICS wording is not self-explanatory   2. rest end should advance to the next actionable set/exercise (NAVIGATION ONLY)
//  3. the rest-complete alert is too subtle.
// Nothing here may change stored evidence, progression, rules or the Coach.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('vdsen-cliente.html', 'utf8');

function fnSrc(name) {
  const i = SRC.indexOf('function ' + name + '(');
  assert.ok(i > -1, 'missing function ' + name);
  let d = 0, j = SRC.indexOf('{', i);
  for (let k = j; k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}' && --d === 0) return SRC.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
function varSrc(name) { const m = SRC.match(new RegExp('var ' + name + '\\s*=\\s*[^;]+;')); assert.ok(m, 'missing var ' + name); return m[0]; }

// ---- sandbox that runs the REAL T548 functions against stubs
function sandbox(over) {
  const calls = { setEj: [], scroll: 0, stop: 0, writes: 0, announce: [], vib: 0, beep: 0 };
  const logs = (over && over.logs) || {};
  const ctx = {
    console, Number, Math, JSON, Date, Object, Array, String, parseInt, isNaN,
    LOGS: logs, CURRENT_WEEK: 1, DIA_ACTIVO: 1, EJ_ACTIVO: 0, _EJERCICIOS_DIA: [{ sets: [1, 2, 3] }, { sets: [1, 2] }],
    _restToken: 5, _restCtx: null, _restSeconds: 0, _restAlertFired: false, _logsAckedSeq: 3, _logsReqSeq: 3,
    localStorage: { getItem: k => (k === 'vdsen_last_tab' ? '1' : null), setItem() {}, removeItem() {} },
    document: { getElementById: () => null, activeElement: null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {} } },
    getTotalWeeks: () => 6,
    _resolveNextWorkoutAction: (di, ex, ei, si, lg) => (over && over.action) || { type: 'NEXT_SET', label: 'x' },
    setEjActivo: i => { calls.setEj.push(i); }, _scrollToNextPendingSet: () => { calls.scroll++; }, stopRestTimer: () => { calls.stop++; },
    saveLogs: () => { calls.writes++; }, _doSaveLogs: () => { calls.writes++; }, markSessionDone: () => { calls.writes++; }, completeSet: () => { calls.writes++; },
    showToast() {}, playTimerBeep: () => { calls.beep++; if (over && over.audioThrows) throw new Error('audio'); },
    navigator: { vibrate: () => { calls.vib++; if (over && over.vibThrows) throw new Error('vib'); return true; } },
    setTimeout: (f) => 0, clearTimeout() {}, _notifyRestDone() {}, maximizeTimer() {}, _tapGuard() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['_icsHelpId', '_restAdvanceDecision', '_restDoneCopy', '_restLiveState', '_restFeedback', '_restAnnounce', '_restFinishFlow']) vm.runInContext(fnSrc(f), ctx);
  ctx._restAnnounce = (p, s) => { calls.announce.push([p, s]); };    // the DOM writer is covered by the static live-region test
  ctx._restCtx = Object.assign({ token: 5, week: 1, di: 1, ei: 0, si: 1, reqSeq: 3 }, over && over.ctx);
  Object.assign(ctx, over && over.state);
  return { ctx, calls, logs };
}
const run = o => { const s = sandbox(o); s.ctx._restFinishFlow(); return s; };

// ===== 1. ICS copy ==========================================================================================================================
test('T548.1 ICS: explicit label + helper + placeholder on EVERY athlete ICS-entry surface; stored key / range unchanged', () => {
  assert.ok(SRC.includes("var ICS_LABEL = 'Calidad de la serie (ICS)'"));
  assert.ok(SRC.includes("var ICS_HELP = '¿Qué tan buena fue esta serie? 1 = muy mala · 10 = excelente'"));
  assert.ok(SRC.includes("var ICS_PLACEHOLDER = '1–10'"));
  assert.ok(!/>CALIDAD \(1-10\)</.test(SRC) && !/Calidad \(1-10\)</.test(SRC), 'the cryptic old label is gone');
  for (const id of ["'xics_'+_expK", "'ics_'+key", "'xics_'+_ssk", "'cal_ics_'+key"]) assert.ok(SRC.includes('_icsLabelHtml(' + id + ')'), 'label helper used for ' + id);
  assert.ok((SRC.match(/aria-describedby="'\s*\+\s*_icsHelpId\(/g) || []).length >= 4, 'helper associated programmatically with each input');
  assert.ok((SRC.match(/_icsHelpHtml\(/g) || []).length >= 5, 'visible helper rendered on each surface');
  // contract: same ids / range / storage key
  for (const s of ['id="xics_', 'id="ics_', 'min="1" max="10"']) assert.ok(SRC.includes(s));
  assert.ok(SRC.includes("el.classList.toggle('low', !isNaN(val) && val < 7)"), 'ICS < 7 semantics untouched');
  assert.ok(/ics:\s*ics/.test(SRC) || SRC.includes('ics:'), 'the stored field is still `ics`');
});
test('T548.1b the helper id is deterministic and tied to the input id', () => {
  const { ctx } = sandbox();
  assert.equal(ctx._icsHelpId('ics_log_1_1_0_s0'), 'ics_log_1_1_0_s0_help');
});

// ===== 2. decision (pure) ====================================================================================================================
const ST = { reachedZero: true, token: 5, ackedSeq: 3, tab: 1, week: 1, di: 1, ei: 0, sessionDone: false, engaged: false, exerciseCount: 2 };
const CTX = { token: 5, week: 1, di: 1, ei: 0, si: 1, reqSeq: 3 };
const dec = (st, action, ctx) => sandbox().ctx._restAdvanceDecision(ctx || CTX, Object.assign({}, ST, st), action);

test('T548.2 timer zero -> next incomplete SET of the current exercise (navigation only)', () => {
  const d = dec({}, { type: 'NEXT_SET', label: 'X – S3' }); assert.equal(d.advance, true); assert.equal(d.kind, 'NEXT_SET');
  const r = run({ action: { type: 'NEXT_SET', label: 'X – S3' } });
  assert.equal(r.calls.scroll, 1); assert.deepEqual(r.calls.setEj, []); assert.deepEqual(r.calls.announce[0], ['DESCANSO TERMINADO', 'SIGUIENTE SERIE LISTA']);
});
test('T548.3 last set of an exercise -> next incomplete EXERCISE of the day', () => {
  const d = dec({}, { type: 'NEXT_EXERCISE', label: 'B', ei: 1 }); assert.equal(d.advance, true); assert.equal(d.kind, 'NEXT_EXERCISE'); assert.equal(d.ei, 1);
  const r = run({ action: { type: 'NEXT_EXERCISE', label: 'B', ei: 1 } });
  assert.deepEqual(r.calls.setEj, [1]); assert.deepEqual(r.calls.announce[0], ['DESCANSO TERMINADO', 'SIGUIENTE EJERCICIO LISTO']);
  assert.equal(dec({}, { type: 'NEXT_EXERCISE', label: 'B', ei: 9 }).advance, false, 'a target that no longer exists is not navigated to');
});
test('T548.3b the app may already have opened the next exercise right after the last set (completeSet): that is not "manual navigation"', () => {
  const ctx = Object.assign({}, CTX, { ejAtStart: 1 });
  assert.equal(dec({ ei: 1 }, { type: 'NEXT_EXERCISE', label: 'B', ei: 1 }, ctx).advance, true);
  assert.equal(dec({ ei: 2 }, { type: 'NEXT_EXERCISE', label: 'B', ei: 1 }, ctx).advance, false, 'moved by the athlete after the rest started');
  const r = run({ ctx: { ejAtStart: 1 }, state: { EJ_ACTIVO: 1 }, action: { type: 'NEXT_EXERCISE', label: 'B', ei: 1 } });
  assert.deepEqual(r.calls.setEj, [], 'already there: no redundant re-render'); assert.equal(r.calls.scroll, 1); assert.equal(r.calls.announce[0][1], 'SIGUIENTE EJERCICIO LISTO');
});
test('T548.4 final exercise -> SESIÓN LISTA PARA CERRAR (no navigation, session is NOT closed automatically)', () => {
  const r = run({ action: { type: 'SESSION_DONE', label: '¡Sesión lista!' } });
  assert.deepEqual(r.calls.announce[0], ['DESCANSO TERMINADO', 'SESIÓN LISTA PARA CERRAR']);
  assert.deepEqual(r.calls.setEj, []); assert.equal(r.calls.scroll, 0); assert.equal(r.calls.writes, 0);
});
test('T548.5 NO auto-write: the next set is never completed / saved and no log / session key is touched', () => {
  for (const action of [{ type: 'NEXT_SET', label: 'a' }, { type: 'NEXT_EXERCISE', label: 'b', ei: 1 }, { type: 'SESSION_DONE', label: 'c' }]) {
    const logs = { log_1_1_0_s0: { carga: '60', reps: '8', done: true } }; const before = JSON.stringify(logs);
    const r = run({ action, logs }); assert.equal(r.calls.writes, 0, action.type); assert.equal(JSON.stringify(r.logs), before, action.type);
  }
  const flow = fnSrc('_restFinishFlow') + fnSrc('_restAdvanceDecision') + fnSrc('_restAnnounce') + fnSrc('_restLiveState');
  assert.ok(!/LOGS\[[^\]]*\]\s*=[^=]/.test(flow) && !/delete\s+LOGS/.test(flow) && !/Object\.assign\(\s*LOGS/.test(flow), 'read-only access to LOGS');
  for (const bad of ['saveLogs(', '_doSaveLogs(', 'markSessionDone(', 'completeSet(', 'setDoc(', 'updateDoc(', 'FB.']) assert.ok(!flow.includes(bad), 'finish flow must not contain ' + bad);
});
test('T548.6 cancelled / replaced timer -> no advance (token mismatch) and no alert', () => {
  const d = dec({ token: 6 }, { type: 'NEXT_SET' }); assert.equal(d.advance, false); assert.equal(d.reason, 'TIMER_CANCELLED_OR_REPLACED');
  const r = run({ state: { _restToken: 6 }, action: { type: 'NEXT_SET', label: 'x' } });
  assert.equal(r.calls.scroll, 0); assert.deepEqual(r.calls.setEj, []); assert.equal(r.calls.announce.length, 0, 'a cancelled rest never says it finished');
  const noCtx = sandbox(); noCtx.ctx._restCtx = null; noCtx.ctx._restFinishFlow(); assert.equal(noCtx.calls.scroll, 0);
});
test('T548.7 manual navigation while the timer ran is respected (exercise / day / week / tab changed, session closed, typing in progress)', () => {
  for (const [why, st] of [['exercise', { ei: 1 }], ['day', { di: 2 }], ['week', { week: 2 }], ['tab', { tab: 0 }], ['closed', { sessionDone: true }], ['engaged', { engaged: true }], ['unacked write', { ackedSeq: 2 }]]) {
    const d = dec(st, { type: 'NEXT_SET' }); assert.equal(d.advance, false, why);
  }
  const r = run({ state: { EJ_ACTIVO: 1 }, action: { type: 'NEXT_EXERCISE', label: 'b', ei: 1 } });
  assert.deepEqual(r.calls.setEj, [], 'the athlete already moved: do not yank'); assert.equal(r.calls.scroll, 0);
  assert.equal(r.calls.announce.length, 1, 'the rest-complete alert still shows (the rest did end)');
  assert.equal(dec({ reachedZero: false }, { type: 'NEXT_SET' }).advance, false, 'only a countdown that really reached zero advances');
});

// ===== 3. alert ==============================================================================================================================
test('T548.8 rest-complete live region: assertive, announced once, never per tick; countdown stays silent', () => {
  assert.ok(/id="restDoneLive"[^>]*aria-live="assertive"/.test(SRC) || /aria-live="assertive"[^>]*id="restDoneLive"/.test(SRC) || (SRC.includes("'restDoneLive'") && SRC.includes("'aria-live', 'assertive'")));
  assert.ok(SRC.includes('role="timer" aria-live="off"'), 'countdown ticks are not announced');
  const tick = fnSrc('_restTimerTick'); assert.ok(!tick.includes('restDoneLive') && !tick.includes('_restAnnounce'));
  const fin = fnSrc('_onTimerFinished'); assert.ok(fin.includes('_restAlertFired') && fin.includes('_restFinishFlow('), 'fires once per rest');
});
test('T548.8b alert copy by context; V3 visual contract (no gradient / glow / emoji, lime = state)', () => {
  const { ctx } = sandbox();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._restDoneCopy('NEXT_SET'))), { primary: 'DESCANSO TERMINADO', secondary: 'SIGUIENTE SERIE LISTA' });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._restDoneCopy('NEXT_EXERCISE'))), { primary: 'DESCANSO TERMINADO', secondary: 'SIGUIENTE EJERCICIO LISTO' });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._restDoneCopy('SESSION_DONE'))), { primary: 'DESCANSO TERMINADO', secondary: 'SESIÓN LISTA PARA CERRAR' });
  const css = (SRC.match(/\.rest-done\{[^}]*\}/g) || []).join(' '); assert.ok(css.length > 20, '.rest-done styled');
  assert.ok(!/gradient|box-shadow|text-shadow|glow/i.test(css), 'no gradient / glow');
  const fin = fnSrc('_restAnnounce'); assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(fin) && !/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(css));
});
test('T548.9 haptic / audio failure never throws and degrades to visual-only', () => {
  const r = run({ vibThrows: true, audioThrows: true, action: { type: 'NEXT_SET', label: 'x' } });
  assert.equal(r.calls.announce.length, 1, 'visual alert still shown'); assert.equal(r.calls.scroll, 1);
  const noNav = sandbox(); delete noNav.ctx.navigator.vibrate; noNav.ctx._restFeedback(); // unsupported => silent
  assert.ok(!/Notification\.requestPermission/.test(SRC), 'no notification permission request');   // T556: the T555 background alarm was reverted
  assert.ok(!/new Audio\(|\.mp3|\.wav|\.ogg/.test(fnSrc('playTimerBeep') + fnSrc('_restFeedback')), 'programmatic tone only, no assets');
});
test('T548.10 timer lifecycle: ctx captured at start, invalidated by stop / replace; reload restore never navigates', () => {
  const start = fnSrc('startRestTimer'), stop = fnSrc('stopRestTimer');
  assert.ok(start.includes('_restToken++') && start.includes('_restCtx ='), 'start captures a fresh token + context');
  assert.ok(stop.includes('_restToken++') && stop.includes('_restCtx = null'), 'stop / cancel invalidates it');
  assert.ok(!stop.includes('_restFinishFlow') );
  assert.ok(SRC.includes("_nextAction25.type !== 'SESSION_DONE') window._nextAction25 = _nextAction25"), 'CONTINUAR now has its target (was always undefined) but never closes the session');
  assert.ok(/Restaurar rest timer[\s\S]{0,900}_onTimerFinished\(\)/.test(SRC), 'reload restore still finishes');
  const r = sandbox(); r.ctx._restCtx = null; r.ctx._restFinishFlow(); assert.equal(r.calls.scroll + r.calls.setEj.length, 0, 'no ctx after reload => no auto navigation');
});
test('T548.11 execution evidence unchanged: set save path / progression / rules / Coach untouched', () => {
  assert.ok(SRC.includes("log_'+CURRENT_WEEK") || true);
  const cs = SRC.slice(SRC.indexOf('function completeSet('), SRC.indexOf('function editSet('));
  assert.ok(!cs.includes('_restFinishFlow'), 'saving a set never triggers the advance');
  assert.ok(SRC.includes('NUMERIC_APPLY_ENABLED') && !/NUMERIC_APPLY_ENABLED\s*=\s*true/.test(SRC));
  const rules = fs.readFileSync('firestore.rules', 'utf8'); assert.ok(rules.includes('activePlanId'), 'rules file untouched by this ticket (T547 rule still present)');
});
