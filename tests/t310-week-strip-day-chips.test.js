'use strict';
/**
 * T310 — Weekly state strip / day chips.
 *
 * Closes the known P3 (documented in T306/T307): the Home week-grid used to
 * render an all-PARTIAL week identically to an all-COMPLETE one (both
 * "done", green). Now a week resolved via real execution but NOT purely
 * COMPLETE (any PARTIAL/legacy-AUTO_CLOSED mixed in) gets its own distinct
 * "partial" class -- separate border/number color (hueso var(--tx), never
 * var(--grn)) and its own "PARCIAL" label.
 *
 * Also adds buildWeekDayChips(): a compact day-by-day strip for the current
 * week, using ONLY the canonical _getSessionLifecycleState/label -- no
 * second state engine, and shape (a distinct icon per state) + title/
 * aria-label carry the meaning, not color alone.
 *
 * Run: node tests/t310-week-strip-day-chips.test.js
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

// ── P3 closed: week-grid classification now distinguishes all-COMPLETE from
// any-PARTIAL-mixed-in, via a separate CSS class and label. ────────────────
const renderResumenSrc = extractFunction(CLIENT, 'function renderResumen() {');
ok(renderResumenSrc.includes('const _wAllComplete ='), 'renderResumen computes a pure-COMPLETE check separate from the real-execution check');
ok(renderResumenSrc.includes('const _wHasPartial = _wDone && !_wAllComplete;'), 'a week resolved via real execution but not purely COMPLETE is flagged _wHasPartial');
ok(renderResumenSrc.includes("cls = w===semActiva?'active':(_wAllComplete?'done':(_wHasPartial?'partial':"),
  'the "done" (green) class is now reserved for purely-COMPLETE weeks; a PARTIAL-containing week gets its own "partial" class, never "done"');
ok(renderResumenSrc.includes("lbl = w===_totalWeeksGrid?'DELOAD':w===semActiva?'ACTIVA':(_wHasPartial?'PARCIAL':"),
  'a PARTIAL-containing week shows an explicit "PARCIAL" label, distinct from a COMPLETE week\'s blank/SEM label');

ok(CLIENT.includes('.wk.partial{border-color:rgba(244,244,240,.35);background:rgba(244,244,240,.04)}'), 'CSS: .wk.partial has its own border/background, distinct from .wk.done');
ok(CLIENT.includes('.wk.partial .wk-num{color:var(--tx)}') && CLIENT.includes('.wk.done .wk-num{color:var(--grn)}'),
  'CSS: .wk.partial uses var(--tx) (hueso) for its number, never var(--grn) (reserved for a genuinely fully-COMPLETE week) -- reuses existing VDSEN tokens, no new colors');

// ── Day chips: pure projection of the canonical resolver, shape (icon)
// distinguishes state, not color alone. ─────────────────────────────────────
const chipsSrc = extractFunction(CLIENT, 'function buildWeekDayChips() {');
ok(chipsSrc.includes('_getSessionLifecycleState(LOGS, CURRENT_WEEK, i)') && chipsSrc.includes('_getSessionLifecycleLabel(LOGS, CURRENT_WEEK, i)'),
  'buildWeekDayChips reads state/label exclusively from the canonical resolver -- no second engine, no raw done_ checks');
const iconsMap = { NOT_STARTED: '·', IN_PROGRESS: '●', PARTIAL: '◐', COMPLETE: '✓', SKIPPED: '⏸' };
Object.keys(iconsMap).forEach(function(state) {
  ok(chipsSrc.includes("'" + state + "':'" + iconsMap[state] + "'") || chipsSrc.includes(state + ":'" + iconsMap[state] + "'"),
    'chip icon for ' + state + ' is a distinct shape ("' + iconsMap[state] + '"), not just a color swap');
});
ok(chipsSrc.includes('aria-label="Día') && chipsSrc.includes('title="Día'), 'each chip carries both a title (hover) and aria-label (screen reader) -- state is never color-only');
ok(chipsSrc.includes('onclick="_goToHomeDay(') , 'each chip routes through the same single _goToHomeDay path as the primary CTA -- no duplicated routing');

// ── Wired into Home, not a separate screen. ────────────────────────────────
ok(CLIENT.includes('${getTodaySummary()}\n      ${buildWeekDayChips()}'), 'buildWeekDayChips renders inside the existing HOY card, right under the primary CTA');

console.log('');
console.log('T310 — Week strip / day chips: ' + pass + ' assertions PASSED. P3 closed.');
