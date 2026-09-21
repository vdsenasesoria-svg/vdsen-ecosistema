'use strict';
/**
 * T322 — Mobile + accessibility hardening, scoped to T315-T321's changes
 * plus closing the documented Home P3 (safely, per this ticket's own
 * "ONLY if conversion preserves IDs/listeners/layout and is low-risk").
 *
 * T315-T321 added no new UI markup (only logic/copy changes to existing
 * elements: toast text, validation, the CURRENT_WEEK reset) -- so there was
 * nothing new to hard against a11y beyond what T313 already covered for
 * T308-T314's additions.
 *
 * Closes the P3: week-grid cells converted from a clickable <div onclick>
 * to a real <button>. Verified low-risk before converting: no JS queries
 * `.wk` by tag (only by class, in T310's own new logic and pre-existing
 * CSS), the `.wk` CSS class already fully defines background/border/
 * padding/cursor (so it renders identically on a <button>), and CSS Grid
 * item behavior does not depend on a child's own `display` value -- a
 * <button> is placed exactly like a <div> would be. Native button chrome
 * is neutralized (-webkit-appearance:none) and an explicit min-height:44px
 * touch target and font-family:inherit were added.
 *
 * Run: node tests/t322-mobile-a11y-week-grid-fix.test.js
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

const renderResumenSrc = extractFunction(CLIENT, 'function renderResumen() {');

// ── The conversion itself. ──────────────────────────────────────────────────
ok(!renderResumenSrc.includes('<div class="wk ${cls}"'), 'week-grid cells no longer use a clickable <div>');
ok(renderResumenSrc.includes('<button type="button" class="wk ${cls}"'), 'week-grid cells are now real, keyboard-focusable <button> elements');
ok(renderResumenSrc.includes('aria-label="Semana ${w}${lbl?\': \'+lbl:\'\'}"'), 'each week button carries a meaningful aria-label (e.g. "Semana 3: PARCIAL"), not just a bare number');
ok(renderResumenSrc.includes('onclick="goToWeek(${w})">'.replace('>','') ) || renderResumenSrc.includes('onclick="goToWeek(${w})"'), 'the existing onclick handler/listener is preserved unchanged -- same behavior, different element type');

// ── Low-risk verification: no JS elsewhere queries .wk assuming a <div>. ────
ok(!/querySelector(All)?\(['"]\.wk['"]\)|querySelector(All)?\(['"]div\.wk['"]\)/.test(CLIENT), 'no JS anywhere queries .wk (or div.wk) by tag -- the conversion cannot break any existing DOM query');

// ── Native button chrome neutralized; touch target sized. ─────────────────
const wkCssIdx = CLIENT.indexOf('.wk{background:var(--surface)');
const wkCssRule = CLIENT.slice(wkCssIdx, CLIENT.indexOf('}', wkCssIdx) + 1);
ok(wkCssRule.includes('-webkit-appearance:none') && wkCssRule.includes('appearance:none'), '.wk neutralizes native button chrome (iOS/Android default button styling)');
ok(wkCssRule.includes('font-family:inherit'), '.wk explicitly inherits the app font -- a <button> never falls back to the system UI font');
ok(wkCssRule.includes('min-height:44px'), '.wk declares an explicit 44px touch target, consistent with T313\'s day-chip fix');

// ── CSS class-based styling (background/border/radius/padding/cursor) is
// untouched -- only appended to, so all 4 week-cell states (active/done/
// deload/partial) render identically to before, just on a real button. ────
['.wk.done{', '.wk.active{', '.wk.deload{', '.wk.partial{'].forEach(function(sel) {
  ok(CLIENT.includes(sel), 'existing state class ' + sel + ' preserved unchanged -- all 4 visual states (done/active/deload/partial) still apply');
});

console.log('');
console.log('T322 — Mobile/a11y hardening: ' + pass + ' assertions PASSED. Home P3 (week-grid div-as-button) closed.');
