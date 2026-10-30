'use strict';
/**
 * T260 — Presence vs explicit-empty semantics. _resolveOptionalPlanSection
 * distinguishes NOT PROVIDED (undefined) from EXPLICIT REMOVE (null) from
 * PROVIDED CONTENT (any real value), reusing plain JS/JSON semantics --
 * no new schema field. Reused by T261's activation/draft-save fix instead
 * of re-deriving the same branch per call site.
 *
 * Run: node tests/t260-presence-vs-explicit-empty.test.js
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

const fnSrc = extractFunction(COACH, 'function _resolveOptionalPlanSection(previousValue, incomingRawValue)');
ok(fnSrc, '_resolveOptionalPlanSection extracts cleanly');
ok(COACH.includes('window._resolveOptionalPlanSection = _resolveOptionalPlanSection;'), 'exposed for reuse');
ok(!fnSrc.includes('updateDoc') && !fnSrc.includes('setDoc'), 'pure function -- no Firestore access');

const resolve = new Function(fnSrc + '; return _resolveOptionalPlanSection;')();

// ─────────────────────────────────────────────────────────────────────────────
// A. NOT PROVIDED -> preserve previous.
// ─────────────────────────────────────────────────────────────────────────────

(function testNotProvided() {
  const prev = { calorias: 2500, texto: 'plan existente' };
  const result = resolve(prev, undefined);
  ok(result.action === 'PRESERVE' && result.value === prev, 'undefined (key genuinely absent) -> PRESERVE, returns the exact previous value unchanged');
})();

(function testNotProvidedWithNoPrevious() {
  const result = resolve(undefined, undefined);
  ok(result.action === 'PRESERVE' && result.value === undefined, 'no previous value either -> PRESERVE of undefined, never fabricated into {}');
})();

// ─────────────────────────────────────────────────────────────────────────────
// B. PROVIDED WITH CONTENT -> replace, even if the content is "empty-
// looking" (a real object with zeros, an empty comidas array from a
// deliberate Generator response) -- explicit presence is never
// second-guessed into "must have meant absent".
// ─────────────────────────────────────────────────────────────────────────────

(function testProvidedContent() {
  const prev = { calorias: 2500 };
  const incoming = { calorias: 1800, proteina: 150 };
  const result = resolve(prev, incoming);
  ok(result.action === 'REPLACE' && result.value === incoming, 'a real object -> REPLACE with the new value verbatim');
})();

(function testProvidedZeroedContentStillReplaces() {
  // A deliberately-included, all-zero nutrition object (the Generator DID
  // include the key) is still PROVIDED CONTENT, not treated as absence --
  // "do not guess intent" from the shape of the value, only from whether
  // the key itself was present.
  const result = resolve({ calorias: 2500 }, { calorias: 0, proteina: 0, comidas: [] });
  ok(result.action === 'REPLACE', 'a present-but-zeroed/empty-looking object is still REPLACE, never reinterpreted as absence just because its content looks empty');
})();

// ─────────────────────────────────────────────────────────────────────────────
// C. EXPLICIT REMOVE (null) -> clear, distinguishable from both A and B.
// ─────────────────────────────────────────────────────────────────────────────

(function testExplicitRemove() {
  const result = resolve({ calorias: 2500 }, null);
  ok(result.action === 'REMOVE' && result.value === null, 'null (explicit removal signal) -> REMOVE, distinct from both PRESERVE and REPLACE');
})();

// ─────────────────────────────────────────────────────────────────────────────
// The 3 actions are mutually exclusive and exhaustive for the inputs that
// matter -- never an ambiguous 4th state.
// ─────────────────────────────────────────────────────────────────────────────

(function testMutualExclusivity() {
  const actions = [resolve({}, undefined).action, resolve({}, null).action, resolve({}, {}).action, resolve({}, []).action, resolve({}, 0).action, resolve({}, '').action];
  ok(actions[0] === 'PRESERVE' && actions[1] === 'REMOVE' && actions.slice(2).every(function(a) { return a === 'REPLACE'; }),
    'undefined->PRESERVE, null->REMOVE, and every other real value (including falsy-but-present {}/[]/0/"") -> REPLACE -- no value is ever silently reclassified as absence');
})();

console.log('');
console.log('T260 — Presence vs explicit-empty semantics: ' + pass + ' assertions PASSED');
