'use strict';
/**
 * T318 — Check-in lifecycle & Home surfacing.
 *
 * Closes T315's FINDING 1 (the real bug) and the check-in half of
 * FINDING 3, and fixes a broader Home correctness gap this phase's own
 * "correct week" / "OLD CHECK-IN -> historical only, not current"
 * requirements surfaced: renderResumen() used CURRENT_WEEK (a view-mode
 * variable that can be left pointed at a past week after navigating there
 * from Entrenamiento's week grid) instead of REAL_WEEK (the client's
 * actual current week) -- meaning Home's ENTIRE surface (HOY card, week
 * grid "ACTIVA" label, stat-row, check-in card, day chips, stale banner)
 * could silently render a stale past week as if it were current. Fixed by
 * resetting CURRENT_WEEK = REAL_WEEK at the top of renderResumen(), exactly
 * mirroring the same reset goTab(1) already does for Entrenamiento.
 *
 * DUE/NOT_DUE: this app has no per-day check-in due-date data, only a
 * week-level ci_sem_{week} entry -- so "due" and "not due yet" cannot be
 * honestly distinguished without inventing a new stored state, which this
 * ticket explicitly forbids. The existing PENDIENTE/COMPLETADO binary
 * (backed by real ci.peso/ci.hrv presence) is the truthful representation
 * available; STALE/OLD is already correctly scoped to the historial widget
 * (which labels every past week's check-in by its own week number), never
 * conflated with Home's own (now REAL_WEEK-correct) current-week card.
 *
 * Run: node tests/t318-checkin-lifecycle-home-surfacing.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) throw new Error('not found: ' + decl);
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  throw new Error('unbalanced braces: ' + decl);
}

// ── FINDING 1 RESOLVED: guardarCI no longer awaits the fire-and-forget
// saveLogs() -- real await + real success gate, same contract as every
// other terminal action in this file. ──────────────────────────────────────
const guardarCISrc = extractFunction(CLIENT, 'async function guardarCI() {');
ok(!guardarCISrc.includes('await saveLogs();'), 'FINDING 1 RESOLVED: guardarCI() no longer calls the fire-and-forget saveLogs()');
ok(guardarCISrc.includes('var _ciOk = await _doSaveLogs();') && guardarCISrc.includes("if (_ciOk === false) {"),
  'FINDING 1 RESOLVED: guardarCI() now awaits the real _doSaveLogs() and gates its success path on the real boolean result');
ok(guardarCISrc.includes("showToast('⚠ NO SE GUARDÓ"), 'a failed check-in write now shows a real, honest error -- never the previous unconditional success toast');

// ── FINDING 3 (check-in half) RESOLVED: stale-client-context guard. ────────
ok(guardarCISrc.includes('var _uidAtStart = USER && USER.uid;'), 'FINDING 3 RESOLVED (check-in): captures client identity before the await');
ok(guardarCISrc.includes('if (!USER || USER.uid !== _uidAtStart) return;'), 'FINDING 3 RESOLVED (check-in): re-checks identity after the await, same T127-H pattern as nutrition (T317)');

// ── Pre-existing correctness preserved (not reimplemented). ────────────────
ok(guardarCISrc.includes('if (_guardarCIInFlight) return;') && guardarCISrc.includes('_guardarCIInFlight = true;'),
  'the existing double-submit guard is preserved untouched');
ok(guardarCISrc.includes("await FB.setDoc(histDocRef, checkinDoc);"), 'the expedientes/historial sync write (already correctly awaited) is preserved');

// ── Home week-correctness fix: renderResumen always reflects REAL_WEEK. ───
const renderResumenSrc = extractFunction(CLIENT, 'function renderResumen() {');
ok(renderResumenSrc.indexOf('CURRENT_WEEK = REAL_WEEK;') < renderResumenSrc.indexOf('const semActiva = CURRENT_WEEK;'),
  'renderResumen resets CURRENT_WEEK to REAL_WEEK BEFORE computing semActiva -- Home can never render a stale past week as if it were current');
ok(renderResumenSrc.indexOf('CURRENT_WEEK = REAL_WEEK;') < renderResumenSrc.indexOf("LOGS['ci_sem_'+semActiva]"),
  'the check-in card specifically now always reads the REAL current week\'s ci_sem_ entry, never a leftover view-mode week');

// ── markSessionDone's reopen path gets the same false-success fix (same
// root-cause bug class, fixed together while it was fresh). ────────────────
const markSessionDoneSrc = extractFunction(CLIENT, 'async function markSessionDone(di) {');
ok(markSessionDoneSrc.includes('var _reopenOk = await _doSaveLogs();') && markSessionDoneSrc.includes("if (_reopenOk === false) {"),
  'markSessionDone\'s reopen (toggle-off) path also now awaits the real write before showing "Marcado como pendiente"');

console.log('');
console.log('T318 — Check-in lifecycle & Home surfacing: ' + pass + ' assertions PASSED. FINDING 1 and FINDING 3 (T315) fully closed.');
