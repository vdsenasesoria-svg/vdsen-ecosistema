'use strict';
/**
 * T309 — Home primary CTA. getTodaySummary() now delegates entirely to
 * _getTodayHomeState (T308) for which day to show and what the CTA says/does
 * -- fixing T307's FINDING 1: no more single hardcoded "ENTRENAR AHORA"
 * regardless of lifecycle, and no more duplicated raw done_ scan.
 *
 * Run: node tests/t309-home-primary-cta.test.js
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

const todaySummarySrc = extractFunction(CLIENT, 'function getTodaySummary() {');

// ── No more raw done_ scan; delegates to the canonical resolver. ───────────
ok(!todaySummarySrc.includes("LOGS['done_"), 'getTodaySummary no longer reads done_ directly -- delegates entirely to _getTodayHomeState');
ok(todaySummarySrc.includes('_getTodayHomeState(LOGS, CURRENT_WEEK, sesiones)'), 'getTodaySummary calls the canonical Home resolver');

// ── Distinct CTA label per lifecycle state -- FINDING 1 fixed. ─────────────
['COMPLETE', 'SKIPPED', 'PARTIAL', 'IN_PROGRESS'].forEach(function(state) {
  ok(todaySummarySrc.includes("case '" + state + "':"), 'getTodaySummary branches on lifecycle state ' + state + ' (not a single hardcoded CTA)');
});
ok(todaySummarySrc.includes('home.primaryAction.label'), 'the rendered button text always comes from the resolver\'s primaryAction, never a fixed string');

// ── COMPLETE never shows a "start again" CTA (explicit rule). ──────────────
ok(!/case 'COMPLETE':[\s\S]{0,200}EMPEZAR|case 'COMPLETE':[\s\S]{0,200}ENTRENAR AHORA/.test(todaySummarySrc),
  'the COMPLETE branch never renders a start/again-style CTA label inline');

// ── SKIPPED is never silently shown as pending -- distinct label/status line. ──
ok(todaySummarySrc.includes('OMITIDA'), 'SKIPPED renders an explicit "OMITIDA" status line, never a bare pending look');

// ── PARTIAL shows real progress (X/Y), never fabricated. ───────────────────
ok(todaySummarySrc.includes('home.progress.completedSets') && todaySummarySrc.includes('home.progress.totalSets'),
  'PARTIAL/IN_PROGRESS status lines show the resolver\'s real completedSets/totalSets, not an invented number');

// ── Single routing path, no duplicated logic (CTA always opens the right day). ──
ok(CLIENT.includes('function _goToHomeDay(idx) {') && CLIENT.includes('selDia(idx);') && CLIENT.includes('goTab(1);'),
  '_goToHomeDay centralizes CTA routing (selDia + goTab) in one place');
ok(todaySummarySrc.includes('onclick="_goToHomeDay(${idx})"'), 'the CTA button always routes through _goToHomeDay, using the resolver\'s own dayIndex -- never a second routing path');

// ── Rest-day / no-programmed-session behavior is untouched. ────────────────
ok(todaySummarySrc.includes("if (sesiones.length === 0) return `<button onclick=\"goTab(1)\""), 'the existing rest-day (no sessions) fallback is preserved unchanged');

// ── VDSEN token reuse only -- no new colors invented. ──────────────────────
ok(!/#[0-9A-Fa-f]{3,6}/.test(todaySummarySrc.replace(/#0A0A0A/g, '')), 'no new hex colors introduced beyond the existing #0A0A0A text-on-accent convention -- all other colors are var(--accent)/var(--grn)/var(--mt)/var(--tx)/var(--gold) tokens');

console.log('');
console.log('T309 — Home primary CTA: ' + pass + ' assertions PASSED');
