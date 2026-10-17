'use strict';
/**
 * T317 — Nutrition daily logging UX hardening.
 *
 * A usable daily log UI already existed (buildNutriLogWidget /
 * guardarNutriLog, per-date `nutrilog_{YYYY-MM-DD}` key, already using the
 * correct real-await/no-false-success pattern per T126-C) -- this phase
 * HARDENS it rather than duplicating it, closing T315's FINDING 2 and
 * FINDING 3:
 *   FINDING 2: no validation before write -> now rejects negative/non-
 *     numeric values (0 remains explicitly valid) and aborts the write
 *     entirely (never a partial write of some valid + some invalid fields).
 *   FINDING 3: no stale-client-context guard -> now captures the uid before
 *     the await and never applies the result to a switched-away user's UI.
 *
 * Run: node tests/t317-nutrition-daily-logging-hardening.test.js
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

const src = extractFunction(CLIENT, 'async function guardarNutriLog() {');

// ── FINDING 2: validation before write, 0 stays valid. ─────────────────────
ok(src.includes('if (isNaN(_v) || _v < 0) {'), 'rejects NaN and negative values');
ok(src.indexOf('for (var _fi = 0;') < src.indexOf("var k = 'nutrilog_"),
  'validation runs BEFORE any LOGS mutation -- an invalid field aborts the whole save, never a partial write');
ok(!/_v <= 0|_v === 0/.test(src), '0 is never treated as invalid -- only NaN/negative are rejected (a real "ate nothing" or "0g fat" entry stays valid)');
ok(src.includes("if (!_el || _el.value === '') continue;"), 'an empty field is skipped (optional), not treated as an error -- only a filled-in invalid value blocks the save');

// ── FINDING 3: stale-client-context guard. ─────────────────────────────────
ok(src.includes('var _uidAtStart = USER && USER.uid;'), 'captures the client identity before the await (T127-H pattern)');
ok(src.indexOf('var _uidAtStart') < src.indexOf('await _doSaveLogs()'), 'identity is captured BEFORE the await, not after');
ok(src.includes("if (!USER || USER.uid !== _uidAtStart) return;"), 're-checks identity immediately after the await -- never shows a toast or re-renders into a UI that switched to a different (or no) client while the save was in flight');

// ── Existing correct behavior untouched. ───────────────────────────────────
ok(src.includes('var _ok = await _doSaveLogs();') && src.includes("if (_ok === false) {"), 'the existing real-await/no-false-success contract (T126-C) is preserved, not reimplemented');
ok(src.includes("_nlBtn.disabled = true") && src.includes('finally'), 'the existing double-submit guard (disable button, re-enable in finally) is preserved');

console.log('');
console.log('T317 — Nutrition daily logging hardening: ' + pass + ' assertions PASSED. FINDING 2 and FINDING 3 (T315) closed.');
