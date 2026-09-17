'use strict';
/**
 * T132 — Unsafe HTML rendering audit.
 *
 * CLIENT (vdsen-cliente.html) already has an established, correctly-applied
 * escape pattern for exercise names: three separate exercise-card builders
 * (the main workout card, the session-dashboard card, and the exposure-history
 * card) all wrap the exercise name with _escHTml() before interpolating it
 * into an innerHTML template. Two DOM sinks broke that pattern:
 *
 *   1. showExModModal() — the "adjust exercise" bottom-sheet title interpolated
 *      the raw exercise name into overlay.innerHTML. A coach-entered or
 *      imported exercise name containing `<img src=x onerror=...>` would
 *      execute in the CLIENT's browser when they opened that modal (P1,
 *      cross-actor: coach/import data -> client execution context).
 *
 *   2. showExSubModal() / showExSubModalWithPattern() — the "change exercise"
 *      panel interpolated currentNombre/originalNombre/the alt exercise name
 *      (all exercise-name data, same cross-actor risk as #1) AND the
 *      previously-saved substitution reason (prevNota, client's own free
 *      text) directly into a <textarea>...</textarea> body with zero
 *      escaping — a saved reason containing `</textarea><script>` would break
 *      out of the textarea and execute (self-XSS, but a real textarea-breakout
 *      the coachNote/clientMessage textareas elsewhere already guard against).
 *
 *   3. buildSustPanel() (nutrition substitution panel) — the custom food name
 *      a client can type via "add custom food" was interpolated raw into the
 *      food-row label. Client-authored free text rendered back into that
 *      same client's own DOM unescaped (self-XSS).
 *
 * Fix: reuse the existing _escHTml() helper at each of these interpolation
 * points — same helper, same convention already used by the three exercise
 * cards that were already safe. No new sanitizer, no format change to
 * surrounding markup, no id/data-attr/handler touched.
 *
 * Run: node tests/t132-unsafe-html-rendering.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

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

assert.ok(
  CLIENT.includes('function _escHTml(s)'),
  '_escHTml helper must exist in CLIENT (reused by this fix, not reinvented)'
);

// ─────────────────────────────────────────────────────────────────────────────
// Sink 1 — showExModModal: exercise-name title in the "adjust exercise" modal
// ─────────────────────────────────────────────────────────────────────────────

const showExModModalFn = extractFunction(CLIENT, 'function showExModModal(di, ei)');
assert.ok(showExModModalFn, 'showExModModal must exist');
assert.ok(
  /overlay\.innerHTML\s*=[\s\S]*?_escHTml\(nombre\)/.test(showExModModalFn),
  'T132: showExModModal must escape the exercise name before writing overlay.innerHTML'
);
assert.ok(
  !/>['"]?\s*\+\s*nombre\s*\+\s*['"]?</.test(showExModModalFn.replace(/_escHTml\(nombre\)/g, '')),
  'T132: no remaining raw "+nombre+" interpolation should exist in showExModModal'
);

console.log('Sink 1 (showExModModal exercise-name title) — escaped, OK');

// ─────────────────────────────────────────────────────────────────────────────
// Sink 2 — showExSubModal / showExSubModalWithPattern: exercise names + note
// ─────────────────────────────────────────────────────────────────────────────

const showExSubModalFn = extractFunction(CLIENT, 'function showExSubModal(di, ei)');
assert.ok(showExSubModalFn, 'showExSubModal must exist');

for (const needle of [
  '_escHTml(prevNota)',   // textarea body — textarea-breakout risk
  '_escHTml(a)',          // alt exercise name in the alternatives list
  '_escHTml(originalNombre)', // "restore original" button label
  '_escHTml(currentNombre)',  // panel header
]) {
  assert.ok(
    showExSubModalFn.includes(needle),
    'T132: showExSubModal must contain ' + needle
  );
}

const showExSubModalWithPatternFn = extractFunction(CLIENT, 'function showExSubModalWithPattern(di, ei, pattern)');
assert.ok(showExSubModalWithPatternFn, 'showExSubModalWithPattern must exist');

for (const needle of ['_escHTml(prevNota)', '_escHTml(a)', '_escHTml(currentNombre)']) {
  assert.ok(
    showExSubModalWithPatternFn.includes(needle),
    'T132: showExSubModalWithPattern must contain ' + needle
  );
}

console.log('Sink 2 (showExSubModal[WithPattern] exercise names + note textarea) — escaped, OK');

// ─────────────────────────────────────────────────────────────────────────────
// Sink 3 — buildSustPanel: custom food name in the nutrition substitution panel
// ─────────────────────────────────────────────────────────────────────────────

const buildSustPanelFn = extractFunction(CLIENT, 'function buildSustPanel(key, alimTxt, isInOpcion)');
assert.ok(buildSustPanelFn, 'buildSustPanel must exist');
assert.ok(
  buildSustPanelFn.includes('_escHTml(label)'),
  'T132: buildSustPanel must escape the food label (may contain client-entered custom food name)'
);

console.log('Sink 3 (buildSustPanel custom food label) — escaped, OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guard — payload behavior simulated directly against _escHTml
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-new-func
const _escHTml = new Function(
  'return ' + extractFunction(CLIENT, 'function _escHTml(s)')
)();

const payload = '<img src=x onerror=alert(1)>';
const escaped = _escHTml(payload);
assert.ok(!escaped.includes('<img'), 'T132: escaped payload must not contain a raw <img tag');
assert.strictEqual(
  escaped, '&lt;img src=x onerror=alert(1)&gt;',
  'T132: _escHTml must escape < and > (breaks the tag) while leaving the text otherwise intact'
);

const normalText = 'Press banca inclinado';
assert.strictEqual(
  _escHTml(normalText), normalText,
  'T132: normal exercise-name text must render unchanged (no false-positive mangling)'
);

const textareaBreakout = 'sin máquina disponible</textarea><script>alert(1)</script>';
const escapedBreakout = _escHTml(textareaBreakout);
assert.ok(
  !escapedBreakout.includes('</textarea>') && !escapedBreakout.includes('<script>'),
  'T132: a textarea-breakout payload must not survive escaping'
);

console.log('Regression guard: payload neutralized, normal text unchanged — OK');

console.log('');
console.log('T132 — unsafe HTML rendering: ALL ASSERTIONS PASSED');
