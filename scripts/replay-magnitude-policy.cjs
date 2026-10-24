#!/usr/bin/env node
// Phase 2A analytical replay (read-only, synthetic): runs the shadow magnitude policy over a
// deterministic grid of executed-evidence scenarios and prints outcome counts. No Firebase,
// no writes. Usage: node scripts/replay-magnitude-policy.cjs
'use strict';
const path = require('node:path');
const policy = require(path.join(__dirname, '..', 'assets', 'progression-magnitude-policy.js'));
const PID = 'pid-replay';
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const sets = [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 }));
const plan = { updatedAt: '2026-08-31T00:00:00.000Z' };

function exposure(week, di, last) {
  const mk = (i, o) => Object.assign({ setIndex: i, load: 100, reps: 10, unit: 'KG', done: true, rirPrescribed: 2, rirReal: 2,
    autoFilled: false, express: false, ts: T0 + week * 864e5 + di * 36e5 + i }, o);
  return { prescriptionExerciseId: PID, planId: 'p', clientId: 'c', week, dayIndex: di, sets: [mk(0), mk(1), mk(2, last)] };
}
const tally = { scenarios: 0, candidateIncreases: 0, candidateDecreases: 0, maintainOrRest: 0, unresolvedBranch: 0,
  blockedByEvidence: 0, blockedByEquipmentIncrement: 0, blockedByRepBound: 0, coachReviewVolume: 0, otherBlocked: 0,
  eligible: 0, actionable: 0 };
for (const targetRir of [0, 1, 2, 3])
  for (const rirReal of [0, 1, 2, 3, 4, ''])
    for (const reps of [7, 8, 9, 10, 11, 12])
      for (const exposures of [1, 2, 3]) {
        const list = [];
        for (let i = 0; i < exposures; i++) list.push(exposure(1 + i, 0, i === exposures - 1 ? { rirPrescribed: targetRir, rirReal, reps } : {}));
        const d = policy.evaluate({ clientId: 'c', planId: 'p', prescriptionExerciseId: PID, plan,
          prescription: { prescriptionExerciseId: PID, repsRange: { min: 8, max: 12 }, sets }, exposures: list, context: {} });
        tally.scenarios++;
        if (d.eligible) tally.eligible++;
        if (d.actionable) tally.actionable++;
        if (d.coachReview.length) tally.coachReviewVolume++;
        if (d.unresolved) tally.unresolvedBranch++;
        if (d.reasonCodes.includes('INSUFFICIENT_COMPARABLE_EXPOSURES')) tally.blockedByEvidence++;
        if (d.reasonCodes.includes('EQUIPMENT_INCREMENT_POLICY_MISSING')) tally.blockedByEquipmentIncrement++;
        if (d.reasonCodes.includes('REP_RANGE_UPPER_BOUND') || d.reasonCodes.includes('REP_RANGE_LOWER_BOUND')) tally.blockedByRepBound++;
        const first = d.candidates[0];
        if (d.unresolved) { /* counted above */ }
        else if (first && first.ruleId === 'A') tally.candidateIncreases++;
        else if (first && first.ruleId === 'C') tally.maintainOrRest++;
        else if (d.ruleId === 'MAINTAIN') tally.maintainOrRest++;
        else if (!d.eligible && !d.reasonCodes.includes('INSUFFICIENT_COMPARABLE_EXPOSURES')) tally.otherBlocked++;
        if (first && (first.ruleId === 'D' || first.ruleId === 'E')) tally.candidateDecreases++;
      }
console.log(JSON.stringify(tally, null, 2));
