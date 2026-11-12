'use strict';
/**
 * T307 — Client Home ("Hoy" / Resumen tab) contract audit (audit-only, no
 * redesign yet).
 *
 * Home = tab index 0 = renderResumen() (document.getElementById('tabResumen')).
 * There is no separate renderHoy/renderHome/navHoy -- "Hoy" is the
 * `<div class="card"><div class="card-title">HOY — SEM ...</div>${getTodaySummary()}</div>`
 * block inside renderResumen().
 *
 * ── CONTRACT MAP ──────────────────────────────────────────────────────────
 *
 * UI BLOCK: "HOY" card (getTodaySummary())
 *   CURRENT STATE SOURCE: raw `!!LOGS['done_'+CURRENT_WEEK+'_'+i]` truthiness
 *     loop (its OWN copy, independent of _autoAdvanceDia/DIA_ACTIVO)
 *   CANONICAL OR DERIVED: DERIVED (does not call _getSessionLifecycleState)
 *   ACTION: always the same "ENTRENAR AHORA ▶" button, regardless of state
 *   KNOWN DUPLICATION: re-implements the same "first unresolved day" scan
 *     _autoAdvanceDia() already performs -- two independent raw-truthy loops
 *   RISK: REAL BUG (see FINDING 1) -- when every session in CURRENT_WEEK is
 *     resolved (COMPLETE/PARTIAL/SKIPPED), the loop never breaks and `idx`
 *     falls back to the LAST session, which the CTA still renders as
 *     "ENTRENAR AHORA ▶" -- a fully-done or explicitly-skipped day is
 *     presented as an inviting pending action.
 *
 * UI BLOCK: week grid (weekHtml in renderResumen)
 *   CURRENT STATE SOURCE: `_isRealExecution` (per-day) aggregated with
 *     `.every(Boolean)` per week
 *   CANONICAL OR DERIVED: DERIVED, but consistent with the canonical
 *     _isRealExecution primitive (not a second engine)
 *   ACTION: navigate to that week (goToWeek)
 *   KNOWN DUPLICATION: none
 *   RISK: KNOWN P3 (already documented in T306) -- an all-PARTIAL week and
 *     an all-COMPLETE week both render the same "done" (green) class; only
 *     a week resolved via skips-only gets a distinct "⏸" label. T310 will
 *     consider closing this if the fix stays local.
 *
 * UI BLOCK: streak widget (buildStreakWidget)
 *   CURRENT STATE SOURCE: `_isRealExecution` per day
 *   CANONICAL OR DERIVED: DERIVED, consistent with the canonical primitive
 *   ACTION: informational only, no CTA
 *   KNOWN DUPLICATION: none
 *   RISK: none -- PARTIAL already correctly counts as real execution here
 *
 * UI BLOCK: check-in card, mesociclo/historial/volumen/rezagados widgets
 *   CURRENT STATE SOURCE: n/a (different data domain: ci_sem_, volume, PRs)
 *   CANONICAL OR DERIVED: n/a -- not session-lifecycle state at all
 *   ACTION: navigate to their own tabs/flows
 *   KNOWN DUPLICATION: none
 *   RISK: none for THIS ticket's scope (session lifecycle); out of scope
 *     per "Home is execution-first, do not add more analytics" -- these are
 *     pre-existing and untouched
 *
 * UI BLOCK: stale open-session recovery (T303)
 *   CURRENT STATE SOURCE: _findStaleOpenSession, triggered once from
 *     loadPlan() via a one-shot setTimeout modal
 *   CANONICAL OR DERIVED: CANONICAL (uses _getSessionLifecycleState via
 *     _findStaleOpenSession)
 *   ACTION: modal-only (CONTINUAR / TERMINAR COMO PARCIAL); nothing on Home
 *     itself surfaces this after the modal is dismissed
 *   KNOWN DUPLICATION: none (single detector, as required)
 *   RISK: REAL GAP (see FINDING 2) -- if the client dismisses the one-shot
 *     modal (or it fires before Home is visible) and returns to Home later
 *     in the same session, there is no persistent Home-level indicator that
 *     a stale session is still open; the user has no way back into recovery
 *     without a fresh app reload.
 *
 * ── FINDINGS (max 2, per this phase's own rule) ─────────────────────────────
 * FINDING 1 (real, fix in T308/T309): getTodaySummary() has no lifecycle
 *   awareness. It always shows "ENTRENAR AHORA ▶", including when the
 *   fallback day is COMPLETE or SKIPPED. Root cause: a second raw `done_`
 *   truthy loop, duplicated from _autoAdvanceDia, with no per-state branch.
 * FINDING 2 (real, fix in T311): a stale IN_PROGRESS session has no
 *   persistent Home-level surface -- only a one-time modal at app load.
 *
 * Do NOT patch broadly. This phase is audit-only.
 *
 * Run: node tests/t307-home-contract-audit.test.js
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

// ── Home IS renderResumen (tab 0) -- confirm there is no separate/duplicate
// Home renderer already, so T308+ has exactly one place to touch. ──────────
ok(CLIENT.includes("function renderResumen() {"), 'Home lives in renderResumen() (tab index 0) -- no separate renderHoy/renderHome exists');
ok(!/function renderHoy\b|function renderHome\b|function navHoy\b/.test(CLIENT), 'confirmed no competing Home renderer exists to accidentally diverge from');

// ── FINDING 1: getTodaySummary had no lifecycle awareness. FIXED in T308/T309:
// it now delegates entirely to _getTodayHomeState, a pure projection of the
// canonical lifecycle, with a distinct CTA per state. ──────────────────────
const todaySummarySrc = extractFunction(CLIENT, 'function getTodaySummary() {');
ok(!todaySummarySrc.includes("LOGS['done_"),
  'FINDING 1 RESOLVED (T308/T309): getTodaySummary no longer runs its own raw done_ truthiness loop -- delegates to _getTodayHomeState');
ok(todaySummarySrc.includes('_getTodayHomeState(LOGS, CURRENT_WEEK, sesiones)') && todaySummarySrc.includes("case 'COMPLETE':"),
  'FINDING 1 RESOLVED (T308/T309): the CTA now branches per lifecycle state instead of a single hardcoded string');

// ── FINDING 2: no persistent Home-level stale-session surface. Still open --
// scheduled for T311. ───────────────────────────────────────────────────────
const renderResumenSrc = extractFunction(CLIENT, 'function renderResumen() {');
ok(!renderResumenSrc.includes('_findStaleOpenSession') && !renderResumenSrc.includes('SESIÓN ANTERIOR SIN CERRAR'),
  'FINDING 2 still open as of T307/T308/T309: renderResumen never checks for a stale session -- the only surface is loadPlan\'s one-time modal (fixed in T311)');

// ── Known P3 (already documented, not a new finding): week-grid conflates
// all-PARTIAL with all-COMPLETE. ────────────────────────────────────────────
ok(CLIENT.includes("const _wDone = _numDiasGrid > 0 && Array.from({length:_numDiasGrid}, (_,i) => _isRealExecution(LOGS['done_'+w+'_'+i])).every(Boolean);"),
  'confirmed pre-existing P3: the week-grid "done" class is driven by _isRealExecution (COMPLETE+PARTIAL+legacy AUTO_CLOSED all collapse to the same green cell)');

console.log('');
console.log('T307 — Home contract audit: ' + pass + ' assertions PASSED. 2 real findings documented (fixed in T308/T309 and T311). No code changed this phase.');
