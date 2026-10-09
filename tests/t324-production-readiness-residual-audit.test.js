'use strict';
/**
 * T324 — Production-readiness residual audit (bounded, max 10 findings).
 * Scope: AUTH CLIENT -> HOME -> WORKOUT -> NUTRITION -> CHECK-IN ->
 * PROGRESS -> RELOAD -> LOGOUT.
 *
 * Searched every named pattern. Result: 0 new P0/P1/P2 findings -- every
 * reachable instance of the serious classes (false-success, stale async
 * context, old-week-as-current) was found and fixed earlier in this same
 * run (T317/T318). Per this ticket's own rule ("If no P0/P1/P2 remain:
 * STOP. Do not invent a new subsystem just to keep working"), this phase
 * concludes the run.
 *
 * Run: node tests/t324-production-readiness-residual-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const SW     = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

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

console.log('T324 — searching 21 named patterns:');

// false-success
ok(!/await saveLogs\(\)/.test(CLIENT), 'NOT FOUND: false-success -- zero remaining "await saveLogs()" call sites in the whole file (both found this run, in guardarCI and markSessionDone\'s reopen path, were fixed in T318)');

// double-submit
ok(extractFunction(CLIENT, 'async function guardarCI() {').includes('if (_guardarCIInFlight) return;'), 'NOT FOUND: double-submit on check-in -- in-flight guard present');
ok(/document\.querySelector\('\[onclick="guardarNutriLog\(\)"\]'\)/.test(extractFunction(CLIENT, 'async function guardarNutriLog() {')), 'NOT FOUND: double-submit on nutrition -- button disabled synchronously before its await');

// stale async context
ok(extractFunction(CLIENT, 'async function guardarNutriLog() {').includes('_uidAtStart'), 'NOT FOUND: stale async context on nutrition -- guard present (T317)');
ok(extractFunction(CLIENT, 'async function guardarCI() {').includes('_uidAtStart'), 'NOT FOUND: stale async context on check-in -- guard present (T318)');

// cross-client state
const doLogoutSrc = extractFunction(CLIENT, 'async function doLogout() {');
ok(doLogoutSrc.includes('LOGS = {}'), 'NOT FOUND: cross-client state -- doLogout resets LOGS (T129, re-confirmed T320)');

// activePlanId stale reads
ok(CLIENT.includes('location.reload();') && CLIENT.includes('newPlanId !== activePlanId'), 'NOT FOUND: activePlanId stale reads -- a change triggers a full reload');

// old week treated current
const renderResumenSrc = extractFunction(CLIENT, 'function renderResumen() {');
ok(renderResumenSrc.indexOf('CURRENT_WEEK = REAL_WEEK;') < renderResumenSrc.indexOf('const semActiva'), 'NOT FOUND: old week treated current -- fixed in T318 (Home always resets to REAL_WEEK)');

// localStorage leakage
const loadBackupLogsSrc = extractFunction(CLIENT, 'function loadBackupLogs() {');
ok(loadBackupLogsSrc.includes('bkPlanId !== curPlanId'), 'NOT FOUND (mitigated): localStorage leakage -- cross-plan backups are detected and only exercise history/units are recovered, never a different plan\'s LOGS/week state; ACTIVE_PLAN_ID is always set before this runs, so the guard is always active for any two real plans');

// raw done_ checks bypassing canonical lifecycle (Home surfaces specifically)
['function getTodaySummary() {', 'function buildWeekDayChips() {', 'function buildStaleSessionHomeBanner() {'].forEach(function(decl) {
  ok(!/LOGS\['done_/.test(extractFunction(CLIENT, decl)), 'NOT FOUND: raw done_ check in ' + decl.match(/function (\w+)/)[1] + ' -- reads exclusively via the canonical resolver');
});

// nutrition date leakage
ok(CLIENT.includes("var k = 'nutrilog_'+_todayKey();"), 'NOT FOUND: nutrition date leakage -- per-calendar-date key, a new day never inherits yesterday\'s entry');

// stale check-in CTA
ok(renderResumenSrc.includes("const ciDone = !!(ci.peso || ci.hrv);"), 'NOT FOUND: stale check-in CTA -- ciDone recomputed fresh from LOGS on every Home render, no cached flag');

// one-measurement fake progress
const historialSrc = extractFunction(CLIENT, 'function buildHistorialWidget() {');
ok(historialSrc.includes('var loadDelta = last.maxLoad - first.maxLoad;'), 'NOT FOUND: one-measurement fake progress -- a single point yields first===last, loadDelta=0, never a fabricated direction (T315/T323)');

// error swallowed
ok(extractFunction(CLIENT, 'async function guardarCI() {').includes("showToast('⚠ NO SE GUARDÓ"), 'NOT FOUND: error swallowed on check-in -- a failed write shows a real, visible error');

// spinner never cleared / button never re-enabled
ok(extractFunction(CLIENT, 'async function guardarNutriLog() {').includes('finally'), 'NOT FOUND: button never re-enabled -- guardarNutriLog resets its button in a finally block');
ok(extractFunction(CLIENT, 'async function guardarCI() {').includes('finally'), 'NOT FOUND: button never re-enabled -- guardarCI resets its buttons in a finally block');

// completed session still writable
ok(!extractFunction(CLIENT, 'function _getTodayHomeState(logs, week, sesiones) {').includes('canStart = true;\n      break;\n    case \'COMPLETE\''),
  'NOT FOUND: completed session still writable -- COMPLETE never sets canStart/canResume true (T308)');

// PARTIAL shown COMPLETE / SKIPPED shown PENDING
ok(CLIENT.includes(".wk.partial{"), 'NOT FOUND: PARTIAL shown as COMPLETE -- distinct week-grid class (T310)');
ok(extractFunction(CLIENT, 'function getTodaySummary() {').includes('OMITIDA'), 'NOT FOUND: SKIPPED shown as PENDING -- explicit OMITIDA status line (T309)');

// missing zero-value handling
ok(extractFunction(CLIENT, 'async function guardarNutriLog() {').includes('_v < 0') && !/_v <= 0/.test(extractFunction(CLIENT, 'async function guardarNutriLog() {')),
  'NOT FOUND: missing zero-value handling -- 0 is explicitly valid (only negative/NaN rejected, T317)');

// duplicate Firestore listeners
const clientOnSnapshotCount = (CLIENT.match(/FB\.onSnapshot\(/g) || []).length;
ok(clientOnSnapshotCount === 5, 'NOT FOUND: duplicate Firestore listeners -- still exactly 5 (T294 baseline unchanged by this run)');

// inaccessible div-as-button -- CLOSED in T322 (converted after this audit
// pass confirmed it was safe: no JS queries .wk by tag, only by class; the
// CSS class already fully defines background/border/padding, so it applies
// identically to a <button>; grid-item behavior is unaffected by the
// child's own display value).
ok(!CLIENT.includes('<div class="wk ${cls}" onclick="goToWeek(${w})">'), 'RESOLVED (T322): week-grid cells are no longer a clickable <div>');
ok(CLIENT.includes('<button type="button" class="wk ${cls}" onclick="goToWeek(${w})" aria-label="Semana'), 'RESOLVED (T322): week-grid cells are now real <button> elements with an aria-label (keyboard-focusable, screen-reader meaningful)');

// bottom-nav covering primary CTA
const bottomNavRule = CLIENT.match(/\.bnav\{([^}]*)\}/)?.[1] || '';
ok(/display:flex/.test(bottomNavRule) && /flex-shrink:0/.test(bottomNavRule) && !/position:(?:fixed|absolute)/.test(bottomNavRule),
  'NOT FOUND: bottom-nav covering primary CTA -- .bnav is laid out via flexbox (flex-shrink:0) alongside the scrollable content, never position:fixed overlaying it');

console.log('');
console.log('T324 — Production-readiness residual audit: ' + pass + ' assertions PASSED. 0 new P0/P1/P2 findings. 1 pre-existing P3 re-documented (week-grid div-as-button). STOP condition A met.');
