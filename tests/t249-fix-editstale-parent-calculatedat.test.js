'use strict';
/**
 * T249 — Fix the T170/T241 stale-evidence debt: weeklyDecision's
 * "editStale" check (and its 2 sibling copies in the Coach Monitor) read
 * `r.calculatedAt` off an INDIVIDUAL recommendation object, but
 * vdsen-cliente.html only ever stamps `calculatedAt` once, on the PARENT
 * progrec_{W}_{D} object -- so this check silently never fired in
 * production for any recommendation (r.calculatedAt was always
 * undefined). Fixed to read the real, canonical source: the parent
 * entry's own calculatedAt. No timestamp fabricated -- the parent's
 * calculatedAt already existed and was already correct; only WHICH field
 * gets read changes.
 *
 * Run: node tests/t249-fix-editstale-parent-calculatedat.test.js
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

// ─────────────────────────────────────────────────────────────────────────────
// All 3 real consumers audited in T241 now read the PARENT's calculatedAt,
// never the individual recommendation's (which is never set).
// ─────────────────────────────────────────────────────────────────────────────

ok(!COACH.includes('&& r.calculatedAt &&'), 'no remaining consumer anywhere reads calculatedAt off the individual recommendation object in an actual check (only in explanatory comments)');
ok(COACH.includes('var editStale = !!(planDoc && planDoc.updatedAt && entry.calculatedAt && Date.parse(planDoc.updatedAt) > Date.parse(entry.calculatedAt));'),
  '_computeWeeklyDecisionForRequest (Generator path) now reads the parent entry\'s calculatedAt');
ok(COACH.includes('const editStale = !!(p && p.updatedAt && lastRec.calculatedAt && Date.parse(p.updatedAt) > Date.parse(lastRec.calculatedAt));'),
  'the Coach Monitor\'s weekly-decision review-count copy now reads the parent lastRec\'s calculatedAt');
ok(COACH.includes('return !!(p && p.updatedAt && lastRec && lastRec.calculatedAt && Date.parse(p.updatedAt) > Date.parse(lastRec.calculatedAt));'),
  '_isCoachEditStale (the Coach Monitor\'s per-recommendation categorizer) now reads the parent lastRec\'s calculatedAt via closure');

// No artificial copying of calculatedAt onto each recommendation -- the
// parent-level field is reused as-is, per the ticket's own instruction.
ok(!COACH.includes('r.calculatedAt = entry.calculatedAt') && !COACH.includes('r.calculatedAt = lastRec.calculatedAt'),
  'calculatedAt is never artificially copied down onto each individual recommendation -- the fix reads the real parent field directly, no fabrication');

// ─────────────────────────────────────────────────────────────────────────────
// Functional regression: _computeWeeklyDecisionForRequest's editStale path,
// end to end, via the real function (not a re-implementation).
// ─────────────────────────────────────────────────────────────────────────────

const fnSrc = extractFunction(COACH, 'function _computeWeeklyDecisionForRequest(entries, planDoc)');
ok(fnSrc, '_computeWeeklyDecisionForRequest extracts cleanly');

const fakeWindow = {
  VDSEN_WEEKLY: { classify: function() { return 'PROGRESSING'; }, decideVolume: function() { return 'KEEP'; } },
  VDSEN_ADHERENCE: undefined
};
const fn = new Function('window', fnSrc + ';\nreturn _computeWeeklyDecisionForRequest;')(fakeWindow);

function baseEntries(progrecOverrides) {
  return Object.assign({
    engine_state: { weekNum: 1 },
    'progrec_1_0': Object.assign({
      recommendations: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-1', action: 'maintain' }]
    }, progrecOverrides)
  });
}

(function testParentCalculatedAtUsed_OlderThanPlanEdit_MarksStale() {
  // Plan edited AFTER the recommendation was calculated -> genuinely stale.
  const entries = baseEntries({ calculatedAt: '2026-01-01T00:00:00.000Z' });
  const planDoc = { updatedAt: '2026-02-01T00:00:00.000Z', days: [{ exercises: [{ prescriptionExerciseId: 'pid-1' }] }] };
  const result = fn(entries, planDoc);
  ok(result.reviewItems.indexOf('Sentadilla') !== -1, 'evidencia posterior (plan editado DESPUES del calculo) marca stale correctamente, ahora leyendo el timestamp real del padre');
})();

(function testParentCalculatedAtUsed_NewerThanPlanEdit_NotStale() {
  // Recommendation calculated AFTER the last plan edit -> NOT stale.
  const entries = baseEntries({ calculatedAt: '2026-03-01T00:00:00.000Z' });
  const planDoc = { updatedAt: '2026-02-01T00:00:00.000Z', days: [{ exercises: [{ prescriptionExerciseId: 'pid-1' }] }] };
  const result = fn(entries, planDoc);
  ok(result.reviewItems.indexOf('Sentadilla') === -1, 'evidencia anterior al edit (calculo mas reciente que el ultimo edit del plan) NO marca stale');
})();

(function testChildWithoutCalculatedAtStillWorks() {
  // The individual recommendation has NO calculatedAt of its own (the
  // real, always-true shape) -- confirms the fix doesn't depend on it.
  const entries = baseEntries({ calculatedAt: '2026-01-01T00:00:00.000Z' });
  ok(entries['progrec_1_0'].recommendations[0].calculatedAt === undefined, 'sanity: the individual recommendation genuinely has no calculatedAt of its own, exactly like real production data');
  const planDoc = { updatedAt: '2026-02-01T00:00:00.000Z', days: [{ exercises: [{ prescriptionExerciseId: 'pid-1' }] }] };
  const result = fn(entries, planDoc);
  ok(Array.isArray(result.reviewItems) && result.reviewItems.indexOf('Sentadilla') !== -1, 'recommendation child sin calculatedAt propio sigue funcionando correctamente -- el chequeo usa el padre, no se rompe ni lanza excepcion');
})();

(function testNoRealTimestampAnywhereStaysSafe() {
  // Neither the parent entry nor the plan doc has a usable timestamp ->
  // must never fabricate staleness out of nothing.
  const entries = baseEntries({}); // no calculatedAt on the parent either
  const planDoc = { updatedAt: '2026-02-01T00:00:00.000Z', days: [{ exercises: [{ prescriptionExerciseId: 'pid-1' }] }] };
  const result = fn(entries, planDoc);
  ok(result.reviewItems.indexOf('Sentadilla') === -1, 'ausencia real de timestamp (ni padre ni fallback) conserva el comportamiento seguro -- nunca fabrica staleness sin evidencia real');
})();

console.log('');
console.log('T249 — Fix editStale parent calculatedAt debt: ' + pass + ' assertions PASSED');
