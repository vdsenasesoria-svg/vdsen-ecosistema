'use strict';
/**
 * T162 — Reactive deload integration.
 *
 * PASO 1 — LEGACY AUDIT (grep across vdsen-cliente.html, vdsen-coach.html,
 * api/*.js for: week===6, semana 6, deload, unload, recovery week,
 * mesocycle checkpoint, fixed week, autoDeload, fatigueScore, readiness,
 * recovery):
 *
 *   ACTIVE_CONFLICT (found and fixed here):
 *     - getAdjustedRIR(baseRIR, week, exName): `if (week === total) adj =
 *       base + 2;` — raised the prescribed RIR (i.e. applied a structural
 *       deload) on the literal last week of EVERY mesocycle, unconditionally,
 *       regardless of any real fatigue signal. This directly wrote into
 *       LOGS[key].rir on every completeSet() call and drove the RIR target
 *       shown everywhere in _buildExCard — a genuine "semana 6 = deload
 *       automático" in the one place that actually mutates/persists data.
 *     - getSemProgresion(week): `if (week >= total) return 'DELOAD';` — a
 *       calendar-only label reachable from a direct call site (the "SEM N ·
 *       {phase}" header at a non-checkpoint-aware render path), contradicting
 *       the main week-header's already-correct "SEMANA FINAL" (checkpoint,
 *       not automatic) framing for the exact same week.
 *     - The week-selector grid button: `var deload = w === _tw;` then
 *       `(deload?'DELOAD':getSemProgresion(w))` — bypassed getSemProgresion
 *       entirely for the last week, always showing "DELOAD" regardless of
 *       any reactive evidence. Removed; now always defers to the (now
 *       reactive-gated) getSemProgresion(w) — single source of truth.
 *
 *   SAFE_COMPATIBILITY (audited, correctly left untouched):
 *     - getY3TPhase(week, totalWeeks): `if (week >= totalWeeks) return
 *       'deload';` — this is the Y3T periodization METHOD's own structural
 *       phase rotation (S1/S2/S3/deload), opt-in per exercise via an
 *       explicit `technique:'y3t'` tag chosen by the coach, and it only
 *       changes rep-range/rest scheme for that named technique — never RIR,
 *       never load/volume progression. Already flagged and accepted as a
 *       "semántica de técnica, no heurística" exception in the T159 audit.
 *     - CLAUDE.md's "Objetivo del mesociclo" select option including the
 *       literal string "deload" is a coach-chosen MESOCYCLE GOAL (planning
 *       an intentionally light block), not an automatic per-week rule.
 *
 *   DOCUMENTATION_ONLY (fixed, zero behavioral risk):
 *     - A stale comment ("Avanza ... hasta 6 (deload)") on the week
 *       auto-advance loop, which already correctly used getTotalWeeks()
 *       dynamically — only the comment text was wrong, not the logic.
 *
 *   ACTIVELY USED, already correct (verified, no change needed):
 *     - calculateProgression()'s own isDeload gate (`deloadTriggers.length
 *       >= 2`, T159/T161) and the mesocycle-checkpoint header
 *       (`_isMesocycleCheckpoint` -> 'SEMANA FINAL', explicitly commented
 *       "NO implica deload automático").
 *     - vdsen-coach.html's Generator-side deloadCandidate/globalReadiness
 *       (buildPrescriptionContext): derived entirely from
 *       entries.engine_state.deloadTriggered (the ENGINE's own prior-cycle
 *       output) and real check-in WHO-5 averages — never from week number.
 *       api/vdsen-topology.js's `readiness` parameter is a pure consumer of
 *       this same already-reactive signal. No Generator-side conflict found.
 *
 * PASO 2 — INPUTS ACTUALLY USED (unchanged by this ticket, verified):
 *   WHO-5 (ci_sem_W.who5), RPE (postsession_W_D.rpeAverage), sleep
 *   (postsession_W_D.sleepHours), HRV trend (ci_sem_W.hrv vs W-1), energía
 *   subjetiva (ci_sem_W.energia). No new signal invented; no WHO-5
 *   synthesis; no new clinical score.
 *
 * PASO 3/4 — GATE / CANONICAL RESULTS: the existing >=2-trigger gate
 * (`_computeDeloadTriggers`) IS the "requires multimodal evidence, not a
 * single bad session" rule already — a single trigger never deloads.
 * Canonical outcomes already map onto the existing vocabulary: isDeload
 * false + non-checkpoint week -> NO_DELOAD; isDeload false + last week ->
 * CHECKPOINT_ONLY ("SEMANA FINAL"); isDeload true -> DELOAD_RECOMMENDED
 * (action:'deload', reduced load+sets); insufficient signals (all defaults,
 * 0 triggers) -> NO_DELOAD (never DELOAD by omission — no invented data).
 * REVIEW_REQUIRED already exists verbatim elsewhere in this codebase
 * (vdsen-coach.html's _resolveTrainingDaysIntent conflicts array) — reused
 * name, not reinvented, for the closest-matching case (coach requested more
 * days than the ficha's stated availability).
 *
 * FIX (this file's subject): extracted the trigger-detection logic (until
 * now duplicated verbatim inline inside calculateProgression) into a single
 * shared function, _computeDeloadTriggers(week, postDataOverride) — one
 * engine, two callers:
 *   - calculateProgression(di, postData) now calls
 *     _computeDeloadTriggers(CURRENT_WEEK, postData) (postData explicit,
 *     zero behavior change — same exact inputs as before).
 *   - getAdjustedRIR/getSemProgresion now call
 *     _computeDeloadTriggers(week) (no postData in scope at render time —
 *     derives EIMD/RPE/sleep from the most recent postsession_{week}_*
 *     LOGS entry, falling back to the same neutral defaults
 *     calculateProgression already used when none exists).
 *
 * Run: node tests/t162-reactive-deload-integration.test.js
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

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

const triggersSrc   = extractFunction(CLIENT, 'function _computeDeloadTriggers(week, postDataOverride)');
const adjustedRirSrc = extractFunction(CLIENT, 'function getAdjustedRIR(baseRIR, week, exName)');
const isFreeBarbellSrc = extractFunction(CLIENT, 'function _isFreeBarbell(exName)');
ok(triggersSrc && adjustedRirSrc && isFreeBarbellSrc, 'prerequisite: _computeDeloadTriggers/getAdjustedRIR/_isFreeBarbell must all be extractable');

function makeEngine(LOGS, totalWeeks) {
  const PLAN = { totalWeeks: totalWeeks };
  const factory = new Function(
    'LOGS', 'PLAN',
    'function getTotalWeeks(){ return (PLAN && PLAN.totalWeeks) ? PLAN.totalWeeks : 6; }\n' +
    isFreeBarbellSrc + ';\n' +
    triggersSrc + ';\n' +
    adjustedRirSrc + ';\n' +
    'return { getAdjustedRIR: getAdjustedRIR, _computeDeloadTriggers: _computeDeloadTriggers };'
  );
  return factory(LOGS, PLAN);
}

// ─────────────────────────────────────────────────────────────────────────────
// Item 1 — semana 6 (última) + buen rendimiento + buena recuperación -> NO_DELOAD
// ─────────────────────────────────────────────────────────────────────────────

(function testItem1() {
  const LOGS = { 'ci_sem_6': { who5: '80', hrv: '65', energia: '8' }, 'ci_sem_5': { hrv: '64' } };
  const eng = makeEngine(LOGS, 6);
  const res = eng._computeDeloadTriggers(6);
  ok(res.isDeload === false && res.triggers.length === 0, 'Item 1 — week 6 with good performance/recovery signals -> NO_DELOAD (0 triggers)');
  ok(eng.getAdjustedRIR(2, 6) === 2, 'Item 1 — getAdjustedRIR does not raise RIR on week 6 when no real deload evidence exists');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 2 — semana 6 + fatiga aislada (1 sola señal) -> no deload automático
// ─────────────────────────────────────────────────────────────────────────────

(function testItem2() {
  const LOGS = { 'ci_sem_6': { who5: '40' } }; // only WHO-5 low — a single isolated signal
  const eng = makeEngine(LOGS, 6);
  const res = eng._computeDeloadTriggers(6);
  ok(res.triggers.length === 1 && res.isDeload === false, 'Item 2 — a single isolated fatigue signal on week 6 does not trigger deload (needs >=2)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 3 — mala sesión aislada -> no deload automático (mirrors item 2 for a
// mid-cycle week via postsession-only data)
// ─────────────────────────────────────────────────────────────────────────────

(function testItem3() {
  const LOGS = { 'postsession_3_0': { rpeAverage: 9.5, sleepHours: 7 } }; // only RPE trigger
  const eng = makeEngine(LOGS, 6);
  const res = eng._computeDeloadTriggers(3);
  ok(res.triggers.length === 1 && res.isDeload === false, 'Item 3 — one bad isolated session (only RPE elevated) does not trigger deload');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 4/5 — repeated performance drop + fatigue combo -> deload candidate
// ─────────────────────────────────────────────────────────────────────────────

(function testItem4and5() {
  const LOGS = {
    'ci_sem_4': { who5: '45', hrv: '50', energia: '2' }, // WHO-5 + energia low -> 2 triggers already
    'ci_sem_3': { hrv: '65' }, // makes HRV drop also qualify (>15% drop)
    'postsession_4_0': { rpeAverage: 9.6, sleepHours: 5 } // rpe + sleep triggers too
  };
  const eng = makeEngine(LOGS, 6);
  const res = eng._computeDeloadTriggers(4);
  ok(res.triggers.length >= 2, 'Item 4/5 — multimodal fatigue+sleep+performance combo accumulates multiple real triggers');
  ok(res.isDeload === true, 'Item 4/5 — with multimodal evidence, deload IS recommended (DELOAD_RECOMMENDED-equivalent)');
  ok(eng.getAdjustedRIR(2, 4) === 4, 'Item 4/5 — getAdjustedRIR raises RIR (+2, easier) once real deload evidence exists, on a MID-cycle week (not just the last one)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 6 — dolor significativo: audited. calculateProgression() already
// treats EIMD=3 (dolor muscular alto) as a hard VETO (reduce_sets), gated
// BEFORE any load-increase branch can run — verified structurally.
// ─────────────────────────────────────────────────────────────────────────────

(function testItem6() {
  const calcProgFn = extractFunction(CLIENT, 'function calculateProgression(di, postData)');
  ok(calcProgFn.includes("if (eimd === 3) {") && calcProgFn.indexOf("if (eimd === 3) {") < calcProgFn.indexOf("action = 'increase_load'"),
    'Item 6 — significant pain (EIMD=3) is checked and vetoes volume BEFORE any load-increase branch can fire, regardless of week');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 7 — RIR real persistentemente menor al prescrito -> señal de fatiga
// (already implemented: TOO_HARD repeated across 2 weeks -> reduce_load)
// ─────────────────────────────────────────────────────────────────────────────

(function testItem7() {
  const calcProgFn = extractFunction(CLIENT, 'function calculateProgression(di, postData)');
  ok(calcProgFn.includes('_prevAlsoTooHard') && calcProgFn.includes("action = 'reduce_load'"),
    'Item 7 — persistently-lower-than-prescribed RIR across 2 consecutive weeks is already a recognized overload signal (reduce_load), verified present');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 8 — buen rendimiento pese a ser semana 6 -> progresión normal permitida
// ─────────────────────────────────────────────────────────────────────────────

(function testItem8() {
  const LOGS = {}; // no check-ins at all -> 0 triggers, neutral defaults
  const eng = makeEngine(LOGS, 6);
  ok(eng._computeDeloadTriggers(6).isDeload === false, 'Item 8 — no data at all on week 6 still resolves to NO_DELOAD (never invents a positive trigger)');
  ok(eng.getAdjustedRIR(2, 6) === 2, 'Item 8 — week 6 with no evidence uses the plan\'s normal base RIR, letting normal progression proceed');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 9 — salida de deload: learned_state preservado. Structural: history
// (LOGS log_* entries) and _getExposures/_getPrevWeekData are never cleared
// or reset by any deload-related code path; observationsCount (confidence)
// only ever counts real logged sets, deload weeks included.
// ─────────────────────────────────────────────────────────────────────────────

(function testItem9() {
  const calcProgFn = extractFunction(CLIENT, 'function calculateProgression(di, postData)');
  ok(!/isDeload[\s\S]{0,200}EXERCISE_HISTORY\s*=\s*\{\}/.test(calcProgFn) && !/isDeload[\s\S]{0,200}LOGS\s*=\s*\{\}/.test(calcProgFn),
    'Item 9 — calculateProgression never wipes EXERCISE_HISTORY or LOGS when isDeload fires (learned_state fully preserved across a deload)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 10 — existing progression recommendation + deload activo -> no
// autoaplicar incremento incompatible. The T161 next-exposure reader always
// picks the MOST RECENT progrec_ entry per PID; once a deload week persists
// a reduced newLoad/action:'deload', that becomes the latest entry and is
// what T161's _progAutoApply would read — never a stale pre-deload increase.
// ─────────────────────────────────────────────────────────────────────────────

(function testItem10() {
  const readerSrc = extractFunction(CLIENT, 'function _getProgRecForExercise(di, ei, exName, prescriptionExerciseId)');
  const normNameSrc = extractFunction(CLIENT, 'function _normName(s)');
  const LOGS = {
    'progrec_3_0': { recommendations: [{ prescriptionExerciseId: 'pid-x', exerciseName: 'X', action: 'increase_load', newLoad: 100 }] },
    'progrec_4_0': { recommendations: [{ prescriptionExerciseId: 'pid-x', exerciseName: 'X', action: 'deload', newLoad: 90 }] }
  };
  const idx = { progrec: { 3: ['progrec_3_0'], 4: ['progrec_4_0'] } };
  const factory = new Function('LOGS', 'LOGS_BY_WEEK', 'CURRENT_WEEK', normNameSrc + ';\n' + readerSrc + ';\nreturn _getProgRecForExercise;');
  const reader = factory(LOGS, idx, 5);
  const rec = reader(0, 0, 'X', 'pid-x');
  ok(rec.action === 'deload' && rec.newLoad === 90, 'Item 10 — the most recent recommendation (the deload one) always wins over an older pre-deload increase_load for the same PID; T161 auto-apply never resurrects a stale increase');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 11 — legacy plan (no PLAN.rirByWeek, arbitrary totalWeeks) -> no crash
// ─────────────────────────────────────────────────────────────────────────────

(function testItem11() {
  const eng = makeEngine({}, 8); // legacy 8-week mesocycle, no check-in data at all
  assert.doesNotThrow(function() {
    eng.getAdjustedRIR(2, 8, 'Press Banca');
    eng.getAdjustedRIR(undefined, 1);
    eng._computeDeloadTriggers(1);
  });
  pass++; console.log('  ✓ Item 11 — legacy/edge inputs (no check-ins, missing baseRIR, week 1) never throw');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 12 — datos insuficientes -> NO_DELOAD (not a forced deload), i.e. the
// gate defaults safe rather than assuming the worst from missing data.
// ─────────────────────────────────────────────────────────────────────────────

(function testItem12() {
  const eng = makeEngine({}, 6);
  const res = eng._computeDeloadTriggers(6);
  ok(res.isDeload === false, 'Item 12 — completely insufficient data resolves to NO_DELOAD, never a forced deload by default');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Regression — peak/intensification weeks (total-2, total-1) still lower RIR
// by 1 as before, and are explicitly NOT confused with the last week.
// ─────────────────────────────────────────────────────────────────────────────

(function testPeakWeeksUnchanged() {
  const eng = makeEngine({}, 6);
  ok(eng.getAdjustedRIR(2, 4) === 1, 'Regression — week 4 of 6 (total-2) still gets the peak/intensif -1 RIR adjustment');
  ok(eng.getAdjustedRIR(2, 5) === 1, 'Regression — week 5 of 6 (total-1) still gets the peak/intensif -1 RIR adjustment');
  ok(eng.getAdjustedRIR(2, 6) === 2, 'Regression — week 6 (the last week) is explicitly excluded from the peak/intensif branch, not silently harder either');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Regression — free-barbell RIR floor still applies regardless of deload/peak.
// ─────────────────────────────────────────────────────────────────────────────

(function testFreeBarbellFloorUnchanged() {
  const LOGS = { 'ci_sem_6': { who5: '30', energia: '2' } }; // 2 real triggers -> deload on week 6
  const eng = makeEngine(LOGS, 6);
  ok(eng.getAdjustedRIR(0, 6, 'Sentadilla libre') >= 1, 'Regression — free-barbell RIR floor (>=1) still applies even during a genuine reactive deload');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Structural regressions: getSemProgresion and the week-grid label no longer
// assert 'DELOAD' purely by calendar position.
// ─────────────────────────────────────────────────────────────────────────────

(function testGetSemProgresionAndGridLabel() {
  ok(CLIENT.includes("if (week >= total) return _computeDeloadTriggers(week).isDeload ? 'DELOAD' : 'SEMANA FINAL';"),
    'getSemProgresion: the last-week label is now reactive-gated (DELOAD only with real evidence, else SEMANA FINAL)');
  ok(!CLIENT.includes("var deload  = w === _tw;") && CLIENT.includes("getSemProgresion(w)+'</span>'+"),
    'Week-selector grid: the redundant calendar-only DELOAD shortcut was removed; the label always defers to getSemProgresion(w)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// T159/T161 regressions — must still hold under this pass's edits.
// ─────────────────────────────────────────────────────────────────────────────

(function testT159T161Regressions() {
  ok(!CLIENT.includes('Semana 6 = deload automático'), 'T159 regression: no automatic week-6 deload claim in the Generator prompt/CLAUDE.md');
  ok(CLIENT.includes('prescriptionExerciseId: ej.prescriptionExerciseId || undefined,'), 'T159/T161 regression: prescriptionExerciseId still persisted on each recommendation');
  ok(CLIENT.includes('var _progAutoApply = (progrec && ej.prescriptionExerciseId && progrec.prescriptionExerciseId === ej.prescriptionExerciseId) ? progrec : null;'),
    'T161 regression: PID-verified auto-apply gate unchanged');
})();

console.log('');
console.log('T162 — Reactive deload integration: ' + pass + ' assertions PASSED');
