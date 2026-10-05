'use strict';

const assert = require('assert');
const kernel = require('../api/vdsen-arbitration');

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log('  ✓ ' + msg);
}

// 1. Safety preempts every lower-priority proposal.
{
  const r = kernel.resolveArbitration({
    safetyStatus: 'HARD_STOP',
    proposals: [
      { id: 'm1', domain: 'TRAINING', decision: 'PROGRESS_VOLUME' },
      { id: 'n1', domain: 'NUTRITION', decision: 'INCREASE' },
      { id: 's1', domain: 'SUPPLEMENTATION', decision: 'ADD' }
    ]
  });
  ok(r.status === 'HOLD', 'HARD_STOP returns HOLD');
  ok(r.winnerAuthority === 'R0_BIOLOGICAL_SAFETY', 'R0 safety is authoritative');
  ok(r.decisions.every(d => d.action === 'BLOCK'), 'HARD_STOP blocks every lower-priority proposal');
  ok(r.posteriorUpdateAllowed === false, 'HARD_STOP freezes posterior learning');
}

// 2. Critical data invalidity outranks adaptation/progression.
{
  const r = kernel.resolveArbitration({
    dataQuality: 'CRITICAL_INVALID',
    proposals: [{ id: 'n1', domain: 'NUTRITION', decision: 'DECREASE' }]
  });
  ok(r.winnerAuthority === 'R1_DATA_CONTRACT_INTEGRITY', 'critical invalid data resolves at R1');
  ok(r.decisions[0].action === 'HOLD', 'critical invalid data holds proposed change');
}

// 3. Causal context invalidates inference without changing observed values.
{
  const context = kernel.buildCausalContext({ trainingLoadTransition: true });
  const s = kernel.validateSignals({ weightTrend: -0.7, performanceTrend: 'DOWN', adherenceScore: 'HIGH' }, context);
  ok(s.weightTrend.value === -0.7, 'observed weight value is preserved');
  ok(s.weightTrend.validity === 'INVALID_FOR_NUTRITION_INFERENCE', 'training transition invalidates weight inference');
  ok(s.performanceTrend.validity === 'INVALID_FOR_NUTRITION_INFERENCE', 'training transition invalidates performance inference');
  ok(s.adherenceScore.validity === 'VALID', 'unrelated adherence signal remains valid');
}

// 4. Deload/transition windows cannot train the metabolic posterior.
{
  const context = kernel.buildCausalContext({ deloadActive: true });
  const gate = kernel.posteriorLearningGate({
    adherence: 'HIGH',
    dataQuality: 'VALID',
    observationWindowMet: true,
    context
  });
  ok(gate.posteriorUpdate === false, 'DELOAD_ACTIVE freezes posterior update');
  ok(gate.freezeReasonCodes.includes('DELOAD_ACTIVE'), 'freeze records causal reason');
}

// 5. Low adherence freezes learning even when decision-making can continue.
{
  const gate = kernel.posteriorLearningGate({
    adherence: 'LOW',
    dataQuality: 'VALID',
    observationWindowMet: true,
    context: kernel.buildCausalContext({})
  });
  ok(gate.posteriorUpdate === false, 'low adherence blocks posterior learning');
  ok(gate.decisionMakingAllowed === true, 'low adherence does not fabricate a global safety stop');
}

// 6. Recovery compromised conflicts with energy decrease.
{
  const r = kernel.resolveArbitration({
    recoveryStatus: 'RECOVERY_COMPROMISED',
    proposals: [{ id: 'n1', domain: 'NUTRITION', decision: 'DECREASE' }]
  });
  ok(r.collisionCodes.includes('RECOVERY_ENERGY_CONFLICT'), 'recovery + decrease emits RECOVERY_ENERGY_CONFLICT');
  ok(r.decisions[0].action === 'BLOCK', 'nutrition decrease is blocked by recovery constraint');
}

// 7. Low energy availability blocks training-volume progression.
{
  const r = kernel.resolveArbitration({
    energyAvailability: 'LOW',
    proposals: [{ id: 'm1', domain: 'TRAINING', decision: 'PROGRESS_VOLUME' }]
  });
  ok(r.collisionCodes.includes('TRAINING_ENERGY_AVAILABILITY_CONFLICT'), 'low energy + volume progression emits collision');
  ok(r.decisions[0].action === 'BLOCK', 'training progression is blocked');
}

// 8. Hemodynamic warning blocks stimulant proposal from S1.
{
  const r = kernel.resolveArbitration({
    hemodynamicStatus: 'WARNING',
    proposals: [{ id: 's1', domain: 'SUPPLEMENTATION', decision: 'ADD', tags: ['STIMULANT'] }]
  });
  ok(r.collisionCodes.includes('HEMODYNAMIC_STIMULANT_CONFLICT'), 'hemodynamic warning + stimulant emits collision');
  ok(r.decisions[0].action === 'BLOCK', 'stimulant proposal is blocked');
}

// 9. Single-major-change policy preserves higher-priority adaptation.
{
  const r = kernel.resolveArbitration({
    proposals: [
      { id: 'training', domain: 'TRAINING', decision: 'PROGRESS_VOLUME', majorChange: true },
      { id: 'nutrition', domain: 'NUTRITION', decision: 'INCREASE', majorChange: true }
    ]
  });
  const n = r.decisions.find(d => d.proposalId === 'nutrition');
  const t = r.decisions.find(d => d.proposalId === 'training');
  ok(r.collisionCodes.includes('MULTIPLE_MAJOR_CHANGES'), 'multiple major changes are identified');
  ok(n.action === 'ALLOW', 'R4 nutrition adaptation is retained before R5 progression');
  ok(t.action === 'HOLD', 'lower-priority major training change is held');
}

// 10. Explicit exception permits simultaneous major changes but remains traceable at caller level.
{
  const r = kernel.resolveArbitration({
    singleMajorChangeException: true,
    proposals: [
      { id: 'training', domain: 'TRAINING', decision: 'PROGRESS_VOLUME', majorChange: true },
      { id: 'nutrition', domain: 'NUTRITION', decision: 'INCREASE', majorChange: true }
    ]
  });
  ok(!r.collisionCodes.includes('MULTIPLE_MAJOR_CHANGES'), 'explicit exception bypasses single-major-change hold');
  ok(r.decisions.every(d => d.action === 'ALLOW'), 'both non-conflicting proposals remain allowed under exception');
}

// 11. Cross-engine validator never authorizes numeric apply over unresolved arbitration.
{
  const arbitration = kernel.resolveArbitration({
    recoveryStatus: 'COMPROMISED',
    proposals: [{ id: 'n1', domain: 'NUTRITION', decision: 'DECREASE' }]
  });
  const v = kernel.crossEngineValidate({ arbitration, numericApplyEnabled: true });
  ok(v.valid === false, 'numeric apply fails when arbitration is not clean');
  ok(v.commitAllowed === false, 'commit is not authorized');
  ok(v.errors.includes('NUMERIC_APPLY_REQUIRES_CLEAN_ARBITRATION'), 'deterministic error explains failure');
}

// 12. Pure/read-only contract: caller proposal is unchanged.
{
  const proposal = { id: 'm1', domain: 'TRAINING', decision: 'PROGRESS_VOLUME', nested: { value: 1 } };
  const before = JSON.stringify(proposal);
  kernel.resolveArbitration({ energyAvailability: 'LOW', proposals: [proposal] });
  ok(JSON.stringify(proposal) === before, 'kernel never mutates engine proposal input');
}

console.log('');
console.log('Unified Arbitration Kernel: ' + pass + ' assertions PASSED');
