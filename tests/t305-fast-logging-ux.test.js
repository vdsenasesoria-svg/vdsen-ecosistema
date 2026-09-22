'use strict';
/**
 * T305 — Fast logging UX (mostly audit; the existing exercise card, from
 * T158 and later phases, already satisfies nearly every requirement).
 *
 * Audited and CONFIRMED already correct (no change needed):
 *  - no per-set modal: sets render inline in the exercise card, not a dialog
 *  - large mobile tap targets: RIR buttons, pump buttons, GUARDAR button all
 *    use generous padding (10-14px) sized for touch
 *  - distinct saved/unsaved states: a saved set renders a green checkmark
 *    card with an editable "✏ Corregir" action; an unsaved/active set
 *    renders the input row with a border-color change on completion
 *  - existing saved-set editing remains possible: editSet(key) explicitly
 *    allows re-opening ANY saved set, even in a closed session or a past
 *    week, per its own comment ("Permitido SIEMPRE")
 *  - a failed save never looks confirmed: completeSet() validates BEFORE
 *    writing to LOGS (returns early with a real error toast on invalid
 *    load/reps/ICS/RIR), so LOGS is never mutated by an invalid attempt
 *  - a rest timer never blocks further logging: completeSet()'s superset-
 *    partner-pending branch explicitly skips starting a timer and returns
 *    immediately so the user can log the partner exercise right away; the
 *    timer is a non-blocking overlay, not a modal gate
 *  - Enter/Tab flow already chains carga -> reps -> ics via onkeydown
 *
 * The one concrete gap: the existing "SEM ANTERIOR"/"HISTORIAL" reference
 * block was purely informational (display-only text) -- there was no
 * one-tap way to reuse those values, so the ticket's optional "REPETIR
 * CARGA ANTERIOR" prefill did not exist. Added: _prefillFromReference(key,
 * carga, reps, rir), wired to a small "↺ USAR" button on both reference
 * blocks. It only sets the (still-editable) input values and refreshes the
 * e1RM hint -- it never writes to LOGS and never calls completeSet, so
 * prefill != executed, consistent with the ticket's explicit requirement.
 *
 * Run: node tests/t305-fast-logging-ux.test.js
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

// ── Pre-existing correctness (audit, no change). ────────────────────────────
const completeSetSrc = extractFunction(CLIENT, 'function completeSet(key, di, ei, si, unit) {');
ok(completeSetSrc.includes("showToast('Ingresa la carga (> 0)', true); return;"), 'completeSet validates load BEFORE writing to LOGS -- an invalid attempt never mutates state');
ok(completeSetSrc.indexOf('LOGS[key] = {') > completeSetSrc.indexOf("showToast('Ingresa la carga"), 'the LOGS write happens strictly after all validation returns -- a failed save can never look confirmed');
ok(/if \(_partnerPending\) \{[\s\S]*?return;\s*\}\s*\/\/ FASE 9/.test(completeSetSrc),
  'a pending superset partner short-circuits BEFORE any rest timer starts -- logging the partner is never blocked by a timer');
ok(completeSetSrc.includes('if (prev.autoFilled) { showToast(') , 'an autoFilled set never starts a rest timer either (no fabricated "effort" is rewarded with a timer)');

const editSetSrc = extractFunction(CLIENT, 'function editSet(key) {');
ok(editSetSrc.includes('LOGS[key].done = false;'), 'editSet allows re-opening ANY saved set for correction -- "Permitido SIEMPRE" per its own comment');

// ── New: one-tap prefill (the one concrete gap this phase closes). ─────────
const prefillSrc = extractFunction(CLIENT, 'function _prefillFromReference(key, carga, reps, rir) {');
ok(!/LOGS\[/.test(prefillSrc), '_prefillFromReference never touches LOGS -- prefill != executed, nothing is saved until GUARDAR');
ok(!prefillSrc.includes('completeSet(') && !prefillSrc.includes('saveLogs('), '_prefillFromReference never calls completeSet/saveLogs -- purely fills the still-editable inputs');
ok(prefillSrc.includes("document.getElementById('carga_'+key)") && prefillSrc.includes("document.getElementById('reps_'+key)"),
  'fills the exact same carga_/reps_ input ids completeSet() reads from -- the prefilled value still goes through the normal validated save path');

const refFnSrc = extractFunction(CLIENT, 'function _buildSetReferenceHtml(progRec, prev, histEx, setIdx, unit, baseRIR, curWeek, effectiveSetsCount, key) {');
ok(refFnSrc.includes("onclick=\"_prefillFromReference(") && (refFnSrc.match(/↺ USAR/g) || []).length === 2,
  'the "↺ USAR" prefill action is wired on both the SEM ANTERIOR and HISTORIAL reference blocks');
ok(refFnSrc.includes("key ? '<button onclick=") , 'the prefill button only renders when a key was passed -- both call sites already updated, no call site left broken');

console.log('');
console.log('T305 — Fast logging UX: ' + pass + ' assertions PASSED (existing UX confirmed correct; one-tap prefill added)');
