/**
 * VDSEN — Client Today Test Suite (F19)
 * Tests CTDY1-CTDY12 — topology-aware session state resolver
 *
 * Run: node tests/client-today.test.js
 */

// ─────────────────────────── STUBS ───────────────────────────
var _CLIENT_TOPO_META = {
  'TWO_ON_ONE_OFF':   { tpc: 2 },
  'THREE_ON_ONE_OFF': { tpc: 3 },
  'FOUR_ON_ONE_OFF':  { tpc: 4 },
  'FIVE_ON_TWO_OFF':  { tpc: 5 },
};

function _getSessionCompletionState(doneEntry) {
  if (!doneEntry) return 'PENDING';
  if (typeof doneEntry !== 'object') return 'REAL_COMPLETE';
  if (doneEntry.skipped && !doneEntry.autoClosed) return 'SKIPPED';
  if (doneEntry.autoClosed && doneEntry.skipped) return 'AUTO_CLOSED_NO_DATA';
  if (doneEntry.autoClosed) return 'AUTO_CLOSED';
  return 'REAL_COMPLETE';
}

function _isRealExecution(doneEntry) {
  var s = _getSessionCompletionState(doneEntry);
  return s === 'REAL_COMPLETE' || s === 'AUTO_CLOSED';
}

// ─── Functions under test (inline, mirrors vdsen-cliente.html) ───────────────
function _countDoneSessionsFromLogs(logs) {
  var fullyDone = 0;
  Object.keys(logs).forEach(function(k) {
    if (!/^done_\d+_\d+$/.test(k)) return;
    if (_isRealExecution(logs[k])) fullyDone++;
  });
  return { fullyDone: fullyDone };
}

function _resolveTodayState(topology, logs, sesiones) {
  var totalSessions = sesiones.length;
  if (!totalSessions) return { state: 'NO_ACTIVE_PLAN' };

  var counted = _countDoneSessionsFromLogs(logs);
  var fullyDone = counted.fullyDone;

  if (fullyDone >= totalSessions) {
    return { state: 'REST_TODAY', isEndOfMesocycle: true, fullyDone: fullyDone };
  }

  var meta = _CLIENT_TOPO_META[topology];
  if (!meta) {
    return { state: 'TRAIN_TODAY', sessionIdx: fullyDone, sesion: sesiones[fullyDone] };
  }

  var tpc = meta.tpc;
  if (fullyDone > 0 && fullyDone % tpc === 0) {
    return { state: 'REST_TODAY', isEndOfMesocycle: false, fullyDone: fullyDone };
  }

  return { state: 'TRAIN_TODAY', sessionIdx: fullyDone, sesion: sesiones[fullyDone] };
}

// ─────────────────────────── HARNESS ──────────────────────────
var _pass = 0, _fail = 0, _errors = [];

function assert(id, desc, condition) {
  if (condition) {
    _pass++;
    console.log('  ✓ ' + id + ' ' + desc);
  } else {
    _fail++;
    _errors.push(id + ': ' + desc);
    console.log('  ✗ ' + id + ' ' + desc);
  }
}

// ─────────────────────────── FIXTURES ─────────────────────────
// 6 sessions — TWO_ON_ONE_OFF cycle: D1,D2,REST,D3,D4,REST,D5,D6,REST
var AYRTON_SESIONES = [
  { dia: 'D1 PUSH' },
  { dia: 'D2 PULL' },
  { dia: 'D3 LEGS A' },
  { dia: 'D4 PUSH B' },
  { dia: 'D5 PULL B' },
  { dia: 'D6 FULL' },
];
var TOPO = 'TWO_ON_ONE_OFF';

function makeLogs(fullyDoneCount) {
  var logs = {};
  for (var i = 0; i < fullyDoneCount; i++) {
    logs['done_1_' + i] = { ts: 1000 + i };
  }
  return logs;
}

// ─────────────────────────── SUITE CTDY ───────────────────────
console.log('\n── SUITE CTDY — Client Today (F19) ────────────────────────');

// ── _countDoneSessionsFromLogs ────────────────────────────────

(function() {
  console.log('\n  [_countDoneSessionsFromLogs]');

  var empty = {};
  assert('CTDY1', 'empty logs → fullyDone=0', _countDoneSessionsFromLogs(empty).fullyDone === 0);

  var two = { 'done_1_0': { ts: 1 }, 'done_1_1': { ts: 2 } };
  assert('CTDY2', 'two real entries → fullyDone=2', _countDoneSessionsFromLogs(two).fullyDone === 2);

  var withNoise = { 'done_1_0': { ts: 1 }, 'log_1_0_0_s0': { carga: '80' }, 'done_1_1': { ts: 2 } };
  assert('CTDY3', 'ignores non-done_ keys', _countDoneSessionsFromLogs(withNoise).fullyDone === 2);

  var skipped = { 'done_1_0': { ts: 1, skipped: true } };
  assert('CTDY4', 'skipped entry not counted as fullyDone', _countDoneSessionsFromLogs(skipped).fullyDone === 0);

  var legacy = { 'done_1_0': true, 'done_2_1': true };
  assert('CTDY5', 'legacy boolean entries count as fullyDone', _countDoneSessionsFromLogs(legacy).fullyDone === 2);

  var crossWeek = { 'done_1_0': { ts: 1 }, 'done_1_1': { ts: 2 }, 'done_2_0': { ts: 3 } };
  assert('CTDY6', 'cross-week entries counted', _countDoneSessionsFromLogs(crossWeek).fullyDone === 3);
})();

// ── _resolveTodayState: TWO_ON_ONE_OFF cycle ──────────────────

(function() {
  console.log('\n  [_resolveTodayState — TWO_ON_ONE_OFF cycle Ayrton]');

  // D1: no sessions done → TRAIN D0
  var r0 = _resolveTodayState(TOPO, {}, AYRTON_SESIONES);
  assert('CTDY7', 'fullyDone=0 → TRAIN_TODAY', r0.state === 'TRAIN_TODAY');
  assert('CTDY8', 'fullyDone=0 → sessionIdx=0', r0.sessionIdx === 0);
  assert('CTDY9', 'fullyDone=0 → sesion is D1', r0.sesion.dia === 'D1 PUSH');

  // D2: 1 done → TRAIN D1
  var r1 = _resolveTodayState(TOPO, makeLogs(1), AYRTON_SESIONES);
  assert('CTDY10', 'fullyDone=1 → TRAIN_TODAY', r1.state === 'TRAIN_TODAY');
  assert('CTDY11', 'fullyDone=1 → sessionIdx=1', r1.sessionIdx === 1);
  assert('CTDY12', 'fullyDone=1 → sesion is D2', r1.sesion.dia === 'D2 PULL');

  // REST after D1+D2: 2 done → REST (cycle boundary)
  var r2 = _resolveTodayState(TOPO, makeLogs(2), AYRTON_SESIONES);
  assert('CTDY13', 'fullyDone=2 → REST_TODAY', r2.state === 'REST_TODAY');
  assert('CTDY14', 'fullyDone=2 → isEndOfMesocycle=false', r2.isEndOfMesocycle === false);

  // D3: 3 done → TRAIN D2 (after rest)
  var r3 = _resolveTodayState(TOPO, makeLogs(3), AYRTON_SESIONES);
  assert('CTDY15', 'fullyDone=3 → TRAIN_TODAY', r3.state === 'TRAIN_TODAY');
  assert('CTDY16', 'fullyDone=3 → sessionIdx=3', r3.sessionIdx === 3);
  assert('CTDY17', 'fullyDone=3 → sesion is D4', r3.sesion.dia === 'D4 PUSH B');

  // REST after D3+D4: 4 done → REST
  var r4 = _resolveTodayState(TOPO, makeLogs(4), AYRTON_SESIONES);
  assert('CTDY18', 'fullyDone=4 → REST_TODAY', r4.state === 'REST_TODAY');
  assert('CTDY19', 'fullyDone=4 → isEndOfMesocycle=false', r4.isEndOfMesocycle === false);

  // D5: 5 done → TRAIN D4
  var r5 = _resolveTodayState(TOPO, makeLogs(5), AYRTON_SESIONES);
  assert('CTDY20', 'fullyDone=5 → TRAIN_TODAY', r5.state === 'TRAIN_TODAY');
  assert('CTDY21', 'fullyDone=5 → sesion is D6', r5.sesion.dia === 'D6 FULL');

  // End of mesocycle: all 6 done → REST + isEndOfMesocycle
  var r6 = _resolveTodayState(TOPO, makeLogs(6), AYRTON_SESIONES);
  assert('CTDY22', 'fullyDone=6 → REST_TODAY', r6.state === 'REST_TODAY');
  assert('CTDY23', 'fullyDone=6 → isEndOfMesocycle=true', r6.isEndOfMesocycle === true);
})();

// ── Edge cases ────────────────────────────────────────────────

(function() {
  console.log('\n  [_resolveTodayState — edge cases]');

  // Empty sesiones → NO_ACTIVE_PLAN
  var rEmpty = _resolveTodayState(TOPO, {}, []);
  assert('CTDY24', 'empty sesiones → NO_ACTIVE_PLAN', rEmpty.state === 'NO_ACTIVE_PLAN');

  // No topology (linear plan) → always TRAIN_TODAY with correct sessionIdx
  var rLinear = _resolveTodayState(null, makeLogs(2), AYRTON_SESIONES);
  assert('CTDY25', 'null topology → TRAIN_TODAY (linear)', rLinear.state === 'TRAIN_TODAY');
  assert('CTDY26', 'null topology → sessionIdx follows fullyDone', rLinear.sessionIdx === 2);

  // Unknown topology string → treated as linear
  var rUnknown = _resolveTodayState('UNKNOWN_TOPO', makeLogs(2), AYRTON_SESIONES);
  assert('CTDY27', 'unknown topology → linear fallback', rUnknown.state === 'TRAIN_TODAY');

  // THREE_ON_ONE_OFF: rest after 3
  var shortSes = [{ dia: 'D1' }, { dia: 'D2' }, { dia: 'D3' }, { dia: 'D4' }];
  var r3on = _resolveTodayState('THREE_ON_ONE_OFF', makeLogs(3), shortSes);
  assert('CTDY28', 'THREE_ON_ONE_OFF: fullyDone=3 → REST_TODAY', r3on.state === 'REST_TODAY');
})();

// ─────────────────────────── RESULT ───────────────────────────
console.log('\n── RESULT ──────────────────────────────────────────────────');
console.log('  ' + _pass + ' ✓   ' + _fail + ' ✗');
if (_errors.length) {
  console.log('\n  FAILURES:');
  _errors.forEach(function(e) { console.log('    • ' + e); });
}
console.log('');

process.exit(_fail > 0 ? 1 : 0);
