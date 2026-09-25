'use strict';
/**
 * T158 — Client "Hoy" execution flow.
 *
 * Scope: Client tab Hoy/Entrenamiento only — the day/exercise/set logging
 * loop (abrir -> ver qué toca hoy -> iniciar -> registrar sets -> terminar
 * sesión). No Coach/PWA/manifest/nutrition/progress changes.
 *
 * Audit: grepped completeSet/goTab/_autoAdvanceDia/_buildExCard/
 * buildBoostcampExercise and every onkeydown wiring for the set-logging
 * inputs (carga_/reps_/rir_/ics_ and their express-mode xcarga_/xreps_/
 * xics_ counterparts), since the ticket explicitly asks to preserve the
 * T082/T083 Enter/Tab convention while looking for real logging friction.
 *
 * Findings:
 *  - completeSet() (the live, single set-save handler wired to "✓ GUARDAR
 *    SERIE" everywhere) is sound: validates required fields before
 *    marking done, auto-advances to the next incomplete exercise, starts
 *    the rest timer, and is superset-aware. No double-submit/false-success
 *    issue found in its logic.
 *  - buildBoostcampExercise() DOES have a broken Enter/Tab chain (reps_'s
 *    handler jumps straight to ics_, skipping the visually-between rir_
 *    field) — but this function is dead code, never called anywhere in
 *    the file (verified via grep), so it is NOT a reproducible friction
 *    for any real user and was correctly left untouched (fixing dead code
 *    would not serve the ticket's "real, reproducible friction" bar).
 *  - The LIVE, DEFAULT set-entry path is the express-mode single-input
 *    block inside _buildExCard (isExpressMode = true unless the technique
 *    is myoreps/rest-pause/cluster or the user enabled "Modo detallado").
 *    Its Enter/Tab chain only went xcarga_ -> xreps_ (established in an
 *    earlier ticket, preserved as-is) and then STOPPED — Enter/Tab on
 *    xreps_ did nothing, even though enterkeyhint="done" implied the input
 *    sequence was finished. In reality two more fields commonly follow
 *    (ICS quality 1-10, then the PUMP buttons before "✓ COMPLETAR
 *    EJERCICIO"), so every set silently required an extra manual tap into
 *    the ICS field that the existing convention should have carried the
 *    user to automatically — real, reproducible, on-path friction matching
 *    "demasiados pasos para registrar un set" / "pérdida de foco".
 *
 * Fix (minimal, one input's attributes, same established pattern as
 * xcarga_'s existing handler): xreps_'s onkeydown now focuses xics_ on
 * Enter/Tab (extending the chain from carga->reps->ics), and its
 * enterkeyhint was updated from "done" to "next" to match the mobile
 * keyboard's now-accurate behavior. RIR is intentionally NOT part of this
 * chain (it's chip buttons, not a text field, in this express block) and
 * no new auto-submit was added on ics_ — completeSet/markExpressDone are
 * untouched, so this introduces no new double-submit surface.
 *
 * Run: node tests/t158h-hoy-set-entry-focus-chain.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix: xreps_ now completes the Enter/Tab chain to xics_ (live express path).
// ─────────────────────────────────────────────────────────────────────────────

const xrepsLineIdx = CLIENT.indexOf("id=\"xreps_'+_expK+'\"");
assert.ok(xrepsLineIdx !== -1, 'T158-H prerequisite: the xreps_ express-mode input must exist');
const xrepsLine = CLIENT.slice(xrepsLineIdx, CLIENT.indexOf('\n', xrepsLineIdx));
assert.ok(
  xrepsLine.includes('enterkeyhint="next"'),
  'T158-H: xreps_ must advertise enterkeyhint="next" now that Enter/Tab actually advances focus (was "done")'
);
assert.ok(
  xrepsLine.includes("onkeydown=\"if(event.key===\\'Enter\\'||event.key===\\'Tab\\'){event.preventDefault();var r=document.getElementById(\\'xics_'+_expK+'\\');if(r)r.focus();}\""),
  'T158-H: xreps_ (express single-set input, the live default entry path) must now focus xics_ on Enter/Tab'
);

console.log('xreps_ -> xics_ Enter/Tab chain wired (express mode) — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression: xcarga_ -> xreps_ chain (pre-existing, T082/T083 convention)
// must remain exactly as it was.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  CLIENT.includes("onkeydown=\"if(event.key===\\'Enter\\'||event.key===\\'Tab\\'){event.preventDefault();var r=document.getElementById(\\'xreps_'+_expK+'\\');if(r)r.focus();}\">"),
  'T158-H regression: xcarga_ -> xreps_ Enter/Tab handler must remain unchanged'
);

console.log('xcarga_ -> xreps_ Enter/Tab chain (pre-existing) unchanged — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression: dead code (buildBoostcampExercise) intentionally left
// untouched — confirms it is still unreachable, so no user-facing
// behavior depends on it, and it was correctly not "fixed" as if live.
// ─────────────────────────────────────────────────────────────────────────────

const callSites = CLIENT.split('buildBoostcampExercise').length - 1;
assert.strictEqual(callSites, 1, 'T158-H: buildBoostcampExercise must still be dead code (exactly one occurrence: its own definition, never called)');

console.log('buildBoostcampExercise confirmed still dead code — correctly left untouched — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression: completeSet's core contract is untouched — no new
// double-submit surface, validation, auto-advance, and rest-timer logic
// all intact.
// ─────────────────────────────────────────────────────────────────────────────

const completeSetFn = extractFunction(CLIENT, 'async function completeSet(key, di, ei, si, unit)');
assert.ok(completeSetFn, 'completeSet must exist unchanged');
assert.ok(completeSetFn.includes('if (prev.done) return;'), 'T158-H regression: repeated save events are idempotent; corrections use editSet()');
assert.ok(completeSetFn.includes("showToast('Ingresa la carga (> 0)', true); return;"), 'T158-H regression: required-field validation (carga) must remain unchanged');
assert.ok(completeSetFn.includes('_isExerciseFullyDone(di, ei, _ejForAdv)'), 'T158-H regression: auto-advance-to-next-exercise logic must remain unchanged');
assert.ok(completeSetFn.includes('startRestTimer(restTime, key);'), 'T158-H regression: rest timer trigger must remain unchanged');

console.log('completeSet() core contract (idempotency, validation, auto-advance, rest timer) unchanged — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression: session resume / next-set / last-set-into-next-exercise /
// last-exercise-into-finish plumbing untouched.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(CLIENT.includes('function _autoAdvanceDia()'), 'T158-H regression: _autoAdvanceDia (resumes session at the right pending day) must remain');
assert.ok(CLIENT.includes('function _isExerciseFullyDone(di, ei, ej)'), 'T158-H regression: _isExerciseFullyDone (drives last-set -> next-exercise) must remain');
assert.ok(CLIENT.includes('function _resolveNextWorkoutAction'), 'T158-H regression: _resolveNextWorkoutAction (drives last-exercise -> session finish) must remain');
assert.ok(CLIENT.includes('function goTab(i)') && CLIENT.includes('renderEntrenamiento();'), 'T158-H regression: goTab/renderEntrenamiento wiring for the Entreno tab must remain');

console.log('Session resume / set advance / exercise advance / finish plumbing unchanged — OK');

console.log('');
console.log('T158 — Client "Hoy" execution flow: ALL ASSERTIONS PASSED');
