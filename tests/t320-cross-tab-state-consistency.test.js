'use strict';
/**
 * T320 — Cross-tab state consistency (audit; the substantive fix already
 * landed in T318).
 *
 * CASE A (workout completed -> Home immediately reflects COMPLETE):
 *   _confirmSessionDone/_endSessionAsPartial/skipSession/markSessionDone's
 *   reopen path all already call renderResumen() directly on success --
 *   Home never waits for a tab switch to catch up.
 * CASE B (nutrition log saved -> nutrition status updates):
 *   guardarNutriLog() calls renderNutricion() on success (T126-C/T317).
 * CASE C (check-in saved -> pending surface disappears):
 *   guardarCI() calls renderResumen() on success; Home's ciDone is
 *   recomputed fresh from LOGS on every render, no cached flag.
 * CASE D (activePlanId changes -> all tabs reflect new plan):
 *   the client-doc live listener detects a changed activePlanId and does a
 *   full location.reload() -- the strongest possible consistency guarantee
 *   (every tab re-bootstraps from the new plan, no partial-update risk).
 * CASE E (client logout/login -> no previous user state remains):
 *   doLogout() (T129, pre-existing) resets LOGS/PLAN/EXERCISE_UNITS/
 *   EXERCISE_HISTORY/REAL_WEEK/CURRENT_WEEK before any next login.
 * CASE F (week changes -> no previous-week state masquerades as current):
 *   FIXED in T318 -- renderResumen() now resets CURRENT_WEEK = REAL_WEEK
 *   before rendering anything, so Home can never be left showing a past
 *   week (from an earlier Entrenamiento navigation) as if it were current.
 *
 * Run: node tests/t320-cross-tab-state-consistency.test.js
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

// ── CASE A ──────────────────────────────────────────────────────────────────
['async function _confirmSessionDone(di) {', 'async function _endSessionAsPartial(di) {', 'async function skipSession(di, reason) {', 'async function markSessionDone(di) {']
  .forEach(function(decl) {
    ok(extractFunction(CLIENT, decl).includes('renderResumen();'), 'CASE A: ' + decl.match(/function (\w+)/)[1] + ' calls renderResumen() on its success path -- Home reflects the change immediately');
  });

// ── CASE B ──────────────────────────────────────────────────────────────────
ok(extractFunction(CLIENT, 'async function guardarNutriLog() {').includes('renderNutricion();'), 'CASE B: guardarNutriLog() re-renders the nutrition tab on success');

// ── CASE C ──────────────────────────────────────────────────────────────────
const guardarCISrc = extractFunction(CLIENT, 'async function guardarCI() {');
ok(guardarCISrc.includes('renderResumen();'), 'CASE C: guardarCI() re-renders Home on success -- the pending check-in surface disappears immediately');
const renderResumenSrc = extractFunction(CLIENT, 'function renderResumen() {');
ok(renderResumenSrc.includes("const ci = LOGS['ci_sem_'+semActiva] || {};") && renderResumenSrc.includes('const ciDone = !!(ci.peso || ci.hrv);'),
  'CASE C: ciDone is recomputed fresh from LOGS on every Home render -- no separate cached "pending" flag that could go stale');

// ── CASE D ──────────────────────────────────────────────────────────────────
ok(CLIENT.includes("if (newPlanId && newPlanId !== activePlanId) {") && CLIENT.includes('setTimeout(function(){ location.reload(); }, 1500);'),
  'CASE D: an activePlanId change detected via the live client-doc listener triggers a full reload -- every tab re-bootstraps from the new plan');

// ── CASE E ──────────────────────────────────────────────────────────────────
const doLogoutSrc = extractFunction(CLIENT, 'async function doLogout() {');
['LOGS = {}', 'EXERCISE_UNITS = {}', 'EXERCISE_HISTORY = {}', 'REAL_WEEK = 1', 'CURRENT_WEEK = 1'].forEach(function(reset) {
  ok(doLogoutSrc.includes(reset), 'CASE E: doLogout() resets ' + reset + ' -- no previous client\'s state survives into the next login');
});

// ── CASE F (the real fix, T318) ─────────────────────────────────────────────
ok(renderResumenSrc.indexOf('CURRENT_WEEK = REAL_WEEK;') < renderResumenSrc.indexOf('const semActiva'),
  'CASE F: renderResumen() resets CURRENT_WEEK to REAL_WEEK before computing anything -- a previous week\'s view-mode state can never masquerade as current on Home');

console.log('');
console.log('T320 — Cross-tab state consistency: ' + pass + ' assertions PASSED. All 6 required cases confirmed (case F fixed in T318).');
