'use strict';
// T555: four findings from the athlete's real use of the T554 preview:
//  1. the rest sheet did not show what comes next (the hint was wiped by startRestTimer, and the sheet was too tall)
//  2. the alarm did not sound after leaving the browser
//  3. finishing the rest was slow / needed two taps (smooth auto-scroll swallows the first tap; the announcement waited for the write ack)
//  4. a plain "Cardio ..." plan row (no exerciseType, one 1-rep strength-shaped set) was presented as a strength set
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const vm = require('node:vm');
const SRC = fs.readFileSync('vdsen-cliente.html', 'utf8'), SW = fs.readFileSync('sw.js', 'utf8');
function fnSrc(name, src) {
  src = src || SRC; const i = src.indexOf('function ' + name + '('); assert.ok(i > -1, 'missing function ' + name);
  let d = 0, q = null, esc = false;
  for (let k = src.indexOf('{', i); k < src.length; k++) { const c = src[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return src.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
const S = (n, reps, rir) => Array.from({ length: n }, (_, i) => ({ setIndex: i, repsTarget: reps, rirTarget: rir, restSeconds: 150 }));
function nextSandbox() {
  const ctx = { console, Object, Array, String, Number, parseInt, isNaN, getEffectiveSets: e => e.sets || [], isTechniqueActive: () => true };
  vm.createContext(ctx); vm.runInContext(fnSrc('_getExType') + '\n' + fnSrc('_resolveNextWorkoutAction') + '\nthis.f=_resolveNextWorkoutAction;', ctx); return ctx.f;
}

// ---------------- 1. what is next ----------------
test('T555.1 NEXT_SET carries what the athlete needs on the rest sheet: exercise, set n of N, reps and RIR targets (label unchanged)', () => {
  const f = nextSandbox(), ex = [{ exerciseName: 'Press', sets: S(3, 8, 3) }];
  const a = f(0, ex, 0, 0, {}, 1, 6);
  assert.equal(a.type, 'NEXT_SET'); assert.equal(a.label, 'Press – S2');
  assert.deepEqual([a.title, a.setNo, a.total, a.reps, a.rir], ['Press', 2, 3, 8, 3]);
});
test('T555.2 NEXT_EXERCISE carries the exercise title, its set count and first target', () => {
  const f = nextSandbox(), ex = [{ exerciseName: 'A', sets: S(2, 8, 3) }, { exerciseName: 'Jalón', sets: S(3, 10, 2) }];
  const a = f(0, ex, 0, 1, { log_1_0_0_s0: { done: true }, log_1_0_0_s1: { done: true } }, 1, 6);
  assert.equal(a.type, 'NEXT_EXERCISE'); assert.deepEqual([a.title, a.total, a.reps, a.rir, a.ei], ['Jalón', 3, 10, 2, 1]);
});
test('T555.3 a pending cardio / circuit exercise (single log key, no sets) is a real next exercise; once logged the session can close', () => {
  const f = nextSandbox(), ex = [{ exerciseName: 'A', sets: S(1, 8, 3) }, { exerciseName: 'Cardio Zone 2', exerciseType: 'cardio', sets: [] }];
  const a = f(0, ex, 0, 0, { log_1_0_0_s0: { done: true } }, 1, 6); assert.deepEqual([a.type, a.title, a.ei], ['NEXT_EXERCISE', 'Cardio Zone 2', 1]);
  const b = f(0, ex, 0, 0, { log_1_0_0_s0: { done: true }, log_1_0_1: { done: true } }, 1, 6); assert.equal(b.type, 'SESSION_DONE');
});
test('T555.4 the next-up hint is re-rendered AFTER startRestTimer (stopRestTimer inside it wiped it) and shown as a prominent block', () => {
  assert.ok(/startRestTimer\(restTime, key\);\s*\n\s*_renderNextWorkoutAction\(_nextAction25\);/.test(SRC), 'hint re-rendered right after the timer starts');
  assert.ok(/\.rt-next-t\{[^}]*font-size:1[6-9]px/.test(SRC), 'next-up title is large and primary-coloured (it was 12px muted)');
  const r = fnSrc('_renderNextWorkoutAction'); assert.ok(/action\.title|\.rt-next-t/.test(r) && /action\.reps|rt-next-d/.test(r), 'renders title + targets');
});
test('T555.5 the rest sheet is compact: ring beside the next-up block (the old 184px ring + 68px number hid what comes next)', () => {
  assert.ok(!/\.rt-ring\{[^}]*width:184px/.test(SRC), 'no 184px ring'); assert.ok(/rt-main/.test(SRC), 'ring + next-up share one row');
});

// ---------------- 3. finishing ----------------
test('T555.6 no smooth scroll in the rest-driven navigation (a tap during a smooth scroll only stops the scroll = the "second tap")', () => {
  assert.ok(!/behavior: *'smooth'/.test(fnSrc('_scrollToNextPendingSet')), '_scrollToNextPendingSet instant');
  assert.ok(!/behavior: *'smooth'/.test(fnSrc('setEjActivo')), 'setEjActivo instant');
});
test('T555.7 CONTINUAR responds on the first tap: the sheet closes first, navigation runs next frame, and a short tap guard swallows ghost taps', () => {
  const c = fnSrc('_continueNextWorkoutAction'); assert.ok(/stopRestTimer\(\)/.test(c) && /requestAnimationFrame|setTimeout/.test(c) && /_tapGuard\(/.test(c));
  assert.ok(/function _tapGuard\(/.test(SRC)); assert.ok(/\.rt button,[^{]*\{[^}]*touch-action:manipulation/.test(SRC));
});
test('T555.8 the DESCANSO TERMINADO announcement does NOT wait for the write ack (only the auto-advance does)', () => {
  const f = fnSrc('_restFinishFlow'); const i = f.indexOf("d.reason === 'WRITE_NOT_ACKED'"), seg = f.slice(i, i + 400);
  assert.ok(/_restAnnounce\(/.test(seg), 'announces before retrying');
});

// ---------------- 2. alarm: the persistent background alarm was REVERTED (T556) ----------------
test('T555.9 (T556) the persistent background alarm is gone: no keep-alive audio, no worker notification scheduling, no Perfil alarm switch / permission prompt', () => {
  for (const f of ['_bgAlarmEnabled', '_bgKeepAliveStart', '_bgAlarmRing', '_bgStop', '_swRestSchedule', '_swRestCancel', 'setBgAlarm', 'testBgAlarm', 'askNotifPermission']) assert.ok(!SRC.includes(f), f + ' removed');
  assert.ok(!/Notification\.requestPermission/.test(SRC) && !/vdsen_bg_alarm/.test(SRC));
  assert.ok(!/VDSEN_REST_SCHEDULE|VDSEN_REST_CANCEL|addEventListener\('message'/.test(SW), 'service worker back to caching only');
});
test('T555.10 (T556) the rest alert is the original one: vibration + beep + a notification only if the browser already granted permission', () => {
  const n = fnSrc('_notifyRestDone'); assert.ok(/Notification\.permission !== 'granted'\) return/.test(n) && /new Notification\(/.test(n));
  assert.ok(/playTimerBeep\(\)/.test(fnSrc('_restFeedback')) && /navigator\.vibrate/.test(fnSrc('_restFeedback')));
});
test('T555.11 (T556) the service worker still precaches and serves network-first (cache version bumped, no extra handlers)', () => {
  assert.ok(/const CACHE = 'vdsen-v13';/.test(SW) && /addEventListener\('fetch'/.test(SW) && /addEventListener\('install'/.test(SW));
});

// ---------------- 4. cardio ----------------
test('T555.12 (T556 closure) cardio is NEVER inferred from the exercise name: only an explicit exerciseType / tipo selects the cardio renderer', () => {
  assert.ok(!SRC.includes('_withInferredCardio') && !SRC.includes('_cardioInferred'), 'no name-based inference anywhere');
  const f = fnSrc('_getExType'), ctx = { String }; vm.createContext(ctx); vm.runInContext(f + '\nthis.f=_getExType;', ctx);
  assert.equal(ctx.f({ exerciseName: 'Cardio Zone 2', sets: S(1, 1, 4) }), 'fuerza', 'a plain Cardio-named row stays strength-shaped (plan authoring issue, not a renderer defect)');
  assert.equal(ctx.f({ exerciseName: 'Cardio Zone 2', exerciseType: 'cardio', sets: [] }), 'cardio'); assert.equal(ctx.f({ exerciseName: 'x', tipo: 'cardio' }), 'cardio');
});
test('T555.13 loadPlan passes the explicit type through and the cardio renderer exists', () => {
  assert.ok(/Object\.assign\(ex, _carryPerfPrescription\(e\)\)/.test(SRC) && /function _buildCardioCard\(/.test(SRC) && /function completeCardio\(/.test(SRC));
});
test('T555.14 an explicit cardio exercise (no sets) counts as exactly ONE series in the day total (it used to default to 3 phantom series and the day could never reach 100%)', () => {
  assert.ok(/var numSets = \(e\.sets \|\| \[\]\)\.length \|\| \(_getExType\(e\) === 'cardio' \? 1 : 3\);/.test(SRC));
});
test('T555.15 the minimized pill says what is next', () => {
  assert.ok(/#timerPill \.rt-ptxt/.test(fnSrc('_renderNextWorkoutAction')) && /'Sig: S'/.test(fnSrc('_renderNextWorkoutAction')));
});
