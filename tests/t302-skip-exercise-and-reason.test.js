'use strict';
/**
 * T302 — SKIP EXERCISE + optional skip reason (TIME/EQUIPMENT/PAIN/OTHER).
 *
 * skipExercise(di, ei, reason): reuses the existing logs/{uid} document (a
 * new exskip_{week}_{di}_{ei} key, same pattern as exmod_/exnote_/
 * readiness_ -- no new collection, no schema migration). Never fabricates a
 * log_ set entry, so it can never be counted as real execution by
 * _sessionHasRealLoggedSets/_calcSessionStats/progression -- only
 * _isExerciseFullyDone treats it as "resolved" so the UI can move on.
 *
 * skipSession(di, reason): same reason contract, stored on the existing
 * done_{week}_{di} shape (LOGS[key].reason) alongside the pre-existing
 * skipped:true flag -- fully backward compatible (reason is optional and
 * ignored by every existing reader).
 *
 * _pickSkipReason(): one-tap reason picker, explicitly not a questionnaire
 * (4 buttons + "omit without a reason" + cancel). Cancelling aborts the
 * skip entirely in both _skipSessionWithReason and _skipExerciseWithReason.
 *
 * PAIN reason: kept as a client-visible safety nudge ("avisale a tu coach")
 * on both skip paths; NOT wired into the coach-side Monitor UI, since that
 * would require touching Coach app presentation, which this ticket
 * explicitly puts out of scope. Documented, not a defect.
 *
 * Run: node tests/t302-skip-exercise-and-reason.test.js
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

// ── skipExercise: never fabricates a set, reuses the existing document. ────
const skipExerciseSrc = extractFunction(CLIENT, 'async function skipExercise(di, ei, reason) {');
ok(!/LOGS\['log_/.test(skipExerciseSrc), 'skipExercise never writes any log_ (set) key -- no fabricated sets/load/reps/RIR');
ok(skipExerciseSrc.includes("var key = 'exskip_'+CURRENT_WEEK+'_'+di+'_'+ei;"), 'reuses the existing logs/{uid} document via a new exskip_ key -- same pattern as exmod_/exnote_/readiness_, no new collection');
ok(skipExerciseSrc.includes("['TIME','EQUIPMENT','PAIN','OTHER'].indexOf(reason) !== -1"), 'reason is restricted to exactly the 4 allowed codes -- never a free-text questionnaire field');
ok(skipExerciseSrc.includes('if (ok === false) {') && skipExerciseSrc.includes('delete LOGS[key];'), 'a failed write reverts the exskip_ entry -- no false success');
ok(!skipExerciseSrc.includes('calculateProgression'), 'skipExercise never calls calculateProgression -- no fabricated progression evidence for a skipped exercise');

// ── _isExerciseFullyDone treats an exskip_ entry as resolved (never blocks
// moving on) without ever touching the real-execution detectors. ───────────
const fullyDoneSrc = extractFunction(CLIENT, 'function _isExerciseFullyDone(di, ei, ej) {');
ok(fullyDoneSrc.indexOf("LOGS['exskip_'") < fullyDoneSrc.indexOf('var t = _getExType'), '_isExerciseFullyDone checks exskip_ first, before any real-execution logic -- a skipped exercise never blocks session navigation');
ok(!CLIENT.includes("if (LOGS['exskip_") || !/_sessionHasRealLoggedSets[\s\S]{0,300}exskip_/.test(CLIENT), '_sessionHasRealLoggedSets (the IN_PROGRESS detector) never reads exskip_ -- an exercise skip can never masquerade as real set execution');

// ── skipSession: same reason contract, additive to the existing done_ shape. ──
const skipSessionSrc = extractFunction(CLIENT, 'async function skipSession(di, reason) {');
ok(skipSessionSrc.includes("if (reason && ['TIME','EQUIPMENT','PAIN','OTHER'].indexOf(reason) !== -1) entry.reason = reason;"), 'skipSession accepts the same 4 optional reason codes');
ok(skipSessionSrc.includes('skipped: true'), 'skipSession still sets skipped:true -- fully backward compatible with the existing SKIPPED lifecycle resolution (T300)');
ok(skipSessionSrc.includes("reason === 'PAIN'") && skipSessionSrc.includes('avisale a tu coach'), 'a PAIN reason keeps a client-visible safety nudge on the session skip path');

// ── Reason picker: exactly 4 codes, explicit cancel path, not a questionnaire. ──
const pickReasonSrc = extractFunction(CLIENT, 'function _pickSkipReason(title) {');
ok((pickReasonSrc.match(/code: '(TIME|EQUIPMENT|PAIN|OTHER)'/g) || []).length === 4, 'exactly the 4 required reason codes are offered, one tap each');
ok(pickReasonSrc.includes("done('');") && pickReasonSrc.includes('done(null);'), 'the picker distinguishes "skip with no reason" (empty string) from "cancel the skip entirely" (null)');

// ── Both UI entry points respect the cancel-aborts-the-skip contract. ──────
const skipSessionWithReasonSrc = extractFunction(CLIENT, 'async function _skipSessionWithReason(di) {');
ok(skipSessionWithReasonSrc.includes('if (reason === null) return;'), '_skipSessionWithReason aborts the whole skip when the picker is cancelled -- no skip without this resolving');
const skipExerciseWithReasonSrc = extractFunction(CLIENT, 'async function _skipExerciseWithReason(di, ei) {');
ok(skipExerciseWithReasonSrc.includes('if (reason === null) return;'), '_skipExerciseWithReason aborts the whole skip when the picker is cancelled');

// ── UI wiring: the session header "Saltar" button and the exercise card
// both go through the reason picker, not the bare functions directly. ──────
ok(CLIENT.includes('onclick="_skipSessionWithReason(\'+DIA_ACTIVO+\')"'), 'the session "⏸ Saltar" button now goes through the reason picker');
ok(CLIENT.includes("onclick=\"_skipExerciseWithReason('+di+','+ei+')\""), 'the exercise card exposes a "⏭ Omitir ejercicio" action wired to the reason picker');
ok(CLIENT.includes("? '<div style=\"margin-top:6px;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:7px;background:rgba(107,107,102,.08);border:1px solid rgba(107,107,102,.25);font-size:10px;color:var(--mt);font-weight:700\">⏸ Ejercicio omitido</div>'"),
  'a skipped exercise renders its own honest "⏸ Ejercicio omitido" status, never disguised as completed');

console.log('');
console.log('T302 — Skip exercise + reason: ' + pass + ' assertions PASSED');
console.log('Documented scope note: PAIN is surfaced to the client only (a toast nudge to contact the coach).');
console.log('Wiring it into the Coach-side Monitor UI is out of this ticket\'s scope (Coach presentation is explicitly excluded).');
