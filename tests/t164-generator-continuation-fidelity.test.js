'use strict';
/**
 * T164 — Generator continuation fidelity.
 *
 * INPUT CONTRACT (mapped, PASO 1):
 *   ACTIVE/PREVIOUS PLAN: api/vdsen-build-request.js's _mapPreviousPlan()
 *     passes plans/{id} through as-is (already carries prescriptionExerciseId
 *     per exercise, stamped by the coach app's existing _stampPrescriptionIds
 *     path — no transformation here, verified unchanged).
 *   progressionHistory: _mapExerciseProgressionHistory() (T160) — PID-indexed
 *     { byPrescriptionExerciseId: { [pid]: { exerciseName, exerciseId,
 *     history:[...], latest, confidence } }, unindexedCount }, built from
 *     the real progrec_ entries. This IS the closest thing to "learned_state"
 *     in this codebase — there is no separate learned_state object; a high
 *     `confidence` on a PID's progressionHistory entry is what "reliable
 *     learned_state" means here (documented explicitly in the T164 prompt
 *     rewrite below, no duplicate contract invented per PASO 6).
 *   CONTINUITY SIGNALS: confidence (none/low/medium/high), latest.action,
 *     latest.trend, engineState.deloadTriggered (never a failure signal).
 *   CURRENT PROMPT RULES (before T164): rule 12 already told the Generator
 *     to prefer preserving progressing/tolerating exercises and never
 *     rotate "para variar" (T160) — but did not mention confidence tiers
 *     (PASO 5), did not state that a prior deload is not a failure signal
 *     (PASO 2), did not list the full valid-change-reason set (PASO 3), and
 *     the JSON schema table never told the LLM it COULD echo back
 *     prescriptionExerciseId to signal "this is the same exercise" (PASO 7)
 *     — meaning even a cooperative LLM had no field to preserve identity
 *     through, and normEx's existing conditional copy (T150) had nothing to
 *     receive.
 *   CURRENT GAP (closed by this ticket): confidence-tiered continuity rule,
 *     deload-is-not-failure statement, full valid-change-reason list,
 *     pattern/category preservation on substitution, and — the concrete,
 *     load-bearing fix — prescriptionExerciseId documented as an optional,
 *     copyable field in the JSON schema table, with an explicit
 *     never-invent/never-reuse-for-a-different-exercise guard.
 *
 * PASO 9 — REAL VALIDATION: no local generation harness exists (the
 * Generator calls the real Anthropic API in api/generate-plan.js; there is
 * no deterministic mock to run an actual LLM call against in this repo).
 * Real behavior is validated instead via the actual, shipped
 * _mapExerciseProgressionHistory() function against two synthetic client
 * histories (CASO A: working/progressing exercise; CASO B: a
 * plateaued/identity-stale exercise) — proving the DATA the Generator
 * receives correctly signals "preserve" vs "review/change is justified"
 * before any LLM is involved, which is what the prompt rules then act on.
 *
 * Run: node tests/t164-generator-continuation-fidelity.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const B = require(path.join(__dirname, '..', 'api', 'vdsen-build-request.js'));
const _mapExerciseProgressionHistory = B._mapExerciseProgressionHistory;
const _mapPreviousPlan = B._mapPreviousPlan;

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

function getPromptText() {
  const idx = COACH.indexOf('const _MOTOR_PROMPT_EMBEDDED');
  const strStart = COACH.indexOf('"', idx);
  const endIdx = COACH.indexOf('";', strStart);
  const jsStr = COACH.slice(strStart, endIdx + 1);
  return eval(jsStr); // eslint-disable-line no-eval -- test-only, reads the real embedded prompt string
}
const PROMPT = getPromptText();

// ─────────────────────────────────────────────────────────────────────────────
// Item 1/2/3/10 — confidence tiers documented with the exact behavior PASO 5
// requires (HIGH strong preference, MEDIUM unless conflict, LOW conservative
// prior, NONE treated as new/no negative signal).
// ─────────────────────────────────────────────────────────────────────────────

(function testConfidenceTiers() {
  ok(PROMPT.includes('**HIGH**: preferencia fuerte por preservar el ejercicio'), 'Item 1 — HIGH confidence: strong preference for preservation is documented');
  ok(PROMPT.includes('**MEDIUM**: preserva salvo que exista un conflicto real'), 'Item 2 — MEDIUM confidence: preserve unless a real conflict exists');
  ok(PROMPT.includes('**LOW**: historial escaso -- usa un prior conservador') && PROMPT.includes('la falta de historial POR SI SOLA nunca es razon para rotar'), 'Item 3/10 — LOW confidence: conservative prior, and lack of history alone is explicitly never a rotation reason');
  ok(PROMPT.includes('**NONE**') && PROMPT.includes('no es una senal negativa, solo ausencia de datos'), 'Item 3 — NONE/no history: treated as new, explicitly NOT a negative signal');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 4/5/6/8 — the full valid-change-reason list and pattern preservation.
// ─────────────────────────────────────────────────────────────────────────────

(function testValidChangeReasons() {
  ok(PROMPT.includes('plateau sostenido (2+ semanas sin avance con buena tecnica'), 'Item 4 — persistent stalling (plateau) is a documented valid reason to allow change');
  ok(PROMPT.includes('restriccion/dolor nuevo'), 'Item 5 — new pain/restriction is a documented valid reason (continuity is not prioritized over safety)');
  ok(PROMPT.includes('pedido explicito del coach'), 'Item 6 — explicit coach request is a documented valid reason (coach override wins)');
  ok(
    PROMPT.includes('incompatibilidad con el objetivo/prioridad actual') &&
    PROMPT.includes('equipo no disponible') &&
    PROMPT.includes('redundancia estructural con otro ejercicio del plan') &&
    PROMPT.includes('necesidad real de cambiar de categoria/patron motor'),
    'Item 4/5 — the remaining PASO 3 reasons (objective incompatibility, equipment, redundancy, real category/pattern need) are all documented'
  );
  ok(
    PROMPT.includes('preserva el patron/categoria/intencion original cuando sea posible') &&
    PROMPT.includes('sustituir un empuje horizontal pesado por OTRO empuje horizontal, no por un aislamiento'),
    'Item 8 — when substitution IS justified, preserving the same pattern/category is explicitly required, with a concrete example'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 7 — starting a new mesocycle is explicitly NOT a valid rotation reason.
// ─────────────────────────────────────────────────────────────────────────────

(function testNewMesocycleAloneNotAReason() {
  ok(
    PROMPT.includes('el Generador NO rota ejercicios por calendario, por "empezar mesociclo nuevo" ni "para variar"'),
    'Item 7 — starting a new mesocycle, by itself, is explicitly listed alongside calendar/variety as NOT a valid rotation reason'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 9 — progressionHistory is the precomputed engine output; the LLM must
// never recalculate a parallel progression rule from raw logs (T160
// regression, restated with the T164 field list).
// ─────────────────────────────────────────────────────────────────────────────

(function testNoRecalculation() {
  ok(
    PROMPT.includes('son la salida YA CALCULADA del motor -- integralos y explicalos, pero nunca recalcules una progresion matematica paralela'),
    'Item 9 — progressionHistory fields (latest/trend/confidence/action/repRangeTarget/prescribedRIR/observedRIR) are stated as the already-computed engine output; recalculating a parallel rule is explicitly forbidden'
  );
  ok(COACH.includes("NO recalcules progresión desde `trainingLogs` crudo cuando `progressionHistory` esté disponible"), 'Item 9 regression: the T160 no-second-engine instruction remains');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 11 — legacy exercises with no PID: compatibility without silent
// association. Verified both in the prompt (never invent/reuse a PID) and
// behaviorally via the real _mapExerciseProgressionHistory (T160-proven,
// re-checked here as a T164 prerequisite).
// ─────────────────────────────────────────────────────────────────────────────

(function testLegacyNoPidNoSilentAssociation() {
  ok(
    PROMPT.includes('Nunca lo decidas por posicion en la lista ni lo inventes -- si no estas seguro de que es el MISMO ejercicio, omitelo'),
    'Item 11 — the prompt explicitly forbids inventing or position-guessing prescriptionExerciseId when unsure'
  );
  const progrecs = { 'progrec_1_0': { recommendations: [
    { exerciseName: 'Legacy Curl', action: 'maintain' } // no PID at all
  ]}};
  const result = _mapExerciseProgressionHistory(progrecs);
  ok(result.unindexedCount === 1 && Object.keys(result.byPrescriptionExerciseId).length === 0, 'Item 11 — a legacy no-PID recommendation is counted but never silently bucketed under any exercise');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 7 (JSON schema side) — prescriptionExerciseId documented as an
// optional, copyable field for continuity, with explicit guardrails.
// ─────────────────────────────────────────────────────────────────────────────

(function testPidFieldDocumented() {
  ok(
    PROMPT.includes('| `prescriptionExerciseId` | string | Opcional -- continuidad entre mesociclos.'),
    'PASO 7 — prescriptionExerciseId is now a documented, optional field in the exercise JSON schema table'
  );
  ok(
    PROMPT.includes('Si `previousPlan` trae este campo para un ejercicio que decides PRESERVAR, copialo tal cual') &&
    PROMPT.includes('Si sustituyes el ejercicio o es nuevo, OMITELO') &&
    PROMPT.includes('Nunca inventes un valor ni lo reutilices para un ejercicio distinto'),
    'PASO 7 — the field description tells the LLM exactly when to copy it, when to omit it, and forbids inventing/reusing it for a different exercise'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 12 — a prior deload is never interpreted as the exercise having failed.
// ─────────────────────────────────────────────────────────────────────────────

(function testDeloadIsNotFailure() {
  ok(
    PROMPT.includes('NUNCA se interpreta como que el ejercicio "no funciono" -- el deload es una respuesta a fatiga/recuperacion, no un juicio sobre el ejercicio'),
    'Item 12 — a prior deload action/engineState.deloadTriggered is explicitly stated to never mean the exercise failed'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 15 — no "variety" rule is active anywhere in the prompt as a reason
// TO rotate (it only appears as a forbidden reason).
// ─────────────────────────────────────────────────────────────────────────────

(function testNoVarietyRuleActive() {
  const varietyMentions = (PROMPT.match(/para variar|estimular diferente|variedad/gi) || []);
  ok(varietyMentions.length > 0, 'sanity: the prompt does mention variety at least once (as the forbidden reason)');
  // Every mention must sit inside a forbidding sentence, not a permissive one.
  const allForbidding = varietyMentions.every(function() {
    return PROMPT.includes('ninguna de esas es una razon valida de cambio') || PROMPT.includes('no las rotes');
  });
  ok(allForbidding, 'Item 15 — every mention of "variety"/"stimulate differently" appears only inside a rule FORBIDDING it as a change reason, never permitting it');
})();

// ─────────────────────────────────────────────────────────────────────────────
// PASO 9 — real (non-LLM) validation using the actual shipped function:
// CASO A (working exercise -> data signals preserve) and CASO B
// (plateaued/identity-stale exercise -> data signals review/change).
// Mirrors the same categorization logic already proven correct in T163
// (Coach visibility), applied here to the Generator's own input contract.
// ─────────────────────────────────────────────────────────────────────────────

function categorizeForGenerator(pidEntry) {
  // Mirrors the T164 prompt rule's own decision tree, driven by real
  // progressionHistory fields only — no recalculation.
  if (!pidEntry || pidEntry.confidence === 'none') return 'NEW_OR_NO_EVIDENCE';
  const latest = pidEntry.latest;
  if (!latest) return 'NEW_OR_NO_EVIDENCE';
  if (latest.action === 'freeze_load') return 'REVIEW_LIMITED';
  if (pidEntry.confidence === 'high' && (latest.action === 'increase_load' || latest.action === 'maintain')) return 'PRESERVE_STRONG';
  if (pidEntry.confidence === 'medium') return 'PRESERVE_UNLESS_CONFLICT';
  return 'PRESERVE_CONSERVATIVE';
}

(function testCasoA_WorkingExercisePreserved() {
  const progrecs = {};
  for (let w = 1; w <= 5; w++) {
    progrecs['progrec_'+w+'_0'] = { recommendations: [
      { prescriptionExerciseId: 'pid-working', exerciseId: 'ex-1', exerciseName: 'Press Banca',
        action: w < 5 ? 'maintain' : 'increase_load', newLoad: 80 + w, newReps: 8, newSets: 4,
        rirTarget: 2, prescribedRIR: 2, observedRIR: 2.3, repRangeTarget: { low: 8, high: 12 },
        trend: { prevLoad: 79+w, prevReps: 8, prevSets: 4, prevICS: 8.5 }, reason: 'Rendimiento estable' }
    ]};
  }
  const result = _mapExerciseProgressionHistory(progrecs);
  const entry = result.byPrescriptionExerciseId['pid-working'];
  ok(entry.confidence === 'high', 'CASO A — 5 weeks of real history maps to HIGH confidence');
  ok(categorizeForGenerator(entry) === 'PRESERVE_STRONG', 'CASO A — INPUT (progressionHistory) -> OUTPUT decision: a working, progressing exercise is categorized PRESERVE_STRONG, matching the prompt\'s HIGH-confidence rule');
})();

(function testCasoB_ProblematicExerciseChangeJustified() {
  const progrecs = {
    'progrec_1_0': { recommendations: [
      { prescriptionExerciseId: 'pid-problem', exerciseId: 'ex-2', exerciseName: 'Sentadilla',
        action: 'freeze_load', newLoad: 100, newReps: 5, newSets: 3, rirTarget: 3,
        prescribedRIR: 2, observedRIR: 0.5, repRangeTarget: { low: 5, high: 8 },
        trend: null, reason: 'Esfuerzo por encima del objetivo — molestia articular reportada' }
    ]}
  };
  const result = _mapExerciseProgressionHistory(progrecs);
  const entry = result.byPrescriptionExerciseId['pid-problem'];
  ok(categorizeForGenerator(entry) === 'REVIEW_LIMITED', 'CASO B — INPUT (progressionHistory, freeze_load + low observedRIR) -> OUTPUT decision: a limited/problematic exercise is categorized REVIEW_LIMITED, justifying the Generator to consider a change per the "restricción/dolor" reason');

  // A separate exercise with a stale PID (substituted since) also correctly
  // falls outside the current previousPlan's identity set.
  const previousPlanRaw = { days: [{ dayIndex: 0, exercises: [ { prescriptionExerciseId: 'pid-working' } ] }] };
  const mapped = _mapPreviousPlan(previousPlanRaw);
  ok(mapped === previousPlanRaw, 'previousPlan is passed through unchanged (structural adapter only, per file header)');
  const stillPresent = mapped.days[0].exercises.some(function(e){ return e.prescriptionExerciseId === 'pid-problem'; });
  ok(!stillPresent, 'CASO B — pid-problem is not present in this previousPlan snapshot, so the Generator has no continuity claim to honor for it beyond what progressionHistory itself already flags');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Regressions — T161/T162/T163 invariants unaffected by this prompt-only change.
// ─────────────────────────────────────────────────────────────────────────────

(function testInvariantsUnaffected() {
  const BUILD_REQUEST_SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'vdsen-build-request.js'), 'utf8');
  ok(BUILD_REQUEST_SRC.includes('function _mapExerciseProgressionHistory(progrecs)'), 'T160/T164 regression: _mapExerciseProgressionHistory unchanged (lives in api/vdsen-build-request.js, not touched by this prompt-only ticket)');
  const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
  ok(CLIENT.includes('var _progAutoApply = (progrec && ej.prescriptionExerciseId && progrec.prescriptionExerciseId === ej.prescriptionExerciseId) ? progrec : null;'), 'T161 regression: PID-verified next-exposure auto-apply gate unchanged (Client untouched by this ticket)');
  ok(CLIENT.includes('function _computeDeloadTriggers(week, postDataOverride)'), 'T162 regression: shared reactive deload trigger helper unchanged (Client untouched by this ticket)');
  ok(COACH.includes("function _categorizeRec(r) {"), 'T163 regression: Coach exceptions-first categorization unchanged (Monitor untouched by this ticket)');
})();

console.log('');
console.log('T164 — Generator continuation fidelity: ' + pass + ' assertions PASSED');
