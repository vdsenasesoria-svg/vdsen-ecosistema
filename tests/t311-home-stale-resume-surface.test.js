'use strict';
/**
 * T311 — Home-level stale-session surface (closes T307's FINDING 2).
 *
 * Reuses T303's existing _findStaleOpenSession -- Home never runs a second
 * detector and the one-shot load modal's own timing/rules are untouched.
 * buildStaleSessionHomeBanner() renders a PERSISTENT banner (re-evaluated
 * on every renderResumen(), unlike the one-time modal) with CONTINUAR /
 * TERMINAR COMO PARCIAL, both delegating to already-guarded production
 * functions (_goToHomeDay, _endSessionAsPartial) -- no duplicated logic.
 *
 * Run: node tests/t311-home-stale-resume-surface.test.js
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

// ── Reuses the EXISTING T303 detector -- no second stale-session engine. ───
const bannerSrc = extractFunction(CLIENT, 'function buildStaleSessionHomeBanner() {');
ok(bannerSrc.includes('_findStaleOpenSession(LOGS, REAL_WEEK, getSesiones())'), 'buildStaleSessionHomeBanner calls the SAME _findStaleOpenSession T303 already built -- no duplicate detector');
ok((CLIENT.match(/function _findStaleOpenSession\(/g) || []).length === 1, 'exactly one _findStaleOpenSession definition exists in the whole file -- Home did not fork its own copy');

// ── Persistent, not a one-shot modal: rendered every time Home renders. ────
const renderResumenSrc = extractFunction(CLIENT, 'function renderResumen() {');
ok(renderResumenSrc.includes('${buildStaleSessionHomeBanner()}'), 'the banner is part of renderResumen\'s own template -- it reappears on every Home render until the session is actually resolved, unlike the one-shot load modal');

// ── The one-shot T303 modal timing/logic is untouched (no duplicate prompt
// loop): still triggered once from loadPlan, still its own separate function. ──
ok(CLIENT.includes('function _showStaleSessionRecovery(staleInfo) {'), 'the original T303 one-shot modal function is untouched, still present');
ok(CLIENT.includes('if (_stale) _showStaleSessionRecovery(_stale);'), 'loadPlan still fires the one-shot modal exactly as T303 defined -- T311 adds a surface, does not replace or duplicate the trigger');

// ── Both actions delegate to already-guarded production functions -- no
// reimplemented closure/navigation logic. ───────────────────────────────────
const resumeSrc = extractFunction(CLIENT, 'function _resumeStaleSessionFromHome(week, di) {');
ok(resumeSrc.includes('_goToHomeDay(di);'), 'CONTINUAR delegates to the same _goToHomeDay routing every other Home CTA uses');
const closeSrc = extractFunction(CLIENT, 'function _closeStaleSessionAsPartialFromHome(week, di) {');
ok(closeSrc.includes('_endSessionAsPartial(di);'), 'TERMINAR COMO PARCIAL delegates to the already-guarded T301 _endSessionAsPartial -- same real-sets-only/no-fabrication/confirm-dialog/failure-revert safety, not reimplemented');
ok(closeSrc.includes('CURRENT_WEEK = week;') && closeSrc.includes('DIA_ACTIVO = di;'),
  'the Home wrapper sets CURRENT_WEEK/DIA_ACTIVO to the STALE session\'s own week/day before delegating -- _endSessionAsPartial reads CURRENT_WEEK internally, so this prevents it from accidentally operating on whatever week Home happened to be showing');

// ── Distinctness when the stale day differs from "today"'s own pick. ──────
ok(bannerSrc.includes("'(Día '+(stale.di+1)+')'".replace(/'/g,"")) || bannerSrc.includes("(Día '+(stale.di+1)+')"),
  'the banner always names its own day index explicitly -- never conflated with whatever day the HOY card above it is showing');

// ── No fabricated auto-complete from this surface. ─────────────────────────
ok(!bannerSrc.includes('done_') , 'buildStaleSessionHomeBanner never writes a done_ entry directly -- it only renders and delegates, exactly like the T303 modal');

console.log('');
console.log('T311 — Home stale/resume surface: ' + pass + ' assertions PASSED. FINDING 2 (T307) closed.');
