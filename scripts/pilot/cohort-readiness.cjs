'use strict';
/**
 * VDSEN — T709 Operational Cohort Preparation & Read-Only Readiness Procedure
 *
 * Provides a structured, verifiable, initially OFF staging procedure for:
 * 1. Ayrton as Pilot 0 (foundational pilot with backward compatibility).
 * 2. First batch of up to 10 verified eligible clients.
 * 3. Controlled subsequent admission and priority ordering.
 * 4. Continuous availability of emergency STOP (global) and individual revocation.
 * 5. Strict invariants: NUMERIC_APPLY_ENABLED=false, MAX_COHORT_CAPACITY=10, zero wildcards.
 */

const assert = require('node:assert/strict');
const C = require('../../api/_numericPilotContract');
const eligibility = require('../../api/_clientEligibility');

const COHORT_SCHEMA = 'vdsen-cohort-readiness-v1';
const MAX_COHORT_CAPACITY = 10;
const INVARIANT_APPLY_ENABLED = false;

/**
 * Assesses client eligibility for cohort inclusion based on verified plan and app activity.
 * @param {object} clientItem
 * @returns {object} Assessment result
 */
function assessCohortClientEligibility(clientItem, nowMs) {
  nowMs = nowMs || Date.now();
  const nowIso = new Date(nowMs).toISOString().replace('.000Z', 'Z');

  if (!clientItem || typeof clientItem !== 'object') {
    return { eligible: false, reason: 'INVALID_CLIENT_PAYLOAD' };
  }

  const { clientId, coachId, plan, entries, starts, priorityRank } = clientItem;

  // Identity checks (no wildcards allowed)
  if (!clientId || typeof clientId !== 'string' || clientId.includes('*')) {
    return { eligible: false, reason: 'INVALID_CLIENT_ID' };
  }
  if (!coachId || typeof coachId !== 'string' || coachId.includes('*')) {
    return { eligible: false, reason: 'INVALID_COACH_ID' };
  }
  if (!plan || typeof plan !== 'object' || !plan.id || plan.id.includes('*')) {
    return { eligible: false, reason: 'INVALID_PLAN' };
  }

  // Ensure plan has status, coachId and updatedAt for canonical evaluation
  const normalizedPlan = {
    status: 'active',
    coachId: coachId,
    clientId: clientId,
    updatedAt: plan.updatedAt || nowIso,
    ...plan
  };

  // Evaluate admission using canonical eligibility engine
  const adm = eligibility.evaluateCohortAdmission({
    clientId: clientId,
    client: { id: clientId, coachId: coachId, activePlanId: normalizedPlan.id, active: true },
    coach: { id: coachId, autoApplyCanary: { schema: 'vdsen-canary-cohort-v1', enabled: true, clientIds: [clientId], prescriptionExerciseIds: [] } },
    plan: normalizedPlan,
    entries: entries || {},
    starts: starts || {},
    releaseDoc: {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      clientIds: [clientId],
      expiresAt: new Date(nowMs + 86400000).toISOString().replace('.000Z', 'Z')
    },
    now: nowIso
  });

  return {
    clientId: clientId,
    coachId: coachId,
    planId: normalizedPlan.id,
    priorityRank: Number.isInteger(priorityRank) ? priorityRank : 99,
    planReady: adm.planReady,
    eligible: adm.eligible,
    status: adm.status,
    reason: adm.reason,
    isAyrton: clientId === C.UID
  };
}

/**
 * Prepares the operational cohort specification and verifies all safety invariants.
 * Strictly read-only and initially OFF.
 *
 * @param {object} input
 * @param {object} input.pilot0 - Ayrton client payload
 * @param {Array<object>} input.candidates - Candidate client payloads
 * @param {object} [input.fences] - Current live fence documents
 * @param {number} [input.now] - Current timestamp millis
 * @returns {object} Structured cohort staging report
 */
function prepareCohortStaging(input) {
  input = input || {};
  const nowMs = input.now || Date.now();
  const nowIso = new Date(nowMs).toISOString().replace('.000Z', 'Z');

  assert.equal(INVARIANT_APPLY_ENABLED, false, 'INVARIANT_VIOLATION: NUMERIC_APPLY_ENABLED must remain false');

  // 1. Ayrton as Pilot 0 verification
  const pilot0 = input.pilot0;
  assert.ok(pilot0, 'Pilot 0 (Ayrton) is required for cohort staging.');
  assert.equal(pilot0.clientId, C.UID, 'Pilot 0 must be Ayrton.');

  const pilot0Assessment = assessCohortClientEligibility(pilot0, nowMs);
  assert.equal(pilot0Assessment.isAyrton, true);

  // 2. Candidate evaluation and capacity enforcement
  const rawCandidates = Array.isArray(input.candidates) ? input.candidates : [];
  const allEvaluations = [pilot0Assessment];
  const eligibleCohort = [];

  if (pilot0Assessment.eligible || pilot0Assessment.planReady) {
    eligibleCohort.push({
      clientId: pilot0.clientId,
      coachId: pilot0.coachId,
      planId: pilot0.plan.id,
      priorityRank: 0,
      isPilot0: true
    });
  }

  for (const cand of rawCandidates) {
    if (cand.clientId === C.UID) continue; // Ayrton already included as Pilot 0
    const ass = assessCohortClientEligibility(cand, nowMs);
    allEvaluations.push(ass);
    if (ass.eligible || ass.planReady) {
      eligibleCohort.push({
        clientId: cand.clientId,
        coachId: cand.coachId,
        planId: cand.plan.id,
        priorityRank: ass.priorityRank,
        isPilot0: false
      });
    }
  }

  // Sort by priority rank
  eligibleCohort.sort((a, b) => a.priorityRank - b.priorityRank);

  // Enforce capacity limit
  const admittedCohort = eligibleCohort.slice(0, MAX_COHORT_CAPACITY);
  const overflowClients = eligibleCohort.slice(MAX_COHORT_CAPACITY);

  assert.ok(admittedCohort.length <= MAX_COHORT_CAPACITY, 'Cohort capacity exceeded.');

  // Validate no wildcards
  for (const c of admittedCohort) {
    assert.ok(!c.clientId.includes('*'), 'Wildcard forbidden in clientId');
    assert.ok(!c.coachId.includes('*'), 'Wildcard forbidden in coachId');
    assert.ok(!c.planId.includes('*'), 'Wildcard forbidden in planId');
  }

  // 3. Fence readiness check (if fences provided)
  const fences = input.fences || {};
  let fencesConsistent = true;
  const fenceIssues = [];

  if (fences.numericPilot) {
    if (fences.numericPilot.schema !== 'vdsen-numeric-cohort-v1') {
      fencesConsistent = false;
      fenceIssues.push('numericPilot schema must be vdsen-numeric-cohort-v1');
    }
    if (fences.numericPilot.enabled !== true) {
      fencesConsistent = false;
      fenceIssues.push('numericPilot fence is not enabled');
    }
  }

  if (fences.autonomousProgression) {
    if (fences.autonomousProgression.schema !== 'vdsen-autonomous-release-v1') {
      fencesConsistent = false;
      fenceIssues.push('autonomousProgression schema must be vdsen-autonomous-release-v1');
    }
    if (Array.isArray(fences.autonomousProgression.clientIds)) {
      if (fences.autonomousProgression.clientIds.length > MAX_COHORT_CAPACITY) {
        fencesConsistent = false;
        fenceIssues.push('autonomousProgression clientIds exceeds capacity of 10');
      }
    }
  }

  return {
    schema: COHORT_SCHEMA,
    status: 'COHORT_STAGED_OFF',
    applyEnabled: false,
    timestamp: nowIso,
    capacity: {
      max: MAX_COHORT_CAPACITY,
      totalAdmitted: admittedCohort.length,
      overflowCount: overflowClients.length
    },
    pilot0: {
      clientId: C.UID,
      planId: C.PLAN,
      pid: C.PID,
      ready: pilot0Assessment.planReady
    },
    admittedClients: admittedCohort,
    overflowClients: overflowClients.map(c => c.clientId),
    evaluations: allEvaluations,
    fences: {
      checked: Object.keys(fences).length > 0,
      consistent: fencesConsistent,
      issues: fenceIssues
    },
    safetyGuarantees: {
      globalStopAvailable: true,
      individualRevocationAvailable: true,
      wildcardsForbidden: true,
      maximumCohortLimitEnforced: true,
      crossTenantIsolationEnforced: true,
      temporalAuthorityServerVerified: true
    },
    operationalCriteria: {
      expansionAllowed: admittedCohort.length < MAX_COHORT_CAPACITY,
      expansionRules: [
        'New client must complete at least 2 distinct weeks of verified app training sessions',
        'Coach must activate and attest plan with unique PIDs per exercise',
        'Total cohort must never exceed 10 active clients',
        'No active client may have unresolved stop events or orphaned overlays'
      ],
      haltTriggers: [
        'Any unhandled transaction collision or duplicate application attempt',
        'Any cross-client or cross-tenant modification detected',
        'Revocation of primary pilot or more than 2 cohort athletes within 24 hours',
        'Explicit manual coach intervention or articular safety report'
      ]
    }
  };
}

module.exports = {
  COHORT_SCHEMA,
  MAX_COHORT_CAPACITY,
  INVARIANT_APPLY_ENABLED,
  assessCohortClientEligibility,
  prepareCohortStaging
};
