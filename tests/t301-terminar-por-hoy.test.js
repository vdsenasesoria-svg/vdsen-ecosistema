'use strict';
/**
 * T301 — "TERMINAR POR HOY": per-session intentional partial closure.
 *
 * Verifies the exact confirmation copy/buttons, that _endSessionAsPartial
 * never fabricates missing sets, freezes duration via the existing done_.ts
 * mechanism (no new timer code needed), guards double-click and stale
 * week-context, never shows false success on a failed write, and that the
 * new PARTIAL state feeds progression (real sets only) same as the existing
 * AUTO_CLOSED path already does.
 *
 * Run: node tests/t301-terminar-por-hoy.test.js
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

const endSessionSrc = extractFunction(CLIENT, 'async function _endSessionAsPartial(di) {');
const askConfirmPartialSrc = extractFunction(CLIENT, 'function _askConfirmPartial(msg) {');

// ── Exact confirmation copy + button labels the ticket specifies. ──────────
ok(endSessionSrc.includes("'Completaste ' + completedSets + ' de ' + totalSets + ' series. Se conservará todo lo realizado. ' +"),
  'confirmation message uses the exact required copy (completed/total series + "se conservará todo lo realizado")');
ok(endSessionSrc.includes("'La sesión quedará registrada como parcial y podrás continuar con tu programa.'"),
  'confirmation message includes the exact required closing sentence');
ok(askConfirmPartialSrc.includes('>CANCELAR<'), 'dialog has the exact CANCELAR button label');
ok(askConfirmPartialSrc.includes('>GUARDAR COMO PARCIAL<'), 'dialog has the exact GUARDAR COMO PARCIAL button label');

// ── Never fabricate: only writes done_/postsession_/progrec_ -- never
// touches any log_ set key (no invented sets/load/reps/RIR). ───────────────
ok(!/LOGS\['log_/.test(endSessionSrc), '_endSessionAsPartial never writes to any log_ (set) key -- real sets are the only source of truth, nothing is fabricated');
ok(endSessionSrc.includes("if (completedSets === 0) {"), 'refuses to create a PARTIAL closure when there is zero real execution (genuine PARTIAL only, never a disguised fabricated one)');

// ── Sets the F76/T300 partial flag on the SAME done_{w}_{d} document shape
// -- no new collection, no schema migration. ────────────────────────────────
ok(endSessionSrc.includes("LOGS[key] = { ts: Date.now(), partial: true };"), 'writes done_{w}_{d} = {ts, partial:true} -- reuses the existing document shape');

// ── Progression uses only real sets (calculateProgression already excludes
// autoFilled internally -- confirmed by T300's audit of the shared helpers). ──
ok(endSessionSrc.includes('calculateProgression(di, LOGS[postKey])'), 'feeds the same calculateProgression path used by the existing (already-audited) AUTO_CLOSED flow -- autoFilled sets are already excluded inside it');

// ── Double-click guard + stale week-context guard (T127-H pattern), locked
// BEFORE the confirm dialog opens (not just before the write). ─────────────
ok(endSessionSrc.includes('if (_markSessionBusy[di]) return;'), 'double-tap guard checked synchronously at entry');
ok(endSessionSrc.indexOf('_markSessionBusy[di] = true;') < endSessionSrc.indexOf('_askConfirmPartial('),
  'busy flag is set BEFORE the confirm dialog opens -- a second tap while the dialog is open cannot open a duplicate dialog');
ok(endSessionSrc.includes('if (weekAtStart !== CURRENT_WEEK) { _markSessionBusy[di] = false; return; }'),
  'T127-H: re-checks week identity after the confirm-dialog await before mutating LOGS');
ok(endSessionSrc.includes("if (LOGS['done_'+CURRENT_WEEK+'_'+di]) { _markSessionBusy[di] = false; showToast('Esta sesión ya está cerrada', true); return; }\n\n  var key"),
  'also re-checks the session was not closed by another path (e.g. skipSession) while the dialog was open');

// ── No false success on a failed write -- reverts done_/postsession_/progrec_
// and shows a real, non-fabricated error. ───────────────────────────────────
ok(endSessionSrc.includes('if (ok === false) {') && endSessionSrc.includes("delete LOGS[key];"),
  'a failed _doSaveLogs() reverts the PARTIAL done_ entry -- never leaves a locally-mutated state that looks saved but is not');
ok(!/if \(ok === false\)[\s\S]{0,400}showToast\('✓/.test(endSessionSrc), 'the failure branch never shows a success toast');

// ── Duration freeze reuses the EXISTING done_.ts -> _sesTimerEnd mechanism
// (already audited/hardened in T299) -- no new timer code was needed. ──────
ok(CLIENT.includes("window._sesTimerEnd = (_sesDoneEntry && _sesDoneEntry.ts) ? _sesDoneEntry.ts : null;"),
  'the existing done_.ts freeze mechanism applies automatically to a PARTIAL close -- {ts, partial:true} has a ts, so duration freezes safely with no new code');

console.log('');
console.log('T301 — Terminar por hoy: ' + pass + ' assertions PASSED');
