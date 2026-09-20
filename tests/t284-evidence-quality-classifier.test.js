'use strict';
/**
 * T284 — Canonical evidence-quality classifier. Executes the REAL
 * _classifyEvidenceQuality: PRESENCE != RELIABILITY. Pure, deterministic,
 * takes already-computed domain signals (never re-derives raw data
 * itself).
 *
 * Run: node tests/t284-evidence-quality-classifier.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

const enumSrc = extractFunction(COACH, 'var EVIDENCE_QUALITY = {').replace(/^var EVIDENCE_QUALITY = /, '');
const src = extractFunction(COACH, 'function _classifyEvidenceQuality(input)');
ok(src, '_classifyEvidenceQuality extracts cleanly');
ok(COACH.includes('window.VDSEN_EVIDENCE = {') && COACH.includes('classify: _classifyEvidenceQuality'), 'exposed via window.VDSEN_EVIDENCE.classify');
ok(!/setDoc|updateDoc|addDoc|runTransaction|getDoc\(/.test(src), '_classifyEvidenceQuality performs no Firestore reads/writes -- pure judgment over given signals only');

const classify = new Function('var EVIDENCE_QUALITY = ' + enumSrc + ';\nreturn ' + src)();

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing -- UNRESOLVED, never guessed as normal/zero.
// ─────────────────────────────────────────────────────────────────────────────
{
  ok(classify({ value: undefined }).status === 'UNRESOLVED', 'undefined value -> UNRESOLVED');
  ok(classify({ value: null }).status === 'UNRESOLVED', 'null value -> UNRESOLVED');
  ok(classify({ value: 0 }).status !== 'UNRESOLVED', 'an explicit 0 is a REAL value, not missing -- truthy-check trap avoided');
  ok(classify({ value: false }).status !== 'UNRESOLVED', 'an explicit false is a REAL value, not missing');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Conflict flag outranks everything else.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify({ value: 80, conflict: true, legacy: true, completeness: 0.2 });
  ok(r.status === 'CONFLICTING', 'an explicit conflict flag -> CONFLICTING, outranking legacy/partial signals present at the same time');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Identity mismatch / unknown identity.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rUnknown = classify({ value: 80, identity: { expected: 'pid-1', actual: null } });
  ok(rUnknown.status === 'UNRESOLVED', 'expected identity given but actual identity unknown -> UNRESOLVED, never assumed to match');
  const rMismatch = classify({ value: 80, identity: { expected: 'pid-1', actual: 'pid-2' } });
  ok(rMismatch.status === 'CONFLICTING', 'a REAL, different identity -> CONFLICTING (a proven mismatch, not just unknown)');
  const rMatch = classify({ value: 80, identity: { expected: 'pid-1', actual: 'pid-1' } });
  ok(rMatch.status === 'VALID', 'matching identity -> proceeds to VALID (no mismatch found)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Legacy -- no safe identity to compare at all.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify({ value: 80, legacy: true });
  ok(r.status === 'LEGACY', 'legacy flag (no safe identity at all) -> LEGACY, distinct from a proven identity mismatch');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Scope mismatch (domain-relative, e.g. week != currentWeek).
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify({ value: { peso: 80 }, expectedScope: 5, actualScope: 4 });
  ok(r.status === 'STALE', 'evidence scoped to week 4 read as if it were week 5 -> STALE');
  const rSameScope = classify({ value: { peso: 80 }, expectedScope: 5, actualScope: 5 });
  ok(rSameScope.status === 'VALID', 'matching scope -> proceeds to VALID');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Partial -- real but incomplete evidence.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify({ value: [1], completeness: 1 / 7 });
  ok(r.status === 'PARTIAL' && r.completeness === 1 / 7, '1 of 7 decision-window days -> PARTIAL, with the real completeness fraction carried through');
  const rFull = classify({ value: [1, 2, 3, 4, 5, 6, 7], completeness: 1 });
  ok(rFull.status === 'VALID', 'completeness of exactly 1 -> VALID, not PARTIAL');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Nothing wrong -- VALID.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = classify({ value: 80 });
  ok(r.status === 'VALID' && r.reason === 'ok', 'a plain present value with no quality signals flagged -> VALID');
}

console.log('');
console.log('T284 — Evidence quality classifier: ' + pass + ' assertions PASSED');
