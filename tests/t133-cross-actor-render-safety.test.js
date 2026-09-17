'use strict';
/**
 * T133 — Cross-actor render safety (Coach-authored text -> Client render).
 *
 * Scope: vdsen-cliente.html only. Three coach-authored plan/text fields were
 * interpolated raw into innerHTML/template-literal sinks in the CLIENT app.
 * All three are data the CLIENT never controls (typed or imported by the
 * COACH into the plan/supplement text), so an unescaped render is a genuine
 * cross-actor XSS: a malicious or corrupted coach-authored string executes
 * in the CLIENT's browser.
 *
 * Sink 1 — _buildExCard(): `sets[].tempo` (vdsen-plan-v2 schema field, coach/
 *   AI-authored) was interpolated raw into a set-spec badge.
 *
 * Sink 2 — renderEntrenamiento(): the day/session label (`s.dia` / `ses.dia`,
 *   the plan day's `label` field) was interpolated raw at TWO points — the
 *   day-tab short label and the session header title.
 *
 * Sink 3 — formatTextoSup(): the coach's free-text supplement plan
 *   (`PLAN.suplementacion.texto`) is parsed into sections/items; the section
 *   title (`sec.titulo`), a supplement name that falls outside the known-name
 *   whitelist (`item.nombre`), and a free-text note line (`item.texto`) were
 *   all interpolated raw.
 *
 * Fix: reuse the existing _escHTml() helper at each point — same convention
 * already used correctly by _escHTml(nombre) in the three main exercise-card
 * builders and by _coachNoteHtml(). No new sanitizer, no markup/id/handler
 * changes.
 *
 * Run: node tests/t133-cross-actor-render-safety.test.js
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

assert.ok(CLIENT.includes('function _escHTml(s)'), '_escHTml helper must exist in CLIENT');

// ─────────────────────────────────────────────────────────────────────────────
// Sink 1 — _buildExCard: sets[].tempo badge
// ─────────────────────────────────────────────────────────────────────────────

const buildExCardFn = extractFunction(CLIENT, 'function _buildExCard(ejercicios, di, ei, isPartner)');
assert.ok(buildExCardFn, '_buildExCard must exist');
assert.ok(
  buildExCardFn.includes('_escHTml(setTempo)'),
  'T133 Sink 1: _buildExCard must escape setTempo before interpolating it into the set-spec badge'
);

console.log('Sink 1 (_buildExCard setTempo badge) — escaped, OK');

// ─────────────────────────────────────────────────────────────────────────────
// Sink 2 — renderEntrenamiento: day/session label (2 interpolation points)
// ─────────────────────────────────────────────────────────────────────────────

const renderEntrenamientoFn = extractFunction(CLIENT, 'function renderEntrenamiento()');
assert.ok(renderEntrenamientoFn, 'renderEntrenamiento must exist');
assert.ok(
  renderEntrenamientoFn.includes('_escHTml(rawLabel)'),
  'T133 Sink 2a: renderEntrenamiento must escape rawLabel in the day-tab short label'
);
assert.ok(
  /_escHTml\(\(ses\.dia\|\|'Sesión'\)\.replace/.test(renderEntrenamientoFn),
  'T133 Sink 2b: renderEntrenamiento must escape the session header title derived from ses.dia'
);

console.log('Sink 2 (renderEntrenamiento day/session label, 2 points) — escaped, OK');

// ─────────────────────────────────────────────────────────────────────────────
// Sink 3 — formatTextoSup: section title, fallback supplement name, note text
// ─────────────────────────────────────────────────────────────────────────────

const formatTextoSupFn = extractFunction(CLIENT, 'function formatTextoSup(texto)');
assert.ok(formatTextoSupFn, 'formatTextoSup must exist');

for (const needle of ['_escHTml(sec.titulo)', '_escHTml(item.nombre)', '_escHTml(item.texto)']) {
  assert.ok(
    formatTextoSupFn.includes(needle),
    'T133 Sink 3: formatTextoSup must contain ' + needle
  );
}

console.log('Sink 3 (formatTextoSup titulo/nombre/texto) — escaped, OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guard — payload behavior against the real _escHTml implementation
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-new-func
const _escHTml = new Function(
  'return ' + extractFunction(CLIENT, 'function _escHTml(s)')
)();

const payload = '<img src=x onerror=alert(1)>';
const escaped = _escHTml(payload);
assert.ok(!escaped.includes('<img'), 'T133: escaped payload must not contain a raw <img tag');
assert.strictEqual(
  escaped, '&lt;img src=x onerror=alert(1)&gt;',
  'T133: _escHTml must escape < and > while leaving the rest of the text intact'
);

const normalTempo = '3-1-2-0';
assert.strictEqual(_escHTml(normalTempo), normalTempo, 'T133: normal tempo text must render unchanged');

const normalDayLabel = 'Día 1: Empuje';
assert.strictEqual(_escHTml(normalDayLabel), normalDayLabel, 'T133: normal day label must render unchanged');

const normalSupNote = 'Tomar con el desayuno, no en ayunas';
assert.strictEqual(_escHTml(normalSupNote), normalSupNote, 'T133: normal supplement note must render unchanged');

console.log('Regression guard: payload neutralized, normal text unchanged — OK');

console.log('');
console.log('T133 — cross-actor render safety: ALL ASSERTIONS PASSED');
