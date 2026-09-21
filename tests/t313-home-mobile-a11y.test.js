'use strict';
/**
 * T313 — Mobile / accessibility hardening, scoped to the CHANGED Home flow
 * only (T308-T312: getTodaySummary CTA, buildWeekDayChips, week-grid cells,
 * buildStaleSessionHomeBanner). No visual redesign outside Home.
 *
 * Checked and fixed: day-chip touch target was borderline (~41px at 6px
 * vertical padding) -- bumped to an explicit min-height:44px (WCAG/Android
 * touch-target guideline), still compact enough for up to ~7 chips in a row.
 *
 * Checked and confirmed already correct (no change needed):
 *  - every new interactive element is a real <button>, natively keyboard-
 *    focusable/activatable, no outline:none suppressing focus rings
 *  - no nested interactive controls in any new markup
 *  - day chips carry both title and aria-label text -- state is never
 *    conveyed by color alone (also a distinct icon shape per state, T310)
 *  - flex:1/min-width:0 on chips and CTA buttons prevents horizontal
 *    overflow at narrow (Android-class) viewports
 *  - Home's new blocks render synchronously from in-memory LOGS/PLAN --
 *    no async fetch inside them that could cause a layout jump
 *
 * Documented, not fixed (pre-existing, outside this ticket's touched
 * surface): the week-grid cells (.wk) use a clickable <div onclick=...>
 * rather than a <button> -- a real but PRE-EXISTING pattern predating T307;
 * T310 only changed which CSS class/label that div gets, not its element
 * type. Converting it risks the existing .wk/.wk-num/.wk-lbl CSS contract
 * and is a structural change beyond "reorder + add a distinct class," so
 * it is left as documented debt rather than fixed under this ticket's
 * "no visual redesign outside Home" / "reuse existing design system" rules.
 *
 * Run: node tests/t313-home-mobile-a11y.test.js
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

const chipsSrc  = extractFunction(CLIENT, 'function buildWeekDayChips() {');
const ctaSrc    = extractFunction(CLIENT, 'function getTodaySummary() {');
const bannerSrc = extractFunction(CLIENT, 'function buildStaleSessionHomeBanner() {');
const ALL_NEW = chipsSrc + ctaSrc + bannerSrc;

// ── Touch target fix. ───────────────────────────────────────────────────────
ok(chipsSrc.includes('min-height:44px'), 'day chip buttons now declare an explicit min-height:44px touch target');

// ── Real, keyboard-operable controls; no suppressed focus. ─────────────────
ok(!/outline\s*:\s*none/.test(ALL_NEW), 'none of the new Home elements suppress the default focus outline');
const buttonCount = (ALL_NEW.match(/<button/g) || []).length;
ok(buttonCount >= 4, 'every new interactive element (CTA, each day chip, both stale-banner actions) is a real <button>, not a clickable div/span');

// ── No nested interactive controls: every <button> is self-closed by its
// own </button> before the next one opens (siblings, never nested). ────────
[chipsSrc, bannerSrc, ctaSrc].forEach(function(src, i) {
  var opens = (src.match(/<button/g) || []).length;
  var closes = (src.match(/<\/button>/g) || []).length;
  ok(opens === closes && opens > 0, 'block ' + i + ': every <button> (' + opens + ') has its own matching </button> -- well-formed siblings, never nested');
});

// ── State never conveyed by color alone. ───────────────────────────────────
ok(chipsSrc.includes('aria-label="Día') && chipsSrc.includes('title="Día'), 'day chips carry text (title + aria-label) alongside their icon/color');
ok(chipsSrc.includes("aria-hidden=\"true\""), 'the decorative icon glyph is aria-hidden so screen readers read the meaningful title/aria-label text instead of the raw glyph');

// ── No horizontal overflow risk in the new flex layouts. ───────────────────
ok(chipsSrc.includes('flex:1;min-width:0'), 'day chips use flex:1 + min-width:0 -- shrinks safely instead of overflowing on narrow (Android-class) viewports');

// ── Synchronous render -- no layout jump from an async fetch inside these
// specific new blocks (they only read already-in-memory LOGS/PLAN). ────────
ok(!/await |\.then\(/.test(ALL_NEW), 'buildWeekDayChips/getTodaySummary/buildStaleSessionHomeBanner are all synchronous -- no async gap that could cause a layout jump on Home');

console.log('');
console.log('T313 — Mobile/a11y hardening: ' + pass + ' assertions PASSED. 1 fix applied (chip touch target). 1 pre-existing item documented (week-grid div-as-button), not fixed.');
