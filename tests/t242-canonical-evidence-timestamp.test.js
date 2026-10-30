'use strict';
/**
 * T242 — Canonical evidence timestamp. _getLatestEvidenceTimestampForScope
 * operates purely on the real, non-fabricated sources T241 identified:
 * progrec.calculatedAt (EXERCISE, exact PID), aggregated to MUSCLE via
 * canonical exercise metadata, and postsession/ci_sem/inbodyResults for
 * CLIENT/MESOCYCLE. Never Date.now(), never render time, never
 * cross-target bleed, null when no real evidence exists.
 *
 * Run: node tests/t242-canonical-evidence-timestamp.test.js
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

const targetEnumSrc = COACH.slice(COACH.indexOf('var INTERVENTION_TARGET_TYPE = {'), COACH.indexOf('var INTERVENTION_DECISION_ACTION = {'));
const fnSrc = extractFunction(COACH, 'function _getLatestEvidenceTimestampForScope(targetType, targetId, entries, planDoc, clientDoc)');

ok(fnSrc, '_getLatestEvidenceTimestampForScope extracts cleanly');
ok(COACH.includes('window._getLatestEvidenceTimestampForScope = _getLatestEvidenceTimestampForScope;'), 'exposed for T243\'s reuse via the lazy window.* pattern from the early IIFE');
ok(!fnSrc.includes('Date.now()'), 'never fabricates a "right now" timestamp -- only reads real persisted fields');

// A small, fake canonical metadata table shadows the real (huge)
// _EXERCISE_CANONICAL_METADATA -- the function only cares that SOME table
// with this exact shape exists in scope, not its real contents.
const fakeCanonicalMetadata = `var _EXERCISE_CANONICAL_METADATA = {
  'sentadilla': { primaryMuscles: ['quads', 'gluteos'] },
  'press banca': { primaryMuscles: ['pectoral'] }
};`;

const eng = new Function(targetEnumSrc + ';\n' + fakeCanonicalMetadata + ';\n' + fnSrc + ';\nreturn _getLatestEvidenceTimestampForScope;')();

// ─────────────────────────────────────────────────────────────────────────────
// EXERCISE — exact PID match via recommendations[], parent calculatedAt.
// ─────────────────────────────────────────────────────────────────────────────

(function testExerciseScope() {
  const entries = {
    'progrec_1_0': { calculatedAt: '2026-01-15T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1' }] },
    'progrec_2_0': { calculatedAt: '2026-02-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1' }, { prescriptionExerciseId: 'pid-2' }] },
    'progrec_3_0': { calculatedAt: '2026-03-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-2' }] } // pid-1 NOT here -- must not bleed
  };
  ok(eng('EXERCISE', 'pid-1', entries, null, null) === '2026-02-01T00:00:00.000Z', 'EXERCISE: the LATEST progrec batch that actually contains this exact PID wins, not the globally latest batch');
  ok(eng('EXERCISE', 'pid-2', entries, null, null) === '2026-03-01T00:00:00.000Z', 'a different PID gets its own correct latest, independent of pid-1');
  ok(eng('EXERCISE', 'pid-NONE', entries, null, null) === null, 'a PID with no matching progrec entry anywhere -> null, never fabricated');
  ok(eng('EXERCISE', 'pid-1', {}, null, null) === null, 'no entries at all -> null');
})();

(function testExerciseNeverUsesIndividualRecCalculatedAt() {
  // Individual recommendation objects with their OWN (nonstandard/bogus)
  // calculatedAt must be ignored -- only the PARENT entry's calculatedAt
  // (the field genuinely written by vdsen-cliente.html) is real.
  const entries = {
    'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1', calculatedAt: '2099-01-01T00:00:00.000Z' }] }
  };
  ok(eng('EXERCISE', 'pid-1', entries, null, null) === '2026-01-01T00:00:00.000Z', 'uses the PARENT entry.calculatedAt, never a bogus/individual rec.calculatedAt (T241\'s documented gap)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// MUSCLE — aggregated via canonical PID->muscle metadata, never by name.
// ─────────────────────────────────────────────────────────────────────────────

(function testMuscleScope() {
  const planDoc = {
    days: [{ exercises: [
      { exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-squat' },
      { exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-bench' }
    ] }]
  };
  const entries = {
    'progrec_1_0': { calculatedAt: '2026-01-10T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-squat' }] },
    'progrec_2_0': { calculatedAt: '2026-02-10T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-bench' }] }
  };
  ok(eng('MUSCLE', 'quads', entries, planDoc, null) === '2026-01-10T00:00:00.000Z', 'MUSCLE: aggregates only PIDs whose CURRENT plan exercise trains this exact muscle (squat -> quads)');
  ok(eng('MUSCLE', 'pectoral', entries, planDoc, null) === '2026-02-10T00:00:00.000Z', 'a different muscle correctly picks its own exercise (bench -> pectoral), no cross-muscle bleed');
  ok(eng('MUSCLE', 'gluteos', entries, planDoc, null) === '2026-01-10T00:00:00.000Z', 'a muscle trained INDIRECTLY by the same exercise (squat is also gluteos in the canonical table) still resolves correctly via the real metadata');
  ok(eng('MUSCLE', 'espalda', entries, planDoc, null) === null, 'a muscle no CURRENT plan exercise trains -> null, never guessed');
  ok(eng('MUSCLE', 'quads', entries, null, null) === null, 'no planDoc at all -> no PID can be resolved to any muscle -> null, never fabricated');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT / MESOCYCLE — postsession.ts, ci_sem.fecha, inbodyResults[].ts.
// ─────────────────────────────────────────────────────────────────────────────

(function testClientScope() {
  const entries = {
    'postsession_1_0': { ts: Date.parse('2026-01-05T00:00:00.000Z') },
    'ci_sem_2': { fecha: '2026-02-10' }
  };
  const clientDoc = { inbodyResults: [{ ts: Date.parse('2026-03-01T00:00:00.000Z') }] };
  ok(eng('CLIENT', 'client-1', entries, null, clientDoc) === new Date(Date.parse('2026-03-01T00:00:00.000Z')).toISOString(), 'CLIENT: the freshest of postsession/ci_sem/inbody wins (here, inbody)');
  ok(eng('MESOCYCLE', 'meso-1', entries, null, null) === '2026-02-10', 'MESOCYCLE reuses the exact same client-level signals (no distinct source) -- here ci_sem, since no clientDoc/inbody was given');
  ok(eng('CLIENT', 'client-1', {}, null, null) === null, 'no client-level evidence anywhere -> null');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Unknown targetType -- never guessed.
// ─────────────────────────────────────────────────────────────────────────────

ok(eng('NOT_A_REAL_TYPE', 'x', {}, null, null) === null, 'an unrecognized targetType -> null, never a fallback guess');

console.log('');
console.log('T242 — Canonical evidence timestamp: ' + pass + ' assertions PASSED');
