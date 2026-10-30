'use strict';
/**
 * T154 — WHO-5 graceful fallback.
 *
 * Scope: Coach only — Monitor badges row, PDF/export lines that read ci.who5.
 * (T153 found the coach reads ci.who5 extensively while Client only writes it
 * conditionally via ciW5(), once all 5 WHO-5 sub-questions are answered — a
 * legitimate partial-completion case, not dead code.)
 *
 * Fix: a single shared helper, _ciWellnessFallbackText(ci), returns null when
 * who5 is present (legacy path untouched) or when no real Ehrenstein field is
 * present either, and otherwise returns a plain-text listing of whichever
 * real fields (estres, animo, fatiga, sueno_cal, dolor_gral, vulner) the
 * client DID report — no composite score, no new clinical thresholds. Wired
 * into the two genuinely-gapped display sites that previously showed a bare
 * "WHO-5: —" / omitted the badge entirely with no fallback:
 *   1. Monitor tab week-view badges (who5Badge construction).
 *   2/3. Two PDF export "Check-ins semanales" text lines.
 * Everywhere ci.who5 was already read as a truthy/null-guarded value with no
 * fallback UI need (dashboard alerts, digest, CSV export, JSON export, the
 * fixed weekly-stats table, the Monitor-detail Ehrenstein tile which already
 * exists independently) is left unchanged.
 *
 * Run: node tests/t154h-who5-graceful-fallback.test.js
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

// ─────────────────────────────────────────────────────────────────────────────
// Helper exists with the expected contract; evaluate it directly (pure fn).
// ─────────────────────────────────────────────────────────────────────────────

const helperSrc = extractFunction(COACH, 'function _ciWellnessFallbackText(ci)');
assert.ok(helperSrc, '_ciWellnessFallbackText must exist');

const _ciWellnessFallbackText = new Function('ci', helperSrc.slice(helperSrc.indexOf('{') + 1, helperSrc.lastIndexOf('}')));

// Test 1: ci con who5 → comportamiento legacy intacto (helper defers, returns null)
assert.strictEqual(
  _ciWellnessFallbackText({ who5: '60', estres: 4, animo: 5 }),
  null,
  'T154-H Test1: when who5 is present, the fallback helper must return null (legacy path untouched)'
);
assert.strictEqual(
  _ciWellnessFallbackText({ who5: '0' }), // falsy-but-defined edge case: '0' is != null
  null,
  'T154-H Test1b: who5 present as any non-null value (even "0") must short-circuit the fallback'
);

// Test 2 & 3: ci sin who5 → no alerta WHO5 falsa, campos reales de bienestar visibles
const fallback = _ciWellnessFallbackText({ estres: 4, animo: 2, fatiga: 3, sueno_cal: 5, dolor_gral: 1, vulner: 6 });
assert.ok(fallback, 'T154-H Test2/3: fallback must return a non-null string when real fields are present without who5');
assert.ok(fallback.includes('Estrés 4/5'), 'fallback must surface estres');
assert.ok(fallback.includes('Ánimo 2/5'), 'fallback must surface animo');
assert.ok(fallback.includes('Energía 3/5'), 'fallback must surface fatiga as Energía');
assert.ok(fallback.includes('Sueño 5/5'), 'fallback must surface sueno_cal');
assert.ok(fallback.includes('Dolor 1/5'), 'fallback must surface dolor_gral');
assert.ok(fallback.includes('Vulnerab. 6/7'), 'fallback must surface vulner on its own 1-7 scale');
assert.ok(!/WHO-?5/i.test(fallback), 'T154-H: fallback text must never contain the "WHO-5" label (must read as Bienestar/Check-in instead)');

// Test 4: no aparece NaN/undefined/WHO5 falso — empty ci and ci with no real fields
assert.strictEqual(_ciWellnessFallbackText({}), null, 'T154-H Test4: an empty ci (nothing reported) must yield null, never a fabricated string');
assert.strictEqual(_ciWellnessFallbackText(null), null, 'T154-H Test4b: a null ci must not throw and must yield null');
assert.strictEqual(_ciWellnessFallbackText(undefined), null, 'T154-H Test4c: an undefined ci must not throw and must yield null');

// Partial fields only (not all 6) must still produce a clean partial listing, no NaN/undefined leaking in.
const partial = _ciWellnessFallbackText({ estres: 3 });
assert.strictEqual(partial, 'Estrés 3/5', 'T154-H: a single real field present must produce a clean single-item listing');
assert.ok(!/NaN|undefined/.test(partial), 'T154-H: partial fallback text must never contain NaN/undefined');

console.log('_ciWellnessFallbackText: legacy who5 path untouched, real fields surfaced, no fake WHO-5/NaN/undefined — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Wiring: Monitor badges row uses the fallback when who5 is null.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  COACH.includes("const wellnessFallback = who5 == null ? _ciWellnessFallbackText(ci) : null;"),
  'T154-H: the Monitor badges row must compute a wellness fallback only when who5 is null'
);
assert.ok(
  /who5Badge = who5 != null[\s\S]*?: \(wellnessFallback \? `<div[\s\S]*?Bienestar \/ Check-in:<\/span>[\s\S]*?\$\{wellnessFallback\}[\s\S]*?<\/div>` : ''\);/.test(COACH),
  'T154-H: the who5Badge must fall back to a "Bienestar / Check-in" badge (not "WHO-5") when who5 is absent but real fields exist'
);

console.log('Monitor badges row wired to the wellness fallback, labeled "Bienestar / Check-in" — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Wiring: both PDF export "Check-ins semanales" lines use the fallback.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  COACH.includes("const wellnessLine = ci.who5 != null ? `WHO-5: ${ci.who5}` : (function(){ const fb = _ciWellnessFallbackText(ci); return fb ? `Bienestar/Check-in: ${fb}` : 'WHO-5: —'; })();"),
  'T154-H: the client-summary PDF (doc.text) must use the wellness fallback line, falling back to literal "—" only when nothing at all is available'
);
assert.ok(
  COACH.includes('doc.text(`Peso: ${ci.peso||\'—\'} kg  ·  HRV: ${ci.hrv||\'—\'}  ·  ${wellnessLine}`, margin + 18, y);'),
  'T154-H: the client-summary PDF text call must interpolate wellnessLine'
);

assert.ok(
  COACH.includes("const wellnessLine2 = ci.who5 != null ? `WHO-5 ${ci.who5}` : (function(){ const fb = _ciWellnessFallbackText(ci); return fb ? `Bienestar/Check-in ${fb}` : 'WHO-5 —'; })();"),
  'T154-H: the weekly-report PDF (pdf.text) must use the wellness fallback line'
);
assert.ok(
  COACH.includes('pdf.text(`Peso ${ci.peso ?? \'—\'} kg  ·  HRV ${ci.hrv ?? \'—\'}  ·  ${wellnessLine2}`, margin + 16, y);'),
  'T154-H: the weekly-report PDF text call must interpolate wellnessLine2'
);

console.log('Both PDF export lines wired to the wellness fallback — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guards — untouched sites keep their existing null-guarded
// behavior (already safe, out of T154 scope): dashboard alert, digest alert,
// JSON export, CSV export, fixed weekly-stats table, Monitor-detail tile.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  COACH.includes("if (ci.who5 && parseInt(ci.who5) < 52) extraBadges += '<span class=\"text-xs ml-1\" style=\"color:#FF4444\">WHO5↓</span>';"),
  'T154-H regression: the dashboard client-list row WHO5<52 alert must remain unchanged (already correctly guarded)'
);
assert.ok(
  COACH.includes("if (ci.who5 && parseInt(ci.who5) < 52) alerts.push({ type:'danger', text:'WHO-5 bajo ('+ci.who5+')' });"),
  'T154-H regression: the "Digest de hoy" WHO-5 alert must remain unchanged (already correctly guarded, no new thresholds added)'
);
assert.ok(
  COACH.includes('if (ci.who5!=null) o.who5=r0(+ci.who5);'),
  'T154-H regression: the machine-readable JSON export must keep its existing conditional who5 inclusion'
);
assert.ok(
  /who5: v\.who5 != null \? v\.who5 : ''/.test(COACH),
  'T154-H regression: the CSV/log export row builder must keep its existing empty-string fallback'
);
assert.ok(
  COACH.includes('<td>${ci.who5 ?? \'—\'}</td>'),
  'T154-H regression: the fixed-column weekly-stats HTML table must remain unchanged (already compliant with "—")'
);
assert.ok(
  COACH.includes('Monitoreo Subjetivo Ehrenstein — Sem'),
  'T154-H regression: the pre-existing, independent Ehrenstein monitoring tile in the Monitor detail view must remain unchanged'
);

console.log('All previously-safe who5 sites remain unchanged — no regressions — OK');

console.log('');
console.log('T154 — WHO-5 graceful fallback: ALL ASSERTIONS PASSED');
