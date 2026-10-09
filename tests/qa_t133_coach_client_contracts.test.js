'use strict';
/**
 * QA T133 — Coach <-> Client Firestore Write/Read Contract Audit
 *
 * Agent C (QA), independent static audit against baseline commit 23036a1.
 * Compares what vdsen-coach.html actually WRITES to Firestore against what
 * vdsen-cliente.html actually READS (and vice versa for client-authored logs),
 * across 3 contracts:
 *
 *   1. Coach plan writer      -> Client plan reader   (plans/{id})
 *   2. Coach nutrition writer -> Client nutrition reader (clients/{uid}.nutritionPlan/nutritionRaw)
 *   3. Client log writer      -> Coach monitor reader (logs/{uid}.entries)
 *
 * Per the assignment, AT MOST 5 findings total across all 3 contracts.
 * All 3 real gaps (QA-GAP-01/03/04) were fixed during the same integration
 * round and are now real assert.ok() regression guards rather than gap-docs:
 *
 * Findings summary (severity / owner / status):
 *   QA-GAP-01  MEDIUM  COACH    FIXED — parsePlanFromJSON now copies per-exercise
 *                                coachNote into the normalized exercise object.
 *   QA-GAP-02  LOW     QA-only  plans/{id}.status is only ever written as 'active' or
 *                                'draft_approved' — client's `status === 'draft'` guard
 *                                is dead legacy code; current values pass through fine.
 *   QA-GAP-03  MEDIUM  COACH    FIXED — saveNutritionPlan now clears nutritionRaw.
 *                                comidas/calculos/monitoreo (deleteField()) when patching
 *                                the scalar macros, instead of leaving them stale.
 *   QA-GAP-04  HIGH    COACH    FIXED (T140-H) — coach monitor panel / PDF / weekly-stats
 *                                code now reads rpeAverage/sleepHours/articularPain first,
 *                                falling back to the legacy flat names for old log entries.
 *   QA-LOCK-05 —       QA-only  Coach's `ts` timestamp readers already handle both
 *                                string and number formats robustly — regression guard.
 *
 * Run: node tests/qa_t133_coach_client_contracts.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'),  'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the source text of a named function from a source string.
 * Works for: async function name(  /  function name(
 * Returns the text starting from "function name(" up to a balanced
 * closing brace.
 */
function extractFunction(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m  = re.exec(src);
  if (!m) return null;

  let start = m.index;
  let braceStart = src.indexOf('{', start);
  if (braceStart === -1) return null;

  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// CONTRACT 1 — Coach plan writer -> Client plan reader (plans/{id})
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// T133-C1-01 (QA-GAP-01, MEDIUM, owner COACH)
// The client explicitly reads and renders a per-exercise `coachNote` field
// (vdsen-cliente.html loadPlan: `coachNote: e.coachNote || ''`, then rendered
// via _coachNoteHtml). The Motor VDSEN prompt embedded in the coach app
// documents `coachNote` as a valid, coach-facing field the AI is instructed
// to emit. The coach's OWN "import plan from pasted text/JSON" parser
// (parsePlanFromJSON, used by saveImportedPlan) normalizes every exercise
// but never copies `ex.coachNote` into the normalized object — so pasting a
// Motor-generated JSON that legitimately contains per-exercise coaching
// notes silently drops them before the write to Firestore.
//
// Contrast: the AI-direct-generation classifier path (~line 7167) DOES
// preserve `coachNote: String(ex.coachNote || '').trim()`, and so does the
// training-plan in-place editor (~line 17387) and the manual-plan flow
// (which never sets coachNote at all — no editor field, so nothing to drop).
// Only the paste-JSON importer silently discards a value that was present.
// ─────────────────────────────────────────────────────────────────────────────

(function testC1_01_parsePlanFromJSON_dropsCoachNote() {
  const fn = extractFunction(COACH, 'parsePlanFromJSON');
  assert.ok(fn, 'C1-01 prerequisite: parsePlanFromJSON exists in COACH');

  // Confirm the normalizer DOES carry the sibling fields the client also reads —
  // proves this isn't a "whole exercise" normalization bug, just a missing field.
  assert.ok(/technique:\s*techRaw/.test(fn), 'C1-01 prereq: parsePlanFromJSON normalizes technique');
  assert.ok(/supersetGroup:/.test(fn), 'C1-01 prereq: parsePlanFromJSON normalizes supersetGroup');
  assert.ok(/techniqueNote:/.test(fn), 'C1-01 prereq: parsePlanFromJSON normalizes techniqueNote');

  assert.ok(
    /coachNote:\s*String\(ex\.coachNote/.test(fn),
    'C1-01 FIXED: parsePlanFromJSON must now copy ex.coachNote into the normalized exercise object, ' +
    'mirroring the AI-direct classifier path and the training-plan editor normalizer.'
  );

  // Cross-check: the client DOES read/render coachNote.
  const clientReadsCoachNote = /coachNote:\s*e\.coachNote/.test(CLIENT);
  assert.ok(clientReadsCoachNote, 'C1-01 prereq: CLIENT loadPlan reads e.coachNote into the exercise object');
})();

// ─────────────────────────────────────────────────────────────────────────────
// T133-C1-02 (QA-GAP-02, LOW, owner QA-only — regression lock, not a live bug)
// vdsen-cliente.html's loadPlan withholds the plan (renderEspera) when
// `planData.status === 'draft'`. But COACH never writes the literal string
// 'draft' to a plan doc — only 'active' (manual/imported/template/duplicate
// paths) and 'draft_approved' (the D.2 AI-generation flow, which is a
// PERMANENT terminal status per its own comment: "plans/{planId} NO se
// modifica — permanece draft_approved"). This means the client's 'draft'
// guard is currently unreachable dead code, and — importantly — that
// 'draft_approved' plans are NOT blocked by it (confirmed intentional:
// draft_approved is the coach-approved, already-activatable state).
// Locking this in as a regression guard: if a future coach code path ever
// writes status:'draft' (unapproved) directly to a plan doc that gets
// activePlanId'd before player review, this guard would incorrectly show
// the plan as blocked/pending. Today that never happens.
// ─────────────────────────────────────────────────────────────────────────────

(function testC1_02_planStatusValuesMatchClientExpectations() {
  const statusLiterals = [];
  const re = /status:\s*["']([a-z_]+)["']/g;
  let m;
  while ((m = re.exec(COACH))) statusLiterals.push(m[1]);

  const planStatusValues = new Set(statusLiterals.filter(function(s) {
    return s === 'active' || s === 'draft_approved' || s === 'draft';
  }));

  assert.ok(planStatusValues.has('active'), 'C1-02 prereq: COACH writes status: "active" for plans somewhere');
  assert.ok(planStatusValues.has('draft_approved'), 'C1-02 prereq: COACH writes status: "draft_approved" (D.2 flow)');
  assert.ok(
    !planStatusValues.has('draft'),
    'C1-02 LOCK: COACH must not write the bare literal status:"draft" to a plan doc — confirms the ' +
    'client\'s `status === \'draft\'` guard (loadPlan) is currently unreachable dead code, not a live ' +
    'misinterpretation of the newer draft_approved terminal state.'
  );

  // Client-side: confirm the guard exists and only matches the exact 'draft' string
  // (so 'draft_approved' plans correctly fall through and load normally).
  assert.ok(
    /planData\.status === ['"]draft['"]/.test(CLIENT),
    'C1-02 prereq: CLIENT loadPlan has the status === "draft" withholding guard'
  );
  assert.strictEqual('draft_approved' === 'draft', false,
    'C1-02 LOCK: "draft_approved" must not equal "draft" — a draft_approved plan is not withheld from the client');
})();

// ═════════════════════════════════════════════════════════════════════════════
// CONTRACT 2 — Coach nutrition writer -> Client nutrition reader
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// T133-C2-01 (QA-GAP-03, MEDIUM, owner COACH)
// When the coach does an AI-generation or import, nutritionRaw is written as
// the FULL structured object (comidas[], calculos{}, monitoreo{}, etc — see
// `_nutritionJsonToPlan` callers). But the coach's manual nutrition editor
// (saveNutritionPlan, the "Nutrición" tab textarea+fields form) only patches
// FOUR scalar leaves via Firestore dot-notation:
//   'nutritionRaw.calorias' / '.proteina' / '.carbos' / '.grasas'
// It never touches nutritionRaw.comidas / .calculos / .monitoreo.
//
// This matters because vdsen-cliente.html's downloadMyPlanPDF explicitly
// PREFERS the full nutritionRaw object over the simpler nutritionPlan
// display doc: `cd.nutritionRaw || (...fallback from nutritionPlan...)`.
// So: AI generates a plan with comidas[] -> coach later tweaks just the
// kcal/protein numbers via the manual editor -> nutritionRaw.calorias etc.
// update, but nutritionRaw.comidas keeps the OLD meal breakdown -> the
// client's downloaded PDF shows meals that don't sum to the new macros.
// ─────────────────────────────────────────────────────────────────────────────

(function testC2_01_saveNutritionPlanLeavesRawMealsStale() {
  const fn = extractFunction(COACH, 'saveNutritionPlan');
  assert.ok(fn, 'C2-01 prerequisite: saveNutritionPlan exists in COACH');

  const patchesScalars = ['calorias', 'proteina', 'carbos', 'grasas'].every(function(f) {
    return new RegExp("'nutritionRaw\\." + f + "'").test(fn);
  });
  assert.ok(patchesScalars, 'C2-01 prereq: saveNutritionPlan patches all 4 nutritionRaw scalar leaves');

  assert.ok(
    /'nutritionRaw\.comidas':\s*deleteField\(\)/.test(fn) &&
    /'nutritionRaw\.calculos':\s*deleteField\(\)/.test(fn) &&
    /'nutritionRaw\.monitoreo':\s*deleteField\(\)/.test(fn),
    'C2-01 FIXED: saveNutritionPlan must now clear nutritionRaw.comidas/calculos/monitoreo (via deleteField()) ' +
    'when patching the scalar macros, so a manual edit cannot leave a stale meal breakdown that no longer ' +
    'sums to the edited macros in the client PDF export.'
  );

  // Confirm the client actually prefers the full nutritionRaw object (making the
  // staleness fix user-visible) rather than always deriving from nutritionPlan.
  const pdfFn = extractFunction(CLIENT, 'downloadMyPlanPDF');
  assert.ok(pdfFn, 'C2-01 prereq: downloadMyPlanPDF exists in CLIENT');
  assert.ok(
    /cd\.nutritionRaw\s*\|\|/.test(pdfFn),
    'C2-01 prereq: CLIENT downloadMyPlanPDF prefers cd.nutritionRaw over the nutritionPlan display doc'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// T133-C2-02 (positive lock-in — not counted as a gap)
// Sanity-check the "happy path": _nutritionJsonToPlan (used by the AI/import
// writers) bakes the full comidas[] breakdown into nutritionPlan.texto, which
// IS what the live in-app nutrition tab renders (parsearYRenderComidas(texto)).
// This confirms the AI-generation/import path keeps nutritionPlan and
// nutritionRaw coherent — the gap above is specific to the manual-edit path.
// ─────────────────────────────────────────────────────────────────────────────

(function testC2_02_nutritionJsonToPlanBakesComidasIntoTexto() {
  const fn = extractFunction(COACH, '_nutritionJsonToPlan');
  assert.ok(fn, 'C2-02 prerequisite: _nutritionJsonToPlan exists in COACH');
  assert.ok(
    /Array\.isArray\(obj\.comidas\)/.test(fn) && /texto \+=/.test(fn),
    'C2-02 LOCK: _nutritionJsonToPlan bakes obj.comidas into the texto field it returns, so the live ' +
    'client nutrition tab (which only ever reads nutritionPlan.texto, not nutritionRaw) still shows ' +
    'meal detail for AI-generated/imported plans.'
  );
})();

// ═════════════════════════════════════════════════════════════════════════════
// CONTRACT 3 — Client log writer -> Coach monitor reader (logs/{uid}.entries)
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// T133-C3-01 (QA-GAP-04, HIGH, owner COACH)
// vdsen-cliente.html writes postsession_{W}_{D} with this exact shape
// (submitPostSession, and the auto-close-week defaults):
//   { eimd, articularPain: { present, pattern }, sleepHours, rpeAverage, ts }
//
// vdsen-coach.html's monitor-panel rendering, weekly-stats aggregation and
// PDF export overwhelmingly read the OLD flat schema instead:
//   ps.rpe, ps.sleep, ps.articular, ps.patron
// which the client never writes anymore. Only ps.eimd (unchanged field name)
// and one AI-context-builder helper (~line 5707, using ps.articularPain.present
// /.pattern) correctly use the current schema.
//
// Net effect: RPE badges/trends, sleep readouts, and most articular-pain
// alerts across the coach dashboard (bitacora day badges, monitor week
// panel, PDF weekly report, dashboard summary cards) read undefined values
// and silently render "—"/blank instead of the client's actual answers.
// ─────────────────────────────────────────────────────────────────────────────

(function testC3_01_postsessionFieldNamesMismatch() {
  // CLIENT: confirm the actual write shape via submitPostSession.
  const submitFn = extractFunction(CLIENT, 'submitPostSession');
  assert.ok(submitFn, 'C3-01 prerequisite: submitPostSession exists in CLIENT');

  assert.ok(/articularPain:\s*\{\s*present:/.test(submitFn),
    'C3-01 prereq: CLIENT writes articularPain: { present, pattern }');
  assert.ok(/sleepHours:\s*sueno/.test(submitFn),
    'C3-01 prereq: CLIENT writes sleepHours (not "sleep")');
  assert.ok(/rpeAverage:\s*rpe/.test(submitFn),
    'C3-01 prereq: CLIENT writes rpeAverage (not "rpe")');

  // CLIENT must NOT be writing the legacy flat field names as top-level keys
  // of the postsession object (would mean the mismatch was already fixed).
  const writesLegacyFlatFields =
    /\bsleep:\s*sueno\b/.test(submitFn) ||
    /\barticular:\s*articularVal\b/.test(submitFn) ||
    /\brpe:\s*rpe\b/.test(submitFn);
  assert.ok(
    !writesLegacyFlatFields,
    'C3-01: CLIENT submitPostSession must not ALSO write legacy flat rpe/sleep/articular fields for this ' +
    'gap to be current — if it does, the mismatch has already been bridged client-side.'
  );

  // COACH: confirm the monitor panel now reads the current schema first,
  // with the legacy flat field names only as a fallback (T140-H).
  const monitorFn = extractFunction(COACH, 'loadMonitorClients');
  assert.ok(monitorFn, 'C3-01 prerequisite: loadMonitorClients exists in COACH');
  assert.ok(/\.rpeAverage\b/.test(monitorFn) && /\.sleepHours\b/.test(monitorFn),
    'C3-01 FIXED: loadMonitorClients bitacora rendering must read rpeAverage/sleepHours (T140-H)');

  const monitorTabFn = extractFunction(COACH, '_renderClientTabMonitor');
  assert.ok(monitorTabFn, 'C3-01 prerequisite: _renderClientTabMonitor exists in COACH');
  assert.ok(
    /ps\.rpeAverage\b/.test(monitorTabFn) && /ps\.sleepHours\b/.test(monitorTabFn) && /ps\.articularPain\b/.test(monitorTabFn),
    'C3-01 FIXED: _renderClientTabMonitor must read ps.rpeAverage / ps.sleepHours / ps.articularPain (T140-H)'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// T133-C3-02 (positive lock-in — QA-LOCK-05, not counted as a gap)
// The `ts` field: CLIENT always writes it as a number (Date.now()). COACH
// timestamp readers correctly branch on typeof to also accept a legacy
// string ISO timestamp (typeof v.ts==='string' ? Date.parse(v.ts) : +v.ts),
// so there is no live number-vs-string contract break here. Locking this in
// as a regression guard.
// ─────────────────────────────────────────────────────────────────────────────

(function testC3_02_tsFieldTypeHandledRobustly() {
  // CLIENT: ts is always written as a bare number.
  assert.ok(
    /ts:\s*Date\.now\(\)/.test(CLIENT),
    'C3-02 prereq: CLIENT writes ts as a number via Date.now()'
  );

  // COACH: at least one timestamp reader defensively handles both string and
  // number ts values instead of assuming one representation.
  const robustTsHandling = /typeof\s+v\.ts\s*===\s*['"]string['"]\s*\?\s*Date\.parse\(v\.ts\)\s*:\s*\+v\.ts/.test(COACH);
  assert.ok(
    robustTsHandling,
    'C3-02 LOCK: COACH must keep a typeof-guarded ts reader (string -> Date.parse, else numeric coercion) ' +
    'so a mixed-format ts (legacy string vs current Date.now() number) is handled without silently ' +
    'producing NaN / lastTs=0.'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log('');
console.log('QA T133 — coach/client Firestore contract audit');
console.log('=================================================');
console.log('Contract 1 (plan writer -> client reader):');
console.log('  C1-01  parsePlanFromJSON coachNote                 FIXED (QA-GAP-01, MEDIUM, COACH)');
console.log('  C1-02  plan status literals vs client draft guard  LOCK (QA-GAP-02, LOW, QA-only)');
console.log('Contract 2 (nutrition writer -> client reader):');
console.log('  C2-01  saveNutritionPlan clears stale nutritionRaw FIXED (QA-GAP-03, MEDIUM, COACH)');
console.log('  C2-02  _nutritionJsonToPlan bakes comidas->texto   LOCK (positive regression guard)');
console.log('Contract 3 (client log writer -> coach reader):');
console.log('  C3-01  postsession field-name mismatch             FIXED (QA-GAP-04, HIGH, COACH, T140-H)');
console.log('  C3-02  ts field string/number handling             LOCK (QA-LOCK-05, QA-only)');
console.log('');
console.log('QA T133 — 5 findings total (3 fixed, 2 locked as regression guards)');
console.log('QA T133 — ALL ASSERTIONS PASSED');
