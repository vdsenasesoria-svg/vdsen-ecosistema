'use strict';
/**
 * T315 — Client daily-loop contract audit (audit-only; fixes land in
 * T316-T321 per the phase order, not here).
 *
 * Trace: HOME -> TRAINING -> NUTRITION -> CHECK-IN -> PROGRESS -> HOME.
 *
 * ── SCREEN MAP ────────────────────────────────────────────────────────────
 *
 * HOME (renderResumen, tab 0)
 *   ENTRY: goTab(0), or default on load
 *   PRIMARY ACTION: _getTodayHomeState-driven CTA (T308-T314)
 *   PERSISTENCE: read-only (LOGS/PLAN already loaded)
 *   SUCCESS/ERROR SIGNAL: n/a (no writes from Home itself)
 *   EMPTY STATE: no sessions -> generic "VER ENTRENAMIENTO" fallback
 *   RETURN PATH: n/a (this IS the return path for every other tab)
 *   KNOWN DUPLICATION: none (T307-T314 already resolved this)
 *
 * TRAINING (renderEntrenamiento, tab 1)
 *   ENTRY: goTab(1) (unconditionally re-renders, per goTab's own switch)
 *   PRIMARY ACTION: completeSet/markSessionDone/_endSessionAsPartial/
 *     skipSession/skipExercise (all already audited/hardened T291-T306)
 *   PERSISTENCE: _doSaveLogs() bypass on every terminal action; debounced
 *     saveLogs() on per-set input
 *   SUCCESS/ERROR SIGNAL: real (awaited, revert-on-failure) on every
 *     terminal action; already audited
 *   EMPTY STATE: no sesiones -> "Sin entrenamiento"
 *   RETURN PATH: _goToHomeDay-style navigation back to tab 0 already exists
 *   KNOWN DUPLICATION: none new
 *
 * NUTRITION (renderNutricion, tab 2 / buildNutriLogWidget / guardarNutriLog)
 *   ENTRY: goTab(2) (unconditional re-render)
 *   PRIMARY ACTION: guardarNutriLog() -- per-date key `nutrilog_{YYYY-MM-DD}`
 *   PERSISTENCE: _doSaveLogs() bypass (T126-C, already correct)
 *   SUCCESS/ERROR SIGNAL: real (`_ok === false` gates the toast) -- correct
 *   EMPTY STATE: 7-day adherence widget shows a real empty-state message
 *   RETURN PATH: via bottom nav / goTab(0)
 *   KNOWN DUPLICATION: none
 *   RISK (P2): no input validation before write (any string incl. negative
 *     numbers is accepted); no stale-client-context guard after its own
 *     await (the T127-H pattern used elsewhere in this file is absent here)
 *
 * CHECK-IN (renderCheckin, tab 3 / guardarCI)
 *   ENTRY: goTab(3) (unconditional re-render)
 *   PRIMARY ACTION: guardarCI() -- per-week key `ci_sem_{week}`
 *   PERSISTENCE: `await saveLogs();` -- ***BUG***
 *   SUCCESS/ERROR SIGNAL: ***FALSE SUCCESS*** (see FINDING 1)
 *   EMPTY STATE: n/a (form always renders)
 *   RETURN PATH: renderResumen() called directly on success
 *   KNOWN DUPLICATION: none
 *   RISK (P1): see FINDING 1 below
 *
 * PROGRESS (folded into renderPerfil, tab 4: _buildWeightSparkline +
 *   buildHistorialWidget's check-in trends + per-exercise strength history)
 *   ENTRY: goTab(4) (unconditional re-render)
 *   PRIMARY ACTION: read-only (data entered via CHECK-IN, not here)
 *   PERSISTENCE: n/a
 *   SUCCESS/ERROR SIGNAL: n/a
 *   EMPTY STATE: correctly gated -- a single InBody/weight data point never
 *     fabricates a directional trend (buildHistorialWidget's loadDelta is
 *     honestly 0 with exactly one data point; _buildWeightSparkline plots
 *     a real single dot, never an invented line)
 *   RETURN PATH: bottom nav
 *   KNOWN DUPLICATION: none
 *   RISK: none found -- already correct
 *
 * ── FINDINGS (max 5) ────────────────────────────────────────────────────────
 * FINDING 1 (P1, broken daily workflow / false success -- fix in T318):
 *   guardarCI() awaits `saveLogs()`, which is FIRE-AND-FORGET: it only
 *   schedules `_doSaveLogs` on a 400ms setTimeout and resolves immediately,
 *   never waiting for the actual Firestore write or its result. Every other
 *   terminal action in this file (session completion, partial closure,
 *   skip, nutrition log) already bypasses this via `_doSaveLogs()` directly
 *   and gates its success toast on the real boolean result (T125-C/T126-C
 *   precedent) -- guardarCI() is the one holdout still showing
 *   "GUARDADO ✓" regardless of whether that specific write ever reaches
 *   the server.
 * FINDING 2 (P2, UX -- fix in T317): guardarNutriLog() has no validation
 *   before writing (any string, including negative numbers, is accepted
 *   into kcal/prot/carb/gras).
 * FINDING 3 (P2, defensive hardening -- fix in T317/T318): neither
 *   guardarNutriLog() nor guardarCI() re-checks client identity after
 *   their own await, unlike the established T127-H pattern used elsewhere
 *   (e.g. showClientDetail in the coach app, _endSessionAsPartial's
 *   week-context guard in the client app).
 * FINDING 4 (P3, cosmetic, NOT fixed here): _buildWeightSparkline's empty
 *   state text says "Registra tus datos InBody en 2+ semanas" but the gate
 *   is actually "any data at all" (>=1 point), not literally 2+.
 * (No FINDING 5 -- cross-tab consistency (T320) is architecturally sound
 *   already: goTab() unconditionally re-renders the target tab from
 *   current global state on every visit, and every terminal write already
 *   calls its own renderResumen()/renderEntrenamiento() to reflect
 *   immediately without waiting for a tab switch.)
 *
 * Run: node tests/t315-daily-loop-contract-audit.test.js
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

// ── goTab unconditionally re-renders every tab on every visit -- confirms
// the cross-tab-consistency architecture is already sound. ─────────────────
const goTabSrc = extractFunction(CLIENT, 'function goTab(i) {');
['renderEntrenamiento()', 'renderNutricion()', 'renderCheckin()', 'renderPerfil()', 'renderResumen()'].forEach(function(call) {
  ok(goTabSrc.includes(call), 'goTab always re-renders ' + call.replace('()', '') + ' when navigating to its tab -- no stale cached tab content');
});

// ── FINDING 1: guardarCI's real bug -- fire-and-forget saveLogs(). ─────────
const saveLogsSrc = extractFunction(CLIENT, 'async function saveLogs() {');
ok(saveLogsSrc.includes('_saveLogsTimer = setTimeout(_doSaveLogs, 400);') && !saveLogsSrc.includes('await _doSaveLogs'),
  'confirmed: saveLogs() only schedules _doSaveLogs on a timer -- it never awaits the actual write, so awaiting saveLogs() resolves immediately regardless of real persistence');
const guardarCISrc = extractFunction(CLIENT, 'async function guardarCI() {');
ok(guardarCISrc.includes('await saveLogs();'),
  'FINDING 1 confirmed: guardarCI() awaits the fire-and-forget saveLogs(), not the real _doSaveLogs() -- its "GUARDADO ✓" toast is not gated on actual Firestore confirmation of the ci_sem_ write (fixed in T318)');

// ── Nutrition log already uses the CORRECT bypass pattern (contrast case). ──
const guardarNutriLogSrc = extractFunction(CLIENT, 'async function guardarNutriLog() {');
ok(guardarNutriLogSrc.includes('var _ok = await _doSaveLogs();') && guardarNutriLogSrc.includes("if (_ok === false) {"),
  'contrast: guardarNutriLog() already does this correctly (T126-C) -- real await, real success gate');

// ── FINDING 2: no validation before write in nutrition log. ────────────────
ok(!/parseFloat|isNaN/.test(guardarNutriLogSrc), 'FINDING 2 confirmed: guardarNutriLog() never validates the numeric fields before writing (fixed in T317)');

// ── FINDING 3: no stale-identity guard after either await. ─────────────────
ok(!guardarNutriLogSrc.includes('USER.uid') && !guardarNutriLogSrc.includes('_uidAtStart'),
  'FINDING 3 confirmed (nutrition): no stale-client-context re-check after its own await');
ok(!guardarCISrc.includes('_uidAtStart') && !/if \(!USER \|\| USER\.uid/.test(guardarCISrc),
  'FINDING 3 confirmed (check-in): no stale-client-context re-check after its own await');

// ── PROGRESS view: confirmed already honest (no fabricated single-point trend). ──
const historialSrc = extractFunction(CLIENT, 'function buildHistorialWidget() {');
ok(historialSrc.includes('var loadDelta = last.maxLoad - first.maxLoad;'),
  'a single data point (first === last) yields loadDelta = 0 -- an honest flat trend, never a fabricated direction');
const sparklineSrc = extractFunction(CLIENT, 'function _buildWeightSparkline() {');
ok(sparklineSrc.includes('if (allWeeks.length === 1) return padL + cW / 2;'),
  'the sparkline explicitly handles a single measurement (one centered point), never an invented multi-point line');

console.log('');
console.log('T315 — Daily-loop contract audit: ' + pass + ' assertions PASSED. 4 real findings documented (1 P1, 2 P2, 1 P3-not-fixed-here). No code changed this phase.');
