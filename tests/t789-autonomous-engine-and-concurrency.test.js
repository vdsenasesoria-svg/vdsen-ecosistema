'use strict';
// T789 — Autonomous Progression Engine (Priority 5) & Concurrency / Firestore / Logbook Integrity (Priority 6).
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../assets/progression-magnitude-policy.js');
const structural = require('../assets/progression-structural-policy.js');
const shadow = require('../assets/progression-auto-apply-shadow.js');
const effective = require('../assets/progression-effective-prescription.js');
const consumer = require('../assets/progression-application-consumer.js');
const { executeStop, executeClientRevocation, auditMesoConsistency } = require('../scripts/pilot/numeric-stop-recovery.cjs');
const F = require('./helpers/lifecycle-fixture.js');

const T0 = Date.parse('2026-09-27T12:00:00.000Z');

function makePlan({
  clientId = 'client-t789',
  pid = 'pid-press-t789',
  exerciseId = 'legacy-remo-mancuerna-unilateral',
  muscleGroup = 'pectoral',
  fatigueCost = 3,
  repsRange = { min: 8, max: 12 },
  repsTarget = 10,
  rirTarget = 1,
  restSeconds = 90,
  setsCount = 3,
  musclePriorities = null,
  rirByWeek = null,
  updatedAt = '2026-09-26T00:00:00.000Z',
  extraExercises = [],
} = {}) {
  const sets = Array.from({ length: setsCount }, (_, i) => ({
    setIndex: i,
    repsTarget,
    rirTarget,
    restSeconds,
  }));
  const ex = {
    prescriptionExerciseId: pid,
    exerciseId,
    exerciseName: 'Press Banca T789',
    muscleGroup,
    primaryMuscles: muscleGroup ? [muscleGroup] : undefined,
    fatigueCost,
    repsRange,
    sets,
  };
  return {
    clientId,
    weeks: 4,
    updatedAt,
    ...(musclePriorities ? { musclePriorities } : {}),
    ...(rirByWeek ? { rirByWeek } : {}),
    days: [0, 2].map((dayIndex) => ({
      dayIndex,
      exercises: [ex, ...extraExercises],
    })),
  };
}

function makeEntries(pid, exposuresSpec, extraEntries = {}) {
  const entries = { ...extraEntries };
  for (const exp of exposuresSpec) {
    const { week, dayIndex, exerciseIndex = 0, sets } = exp;
    sets.forEach((s, idx) => {
      const setIdx = s.setIndex !== undefined ? s.setIndex : idx;
      const key = s.rawKey || `log_${week}_${dayIndex}_${exerciseIndex}_s${setIdx}`;
      entries[key] = {
        done: s.done !== undefined ? s.done : true,
        carga: String(s.load !== undefined ? s.load : '100'),
        reps: String(s.reps !== undefined ? s.reps : '10'),
        unit: s.unit || 'KG',
        rir: s.rir !== undefined ? s.rir : 1,
        rir_real: s.rir_real !== undefined ? s.rir_real : 1,
        ...(s.ics !== undefined ? { ics: s.ics } : {}),
        prescriptionExerciseId: s.prescriptionExerciseId !== undefined ? s.prescriptionExerciseId : pid,
        ts: s.ts !== undefined ? s.ts : T0 + week * 100000 + dayIndex * 1000 + setIdx,
        ...(s.sts !== undefined ? { sts: s.sts } : {}),
        ...(s.autoFilled ? { autoFilled: true } : {}),
        ...(s.express ? { express: true } : {}),
        ...(s.warmup ? { warmup: true } : {}),
      };
    });
  }
  return entries;
}

// ============================================================================
// PRIORITY 5 — AUTONOMOUS PROGRESSION ENGINE & SPORTS RULES
// ============================================================================

test('T789-P5.1: LOAD, REPS, REST, Double Progression (DP), and VOLUME (SETS S-ADD / S-EIMD3) rules', () => {
  const pid = 'pid-p5-1';
  // 1A. REPS (+2 reps when rirTarget=1, rir_real=3 across 2 comparable exposures inside 8..12 range)
  const planReps = makePlan({ pid, rirTarget: 1, repsTarget: 10, repsRange: { min: 8, max: 12 } });
  const entriesReps = makeEntries(pid, [
    { week: 1, dayIndex: 0, sets: [{ reps: 10, rir: 1, rir_real: 3 }, { reps: 10, rir: 1, rir_real: 3 }, { reps: 10, rir: 1, rir_real: 3 }] },
    { week: 1, dayIndex: 2, sets: [{ reps: 10, rir: 1, rir_real: 3 }, { reps: 10, rir: 1, rir_real: 3 }, { reps: 10, rir: 1, rir_real: 3 }] },
  ]);
  const evalReps = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan: planReps,
    prescription: planReps.days[0].exercises[0],
    exposures: policy.extractExposures(entriesReps, pid, { clientId: 'client-t789', planId: 'plan-1' }),
  });
  assert.equal(evalReps.eligible, true);
  assert.equal(evalReps.ruleId, 'A');
  assert.equal(evalReps.dimension, 'REPS');
  assert.equal(evalReps.candidates[0].finalCandidate, 12);

  // 1B. Double Progression (DP) at ceiling (reps=12 === repsRange.max, rir_real=1 === rirTarget) -> LOAD +2.5%
  const planDp = makePlan({ pid, rirTarget: 1, repsTarget: 12, repsRange: { min: 8, max: 12 } });
  const entriesDp = makeEntries(pid, [
    { week: 1, dayIndex: 0, sets: [{ load: 100, reps: 12, rir: 1, rir_real: 1 }, { load: 100, reps: 12, rir: 1, rir_real: 1 }] },
    { week: 1, dayIndex: 2, sets: [{ load: 100, reps: 12, rir: 1, rir_real: 1 }, { load: 100, reps: 12, rir: 1, rir_real: 1 }] },
  ]);
  const evalDp = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan: planDp,
    prescription: planDp.days[0].exercises[0],
    exposures: policy.extractExposures(entriesDp, pid, { clientId: 'client-t789', planId: 'plan-1' }),
  });
  assert.equal(evalDp.eligible, true);
  assert.equal(evalDp.ruleId, 'DP');
  assert.equal(evalDp.dimension, 'LOAD');
  assert.equal(evalDp.candidates[0].rawCandidate, 102.5);
  assert.equal(evalDp.doubleProgression.trigger, 'RIR_AS_PRESCRIBED_AT_CEILING');

  // 1C. REST (Rule C on first incomplete-reps occurrence at target RIR; C+E COACH_REVIEW_REQUIRED if it persists)
  const entriesRest1 = makeEntries(pid, [
    { week: 1, dayIndex: 0, sets: [{ reps: 10, rir: 1, rir_real: 1 }] },
    { week: 1, dayIndex: 2, sets: [{ reps: 9, rir: 1, rir_real: 1 }] },
  ]);
  const evalRest1 = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan: planReps,
    prescription: planReps.days[0].exercises[0],
    exposures: policy.extractExposures(entriesRest1, pid, { clientId: 'client-t789', planId: 'plan-1' }),
  });
  assert.equal(evalRest1.eligible, true);
  assert.equal(evalRest1.ruleId, 'C');
  assert.equal(evalRest1.dimension, 'REST');
  assert.equal(evalRest1.candidates[0].finalCandidate, 120);

  const entriesRestPersist = makeEntries(pid, [
    { week: 1, dayIndex: 0, sets: [{ reps: 9, rir: 1, rir_real: 1 }] },
    { week: 1, dayIndex: 2, sets: [{ reps: 9, rir: 1, rir_real: 1 }] },
  ]);
  const evalRestPersist = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan: planReps,
    prescription: planReps.days[0].exercises[0],
    exposures: policy.extractExposures(entriesRestPersist, pid, { clientId: 'client-t789', planId: 'plan-1' }),
  });
  assert.equal(evalRestPersist.eligible, false);
  assert.equal(evalRestPersist.ruleId, 'C+E');
  assert.equal(evalRestPersist.coachReviewRequired.code, 'COACH_REVIEW_REQUIRED');

  // 1D. VOLUME (SETS S-ADD with sustained performance & avgICS >= 8 vs S-EIMD3 soreness veto)
  const entriesVolAdd = makeEntries(pid, [
    { week: 1, dayIndex: 0, sets: [{ load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }, { load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }, { load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }] },
    { week: 1, dayIndex: 2, sets: [{ load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }, { load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }, { load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }] },
  ]);
  const evalVolAdd = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan: planReps,
    prescription: planReps.days[0].exercises[0],
    exposures: policy.extractExposures(entriesVolAdd, pid, { clientId: 'client-t789', planId: 'plan-1' }),
    context: { structural: { entries: entriesVolAdd, targetWeek: 2, carriedSets: {} } },
  });
  assert.equal(evalVolAdd.eligible, true);
  assert.equal(evalVolAdd.ruleId, 'S-ADD');
  assert.equal(evalVolAdd.dimension, 'SETS');
  assert.equal(evalVolAdd.candidates[0].finalCandidate, 4);

  const entriesEimd3 = { ...entriesVolAdd, postsession_1_2: { eimd: 3, sleepHours: 8, rpeAverage: 7 } };
  const evalEimd3 = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan: planReps,
    prescription: planReps.days[0].exercises[0],
    exposures: policy.extractExposures(entriesEimd3, pid, { clientId: 'client-t789', planId: 'plan-1' }),
    context: { structural: { entries: entriesEimd3, targetWeek: 2, carriedSets: {} } },
  });
  assert.equal(evalEimd3.eligible, true);
  assert.equal(evalEimd3.ruleId, 'S-EIMD3');
  assert.equal(evalEimd3.dimension, 'SETS');
  assert.equal(evalEimd3.candidates[0].finalCandidate, 2);
});

test('T789-P5.2: RIR & ICS technique gates (S-ICS-LT6 x0.85, S-ICS-LT7 x0.90, S-HARD-TWICE x0.95)', () => {
  const pid = 'pid-p5-2';
  const plan = makePlan({ pid, rirTarget: 2, repsTarget: 10 });

  // ICS < 6 -> x0.85
  const entriesIcs5 = makeEntries(pid, [
    { week: 1, dayIndex: 0, sets: [{ load: 100, reps: 10, rir: 2, rir_real: 2, ics: 5.5 }, { load: 100, reps: 10, rir: 2, rir_real: 2, ics: 5.5 }] },
  ]);
  const resIcs5 = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan,
    prescription: plan.days[0].exercises[0],
    exposures: policy.extractExposures(entriesIcs5, pid, { clientId: 'client-t789', planId: 'plan-1' }),
    context: { structural: { entries: entriesIcs5, targetWeek: 1, carriedSets: {} } },
  });
  assert.equal(resIcs5.eligible, true);
  assert.equal(resIcs5.ruleId, 'S-ICS-LT6');
  assert.equal(resIcs5.dimension, 'LOAD');
  assert.equal(resIcs5.candidates[0].rawCandidate, 85);

  // 6 <= ICS < 7 -> x0.90
  const entriesIcs65 = makeEntries(pid, [
    { week: 1, dayIndex: 0, sets: [{ load: 100, reps: 10, rir: 2, rir_real: 2, ics: 6.5 }, { load: 100, reps: 10, rir: 2, rir_real: 2, ics: 6.5 }] },
  ]);
  const resIcs65 = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan,
    prescription: plan.days[0].exercises[0],
    exposures: policy.extractExposures(entriesIcs65, pid, { clientId: 'client-t789', planId: 'plan-1' }),
    context: { structural: { entries: entriesIcs65, targetWeek: 1, carriedSets: {} } },
  });
  assert.equal(resIcs65.eligible, true);
  assert.equal(resIcs65.ruleId, 'S-ICS-LT7');
  assert.equal(resIcs65.candidates[0].rawCandidate, 90);

  // Harder than prescribed (rirTarget=3, rir_real=1 -> err = -2 < -1) twice in a row -> S-HARD-TWICE (x0.95)
  const planHard = makePlan({ pid, rirTarget: 3, repsTarget: 10 });
  const entriesHardTwice = makeEntries(pid, [
    { week: 1, dayIndex: 0, sets: [{ load: 100, reps: 10, rir: 3, rir_real: 1, ics: 8 }, { load: 100, reps: 10, rir: 3, rir_real: 1, ics: 8 }] },
    { week: 1, dayIndex: 2, sets: [{ load: 100, reps: 10, rir: 3, rir_real: 1, ics: 8 }, { load: 100, reps: 10, rir: 3, rir_real: 1, ics: 8 }] },
  ]);
  const resHardTwice = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan: planHard,
    prescription: planHard.days[0].exercises[0],
    exposures: policy.extractExposures(entriesHardTwice, pid, { clientId: 'client-t789', planId: 'plan-1' }),
    context: { structural: { entries: entriesHardTwice, targetWeek: 2, carriedSets: {} } },
  });
  assert.equal(resHardTwice.eligible, true);
  assert.equal(resHardTwice.ruleId, 'S-HARD-TWICE');
  assert.equal(resHardTwice.dimension, 'LOAD');
  assert.equal(resHardTwice.candidates[0].rawCandidate, 95);
});

test('T789-P5.3 & P6.9: Muscle priorities (PRIORITARIO vs NO_PRIORITARIO) and microcycle priority switch with carried volume', () => {
  const pidMain = 'pid-pec-main';
  const pidAux = 'pid-pec-aux';
  const auxEx = {
    prescriptionExerciseId: pidAux,
    exerciseId: 'aux-pec',
    exerciseName: 'Aperturas',
    muscleGroup: 'pectoral',
    primaryMuscles: ['pectoral'],
    sets: Array.from({ length: 5 }, (_, i) => ({ setIndex: i, repsTarget: 12, rirTarget: 2, restSeconds: 60 })),
  };
  // 2 days * (3 sets main + 5 sets aux) = 16 weekly sets for pectoral.
  // pectoral MEV=10, MRV=22 -> NO_PRIORITARIO ceiling = floor((10+22)/2) = 16; PRIORITARIO ceiling = 22.
  const planNoPrio = makePlan({
    pid: pidMain,
    muscleGroup: 'pectoral',
    setsCount: 3,
    musclePriorities: { PRIORITARIO: ['dorsal_ancho'], NO_PRIORITARIO: ['pectoral'] },
    extraExercises: [auxEx],
  });
  const entries = makeEntries(pidMain, [
    { week: 1, dayIndex: 0, sets: [{ load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }, { load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }, { load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }] },
    { week: 1, dayIndex: 2, sets: [{ load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }, { load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }, { load: 100, reps: 10, rir: 1, rir_real: 1, ics: 8.5 }] },
  ]);

  assert.equal(structural.weeklyVolume(planNoPrio, entries, 1, 'pectoral', {}), 16);
  assert.equal(structural.volumeCeiling('pectoral', 'NO_PRIORITARIO'), 16);
  assert.equal(structural.volumeCeiling('pectoral', 'PRIORITARIO'), 22);

  // Under NO_PRIORITARIO: 16 + 1 > 16 -> S-ADD is blocked by volume ceiling; falls through to MAINTAIN (fixed-rep or below ceiling)
  const evalNoPrio = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pidMain,
    plan: planNoPrio,
    prescription: planNoPrio.days[0].exercises[0],
    exposures: policy.extractExposures(entries, pidMain, { clientId: 'client-t789', planId: 'plan-1' }),
    context: { structural: { entries, targetWeek: 2, carriedSets: {} } },
  });
  assert.notEqual(evalNoPrio.ruleId, 'S-ADD');
  assert.equal(evalNoPrio.ruleId, 'MAINTAIN');

  // Microcycle priority switch to PRIORITARIO: ceiling becomes 22 -> 16 + 1 <= 22 -> S-ADD is now eligible!
  const planPrio = {
    ...planNoPrio,
    musclePriorities: { PRIORITARIO: ['pectoral'], NO_PRIORITARIO: ['dorsal_ancho'] },
  };
  const evalPrio = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pidMain,
    plan: planPrio,
    prescription: planPrio.days[0].exercises[0],
    exposures: policy.extractExposures(entries, pidMain, { clientId: 'client-t789', planId: 'plan-1' }),
    context: { structural: { entries, targetWeek: 2, carriedSets: {} } },
  });
  assert.equal(evalPrio.eligible, true);
  assert.equal(evalPrio.ruleId, 'S-ADD');
  assert.equal(evalPrio.dimension, 'SETS');
  assert.equal(evalPrio.candidates[0].finalCandidate, 4);

  // If carriedSets from prior microcycle already elevated auxEx to 8 sets/day (2 * (3 + 8) = 22 sets), even PRIORITARIO ceiling (22) blocks S-ADD (22 + 1 > 22)
  const evalPrioAtMrv = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pidMain,
    plan: planPrio,
    prescription: planPrio.days[0].exercises[0],
    exposures: policy.extractExposures(entries, pidMain, { clientId: 'client-t789', planId: 'plan-1' }),
    context: { structural: { entries, targetWeek: 2, carriedSets: { [pidAux]: 8 } } },
  });
  assert.notEqual(evalPrioAtMrv.ruleId, 'S-ADD');
});

test('T789-P5.4, P5.5, P5.6, P5.7 & P6.10: FREEZE, Reactive DELOAD, Simultaneous DELOAD+FREEZE precedence, and CARRIED_OVERLAY continuity', () => {
  const pid = 'pid-p5-freeze-deload';
  const plan = makePlan({ pid, rirTarget: 2, repsTarget: 10, rirByWeek: { 2: 3 } });

  // 1. FREEZE (S-FREEZE-ZERO: one set hit RIR 0 while rirTarget=2)
  const entriesFreeze = makeEntries(pid, [
    { week: 1, dayIndex: 0, sets: [{ load: 100, reps: 10, rir: 2, rir_real: 2, ics: 8 }, { load: 100, reps: 10, rir: 2, rir_real: 0, ics: 8 }] },
  ]);
  const evalFreeze = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan,
    prescription: plan.days[0].exercises[0],
    exposures: policy.extractExposures(entriesFreeze, pid, { clientId: 'client-t789', planId: 'plan-1' }),
    context: { structural: { entries: entriesFreeze, targetWeek: 1, carriedSets: {} } },
  });
  assert.equal(evalFreeze.eligible, true);
  assert.equal(evalFreeze.ruleId, 'S-FREEZE-ZERO');
  assert.equal(evalFreeze.dimension, 'FREEZE');
  assert.equal(evalFreeze.candidates[0].finalCandidate, 100);

  // 2. Simultaneous Reactive DELOAD (>= 2 fatigue triggers: WHO5=40 < 52 and sleepHours=5 < 6) + FREEZE condition (rir_real=0)
  // Priority 6.10: S-DELOAD strictly outranks S-FREEZE-ZERO
  const entriesDeloadAndFreeze = {
    ...entriesFreeze,
    ci_sem_1: { who5: 40, energia: 3 },
    postsession_1_0: { sleepHours: 5, rpeAverage: 9.5, eimd: 2 },
  };
  const evalDeload = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan,
    prescription: plan.days[0].exercises[0],
    exposures: policy.extractExposures(entriesDeloadAndFreeze, pid, { clientId: 'client-t789', planId: 'plan-1' }),
    context: { structural: { entries: entriesDeloadAndFreeze, targetWeek: 2, carriedSets: {} } },
  });
  assert.equal(evalDeload.eligible, true);
  assert.equal(evalDeload.ruleId, 'S-DELOAD');
  assert.equal(evalDeload.dimension, 'DELOAD');
  assert.deepEqual(evalDeload.candidates[0].components, { SETS: 1, LOAD: 90, RIR: 3 });

  // 3. Auto-closed post-session defaults never trigger false DELOAD
  const entriesAutoClosed = {
    ...entriesFreeze,
    postsession_1_0: { sleepHours: 4, rpeAverage: 10, autoClosed: true },
  };
  const evalAutoClosed = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: pid,
    plan,
    prescription: plan.days[0].exercises[0],
    exposures: policy.extractExposures(entriesAutoClosed, pid, { clientId: 'client-t789', planId: 'plan-1' }),
    context: { structural: { entries: entriesAutoClosed, targetWeek: 2, carriedSets: {} } },
  });
  assert.equal(evalAutoClosed.ruleId, 'S-FREEZE-ZERO', 'autoClosed postsession ignored for fatigue deload');

  // 4. CARRIED_OVERLAY: CONSUMED LOAD overlay carries to subsequent exposure (W2 D2), whereas CONSUMED DELOAD or FREEZE never carries
  const scLoad = F.scenario({ pid: 'pid-carry', clientId: 'client-t789', planId: 'plan-carry' });
  const appLoad = F.applied(scLoad, { state: 'CONSUMED' });
  // Target exposure of appLoad is W2 D0; check W2 D2 (next exposure after target)
  const effCarried = effective.resolveEffective({
    clientId: 'client-t789',
    planId: 'plan-carry',
    activePlanId: 'plan-carry',
    pid: 'pid-carry',
    week: 2,
    dayIndex: 2,
    records: appLoad.records,
    overlays: appLoad.overlays,
    interventions: [],
    plan: appLoad.plan,
    entries: appLoad.entries,
    baseSets: F.baseSets(),
    canonicalOverlayRead: true,
  });
  assert.equal(effCarried.provenance, 'CARRIED_OVERLAY');
  assert.equal(effCarried.sets[0].effective.load, appLoad.overlay.appliedValue);
});

test('T789-P5.8 & Invariants: Cardio by time/RPE exclusion, set-order invariance, clientId/planId isolation, and JSON schema stability', () => {
  const cardioPid = 'pid-cardio-bike';
  const strengthPid = 'pid-strength-row';
  const plan = makePlan({
    pid: strengthPid,
    extraExercises: [{
      prescriptionExerciseId: cardioPid,
      exerciseId: 'cardio-bike',
      exerciseName: 'Bici Estática',
      exerciseType: 'cardio',
      muscleGroup: 'cuadriceps',
      primaryMuscles: ['cuadriceps'],
      sets: [{ setIndex: 0, durationMinutes: 30, rpeTarget: 6 }],
    }],
  });

  // Cardio entry with progrec recommendation is ignored by materializeRecords and excluded from weeklyVolume
  const entries = makeEntries(strengthPid, [
    { week: 1, dayIndex: 0, sets: [{ load: 80, reps: 10, rir: 2, rir_real: 3 }, { load: 80, reps: 10, rir: 2, rir_real: 3 }] },
    { week: 1, dayIndex: 2, sets: [{ load: 80, reps: 10, rir: 2, rir_real: 3 }, { load: 80, reps: 10, rir: 2, rir_real: 3 }] },
  ], {
    log_1_0_1_s0: { done: true, duration: 30, rpe_real: 6, prescriptionExerciseId: cardioPid, ts: T0 + 500 },
    progrec_1_2: {
      calculatedAt: '2026-09-27T12:00:00.000Z',
      recommendations: [
        { prescriptionExerciseId: cardioPid, exerciseId: 'cardio-bike', exerciseName: 'Bici', action: 'increase_reps', newReps: 35 },
        { prescriptionExerciseId: strengthPid, exerciseId: 'legacy-remo-mancuerna-unilateral', exerciseName: 'Remo', action: 'increase_load', newLoad: 82.5, newReps: 10 },
      ],
    },
  });

  const mat = shadow.materializeRecords({
    clientId: 'client-t789',
    planId: 'plan-1',
    activePlanId: 'plan-1',
    plan,
    interventions: [],
    entries,
    records: {},
    overlays: {},
    structural: true,
    at: '2026-09-27T13:00:00.000Z',
  });
  assert.equal(mat.created.length, 1);
  const createdRec = mat.records[mat.created[0]];
  assert.equal(createdRec.prescriptionExerciseId, strengthPid, 'cardio recommendation never materializes');
  assert.equal(structural.weeklyVolume(plan, entries, 1, 'cuadriceps', {}), 0, 'cardio sets never count toward muscle hypertrophy volume');

  // Set arrival order invariance: reversed key insertion order yields identical representative set and evaluation
  const forwardEntries = {
    log_1_0_0_s0: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: strengthPid, ts: T0 + 1 },
    log_1_0_0_s1: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 3, prescriptionExerciseId: strengthPid, ts: T0 + 2 },
    log_1_2_0_s0: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: strengthPid, ts: T0 + 10 },
    log_1_2_0_s1: { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 3, prescriptionExerciseId: strengthPid, ts: T0 + 11 },
  };
  const reversedEntries = {
    log_1_2_0_s1: forwardEntries.log_1_2_0_s1,
    log_1_2_0_s0: forwardEntries.log_1_2_0_s0,
    log_1_0_0_s1: forwardEntries.log_1_0_0_s1,
    log_1_0_0_s0: forwardEntries.log_1_0_0_s0,
  };
  const evFwd = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: strengthPid,
    plan,
    prescription: plan.days[0].exercises[0],
    exposures: policy.extractExposures(forwardEntries, strengthPid, { clientId: 'client-t789', planId: 'plan-1' }),
  });
  const evRev = policy.evaluate({
    clientId: 'client-t789',
    planId: 'plan-1',
    prescriptionExerciseId: strengthPid,
    plan,
    prescription: plan.days[0].exercises[0],
    exposures: policy.extractExposures(reversedEntries, strengthPid, { clientId: 'client-t789', planId: 'plan-1' }),
  });
  assert.deepEqual(evFwd, evRev, 'set key order must never alter magnitude evaluation');
  assert.equal(evFwd.schema, 'vdsen-magnitude-shadow-v1');
});

// ============================================================================
// PRIORITY 6 — FIRESTORE INTEGRITY, CONCURRENCY & LOGBOOK SCENARIOS (1..10)
// ============================================================================

test('T789-P6.1 & P6.2: Race between STOP and in-flight application + Double application attempt on same recommendation', async () => {
  const sc = F.scenario({ pid: 'pid-p6-1', clientId: 'client-p6', planId: 'plan-p6' });
  const d = F.decide(sc);
  assert.equal(d.wouldApply, true);

  // P6.2: Double application attempt on the same recommendation
  const firstApply = F.on.shadow.lifecycleTransition(sc.rec, 'APPLIED', {
    expectedRevision: 1,
    operationKey: 'op-apply-1',
    at: '2026-09-28T01:00:00.000Z',
    actorId: 'trusted-progressor',
    reasonCode: 'APPLIED_BY_POLICY',
    patch: { overlayKey: d.overlay.key, appliedAt: '2026-09-28T01:00:00.000Z' },
  });
  assert.equal(firstApply.ok, true);
  assert.equal(firstApply.idempotent, false);
  assert.equal(firstApply.record.state, 'APPLIED');
  assert.equal(firstApply.record.revision, 2);

  // Same operationKey retry is idempotent
  const retrySameOp = F.on.shadow.lifecycleTransition(firstApply.record, 'APPLIED', {
    expectedRevision: 1,
    operationKey: 'op-apply-1',
    at: '2026-09-28T01:00:05.000Z',
    actorId: 'trusted-progressor',
  });
  assert.equal(retrySameOp.ok, true);
  assert.equal(retrySameOp.idempotent, true);
  assert.equal(retrySameOp.record.revision, 2);

  // Second distinct operationKey attempting to apply an already-APPLIED record is rejected (REVISION_CONFLICT or INVALID_TRANSITION)
  const secondApplyDiffOp = F.on.shadow.lifecycleTransition(firstApply.record, 'APPLIED', {
    expectedRevision: 2,
    operationKey: 'op-apply-2',
    at: '2026-09-28T01:00:10.000Z',
    actorId: 'trusted-progressor',
  });
  assert.equal(secondApplyDiffOp.ok, false);
  assert.equal(secondApplyDiffOp.reasonCode, 'INVALID_TRANSITION');

  // P6.1: Race between STOP and in-flight application (STOP disarms fences and transitions ledger; if ledger already COMPLETED, STOP reports conflict without corrupting state)
  const store = {
    'releaseControl/numericPilot': { enabled: true },
    'releaseControl/autonomousProgression': { enabled: true, clientIds: ['client-p6'] },
    'coaches/coach-p6': { name: 'Coach P6', autoApplyCanary: { enabled: true, clientIds: ['client-p6'], prescriptionExerciseIds: ['pid-p6-1'] } },
  };
  const ioRaceCompleted = {
    writeFence: async (path, fields) => {
      if (path === 'coaches/coach-p6') store[path].autoApplyCanary.enabled = false;
      else store[path] = { ...store[path], ...fields };
      return true;
    },
    readFence: async (path) => store[path],
    recordStop: async () => ({
      success: false,
      error: 'TERMINAL_STATE_CONFLICT',
      message: 'Operation already COMPLETED before STOP commit',
    }),
  };
  const stopRep = await executeStop({ coachId: 'coach-p6', operationId: 'op-race-1', reason: 'CONCURRENT_STOP_TEST' }, ioRaceCompleted);
  assert.equal(stopRep.primaryFenceDisarmed, true);
  assert.equal(stopRep.fencesDisarmed, true);
  assert.equal(stopRep.ledgerStopped, false);
  assert.equal(stopRep.status, 'STOP_INCOMPLETE');
  assert.equal(store['coaches/coach-p6'].autoApplyCanary.enabled, false);
  assert.deepEqual(store['coaches/coach-p6'].autoApplyCanary.clientIds, ['client-p6'], 'coach clientIds preserved');
});

test('T789-P6.3, P6.4, P6.5, P6.6, P6.7 & P6.8: Active plan change, parallel client sessions, offline deferred writes, mid-operation restart, CONSUMED terminal firewall, and desynchronized logbook authority', () => {
  const sc = F.scenario({ pid: 'pid-p6-multi', clientId: 'client-p6', planId: 'plan-active-1' });
  const app = F.applied(sc, { state: 'APPLIED' });

  // P6.3: Active plan change during window -> resolveEffective returns BASE_PLAN (PLAN_MISMATCH) and materializeRecords marks record STALE
  const effPlanChanged = effective.resolveEffective(F.effectiveInput(app, { activePlanId: 'plan-active-2', canonicalOverlayRead: true }));
  assert.equal(effPlanChanged.provenance, 'BASE_PLAN');
  assert.equal(effPlanChanged.reason, 'PLAN_MISMATCH');

  const matPlanChanged = shadow.materializeRecords({
    clientId: sc.clientId,
    planId: sc.planId,
    activePlanId: 'plan-active-2',
    plan: sc.plan,
    interventions: [],
    entries: sc.entries,
    records: app.records,
    overlays: app.overlays,
    at: '2026-09-28T03:00:00.000Z',
  });
  assert.equal(matPlanChanged.changed, false, 'mismatched activePlanId refuses to materialize');

  // P6.4: Two parallel sessions of the same client writing sets & receipts -> identical idempotencyKey and no duplicate records
  const entriesWithProgrec = {
    ...sc.entries,
    progrec_1_2: {
      calculatedAt: '2026-09-27T12:00:00.000Z',
      recommendations: [{ prescriptionExerciseId: sc.pid, exerciseId: sc.exerciseId, exerciseName: 'X', action: 'increase_load', newLoad: 5, newReps: 10 }],
    },
  };
  const matParallelA = shadow.materializeRecords({
    clientId: sc.clientId,
    planId: sc.planId,
    activePlanId: sc.planId,
    plan: sc.plan,
    interventions: [],
    entries: entriesWithProgrec,
    records: {},
    overlays: {},
    at: '2026-09-28T03:00:00.000Z',
  });
  const matParallelB = shadow.materializeRecords({
    clientId: sc.clientId,
    planId: sc.planId,
    activePlanId: sc.planId,
    plan: sc.plan,
    interventions: [],
    entries: entriesWithProgrec,
    records: matParallelA.records,
    overlays: {},
    at: '2026-09-28T03:00:01.000Z',
  });
  assert.equal(matParallelA.created.length, 1);
  assert.equal(matParallelB.created.length, 0);
  assert.equal(matParallelB.changed, false);

  // P6.5: Offline deferred writes with skewed device clock vs server-stamped start marker & plan revision
  const revisedPlan = { ...app.plan, updatedAt: '2026-09-28T05:00:00.000Z' };
  const offlineEntries = {
    ...app.entries,
    log_2_0_0_s0: {
      done: true,
      carga: String(app.overlay.appliedValue),
      reps: '10',
      unit: 'KG',
      rir: 2,
      rir_real: 2,
      prescriptionExerciseId: sc.pid,
      ts: Date.parse('2026-09-28T01:30:00.000Z'), // device clock claims before plan revision
      sts: { toMillis: () => Date.parse('2026-09-28T06:00:00.000Z') }, // synced to server AFTER plan revision
    },
  };
  const effOfflineAfterRevision = effective.resolveEffective(F.effectiveInput(app, {
    plan: revisedPlan,
    entries: offlineEntries,
    trustedStarts: true,
    startMarkers: [{ at: { toMillis: () => Date.parse('2026-09-28T06:00:00.000Z') } }],
    canonicalOverlayRead: true,
  }));
  assert.equal(effOfflineAfterRevision.provenance, 'BASE_PLAN');
  assert.equal(effOfflineAfterRevision.reason, 'TARGET_INVALIDATED');

  // P6.6 & P6.7: Process restart mid-operation (APPLIED -> CONSUMED) and terminal CONSUMED firewall
  const consumed = F.applied(sc, { state: 'CONSUMED' });
  assert.equal(consumed.record.state, 'CONSUMED');
  assert.deepEqual(shadow.ALLOWED_TRANSITIONS.CONSUMED, []);
  for (const targetState of ['PENDING', 'APPLIED', 'REJECTED', 'OVERRIDDEN', 'REVERTED', 'STALE', 'CONSUMED']) {
    const res = shadow.lifecycleTransition(consumed.record, targetState, {
      expectedRevision: consumed.record.revision,
      operationKey: 'post-consumed-' + targetState,
      at: '2026-09-28T07:00:00.000Z',
      trustedServer: true,
    });
    assert.equal(res.ok, false, `CONSUMED must reject transition to ${targetState}`);
  }
  const numPid = require('../api/_numericPilotContract').PID;
  const audit = auditMesoConsistency({
    progressionApplications: { [consumed.record.key]: { ...consumed.record, prescriptionExerciseId: numPid } },
    nextExposureOverlays: { [consumed.overlay.key]: { ...consumed.overlay, prescriptionExerciseId: numPid } },
    consumptionReceipts: { [consumed.record.key]: { recordKey: consumed.record.key, ackAt: '2026-09-28T02:00:00.000Z' } },
  });
  assert.equal(audit.isConsistent, true);
  assert.equal(audit.classified.legitimateConsumed.length, 1);

  // P6.8: Desynchronized logbook authority (legacy unbound root log, foreign planId, superset dominance)
  const unboundRoot = { entries: { log_1_0_0_s0: { done: true } } }; // missing planId
  const validMeso = { planId: 'plan-active-1', updatedAt: 100, entries: { log_1_0_0_s0: { done: true } } };
  assert.equal(shadow.isLegacyUnboundLog(unboundRoot), true);
  assert.equal(shadow.selectLogAuthority(validMeso, unboundRoot, 'plan-active-1'), validMeso);

  const foreignRoot = { planId: 'plan-old', updatedAt: 999999, entries: { log_1_0_0_s0: { done: true }, log_1_2_0_s0: { done: true } } };
  assert.equal(shadow.selectLogAuthority(validMeso, foreignRoot, 'plan-active-1'), validMeso);

  const richerRoot = { planId: 'plan-active-1', updatedAt: 50, entries: { log_1_0_0_s0: { done: true }, log_1_2_0_s0: { done: true } } };
  assert.equal(shadow.selectLogAuthority(validMeso, richerRoot, 'plan-active-1'), richerRoot, 'superset of execution evidence dominates even with older clock');
});
