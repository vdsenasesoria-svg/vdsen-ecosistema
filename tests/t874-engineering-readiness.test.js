'use strict';
// T874 — Engineering Readiness & Real-Case Replay + REST-Promoted Alias Attestation Fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const effective = require(path.join(root, 'assets/progression-effective-prescription.js'));
const pilotContract = require(path.join(root, 'api/_numericPilotContract.js'));
const { attestRuntime } = require(path.join(root, 'scripts/pilot/numeric-attestation.cjs'));

function loadWithFlagOn(relPath) {
  const src = fs.readFileSync(path.join(root, relPath), 'utf8')
    .replace('var NUMERIC_APPLY_ENABLED = false;', 'var NUMERIC_APPLY_ENABLED = true;');
  const mod = { exports: {} };
  vm.runInNewContext(src, { module: mod, exports: mod.exports, require, console, Date, Math, Object, Array, Number, String, JSON, RegExp, Set, Map, Promise });
  return mod.exports;
}

const UID = pilotContract.UID;
const PLAN_ID = pilotContract.PLAN;
const PID_EXT = '506fb437-f151-499a-bbdb-512cd4d0b7c6';
const PID_PRESS_D3 = '453d6665-79a7-4052-a5a4-6cfc0f410187';
const PID_CURL_D2 = '361f6927-bd36-44b4-9b38-a6af94ec9268';
const T0 = Date.parse('2026-11-23T10:00:00.000Z');

const AYRTON_PLAN_SLICE = {
  clientId: UID,
  weeks: 13,
  updatedAt: '2026-11-22T00:00:00.000Z',
  days: [
    {
      dayIndex: 1,
      exercises: [
        {
          prescriptionExerciseId: PID_CURL_D2,
          exerciseId: 'curl-femoral-sentado-maquina',
          exerciseName: 'Curl femoral sentado máquina',
          muscleGroup: 'isquios',
          sets: [0, 1, 2].map((i) => ({ setIndex: i, repsTarget: 10, rirTarget: 3, restSeconds: 90 })),
        },
        {
          prescriptionExerciseId: PID_EXT,
          exerciseId: 'extension-de-cuadriceps',
          exerciseName: 'Extensión de cuádriceps',
          muscleGroup: 'cuadriceps',
          sets: [{ setIndex: 0, repsTarget: 12, rirTarget: 3, restSeconds: 75 }],
        },
      ],
    },
    {
      dayIndex: 2,
      exercises: [
        {
          prescriptionExerciseId: PID_PRESS_D3,
          exerciseId: 'press-convergente-inclinado',
          exerciseName: 'Press Convergente Inclinado',
          muscleGroup: 'pectoral',
          sets: [0, 1].map((i) => ({ setIndex: i, repsTarget: 10, rirTarget: 3, restSeconds: 120 })),
        },
      ],
    },
  ],
};

test('T874.1 Real-case replay of Ayrton recorded D2/D3 sessions under T873: Extensión de cuádriceps -> REST 75s->105s, Press D3 -> COACH_REVIEW_REQUIRED, Curl -> MAINTAIN', () => {
  const consumerOn = loadWithFlagOn('assets/progression-application-consumer.js');
  const effectiveOn = loadWithFlagOn('assets/progression-effective-prescription.js');

  const entries = {
    log_1_1_0_s0: { done: true, carga: '65', reps: '10', unit: 'KG', rir: 3, rir_real: 3, ics: 10, prescriptionExerciseId: PID_CURL_D2, ts: T0 + 1000 },
    log_1_1_0_s1: { done: true, carga: '65', reps: '10', unit: 'KG', rir: 3, rir_real: 3, ics: 10, prescriptionExerciseId: PID_CURL_D2, ts: T0 + 2000 },
    log_1_1_0_s2: { done: true, carga: '65', reps: '10', unit: 'KG', rir: 3, rir_real: 3, ics: 10, prescriptionExerciseId: PID_CURL_D2, ts: T0 + 3000 },
    log_1_1_1_s0: { done: true, carga: '95', reps: '10', unit: 'LB', rir: 3, rir_real: 3, ics: 10, prescriptionExerciseId: PID_EXT, ts: T0 + 4000 },
    log_1_2_0_s0: { done: true, carga: '35', reps: '10', unit: 'KG', rir: 3, rir_real: 2, ics: 10, prescriptionExerciseId: PID_PRESS_D3, ts: T0 + 5000 },
    log_1_2_0_s1: { done: true, carga: '35', reps: '10', unit: 'KG', rir: 3, rir_real: 2, ics: 10, prescriptionExerciseId: PID_PRESS_D3, ts: T0 + 6000 },
  };
  const calcAt = '2026-11-23T12:00:00.000Z';

  // 1) Extensión de cuádriceps D2 (maintain trigger deferred by T599-R D-01 -> Rule C REST +30s: 75 -> 105)
  const recExt = shadow.buildRecord(
    {
      clientId: UID, planId: PLAN_ID, activePlanId: PLAN_ID, plan: AYRTON_PLAN_SLICE, entries,
      week: 1, dayIndex: 1, calculatedAt: calcAt, sourceMatches: true, sourcePidCount: 1,
      recommendation: { prescriptionExerciseId: PID_EXT, exerciseId: 'extension-de-cuadriceps', exerciseName: 'Extensión de cuádriceps', action: 'maintain', newReps: 12 },
    },
    '2026-11-23T12:01:00.000Z'
  );
  assert.equal(recExt.state, 'PENDING');
  assert.equal(recExt.dimension, 'REST');
  assert.equal(recExt.magnitude.ruleId, 'C');
  assert.equal(recExt.magnitude.eligible, true);
  assert.equal(recExt.magnitude.candidates[0].previousValue, 75);
  assert.equal(recExt.magnitude.candidates[0].finalCandidate, 105);

  const planExt = consumerOn.planApplication({
    record: recExt,
    context: {
      clientId: UID, planId: PLAN_ID, activePlanId: PLAN_ID, plan: AYRTON_PLAN_SLICE, entries,
      interventions: [], existingOverlays: {}, now: '2026-11-23T12:05:00.000Z',
      resolveNextExposure: shadow.resolveNextExposure,
    },
  });
  assert.equal(planExt.canApply, true, JSON.stringify(planExt.blockers));
  assert.equal(planExt.overlay.dimension, 'REST');
  assert.equal(planExt.overlay.previousValue, 75);
  assert.equal(planExt.overlay.appliedValue, 105);
  assert.equal(planExt.overlay.target.week, 2);
  assert.equal(planExt.overlay.target.dayIndex, 1);

  const overlays = { [planExt.overlay.key]: Object.assign({}, planExt.overlay, { status: 'APPLIED' }) };
  const appliedRec = Object.assign({}, recExt, { state: 'APPLIED', lifecycle: { overlayKey: planExt.overlay.key, appliedAt: '2026-11-23T12:05:00.000Z' } });
  const effW2 = effectiveOn.resolveEffective({
    clientId: UID, planId: PLAN_ID, activePlanId: PLAN_ID, plan: AYRTON_PLAN_SLICE, entries, overlays,
    records: { [recExt.key]: appliedRec }, interventions: [], pid: PID_EXT, week: 2, dayIndex: 1,
    baseSets: AYRTON_PLAN_SLICE.days[0].exercises[1].sets,
  });
  assert.equal(effW2.provenance, effectiveOn.PROVENANCE.CANONICAL_OVERLAY);
  assert.equal(effW2.appliedValue, 105);
  assert.equal(effW2.sets[0].effective.restSeconds, 105);

  // 2) Press Convergente Inclinado D3 -> COACH_REVIEW_REQUIRED (Rule D, zero overlay)
  const recPress = shadow.buildRecord(
    {
      clientId: UID, planId: PLAN_ID, activePlanId: PLAN_ID, plan: AYRTON_PLAN_SLICE, entries,
      week: 1, dayIndex: 2, calculatedAt: calcAt, sourceMatches: true, sourcePidCount: 1,
      recommendation: { prescriptionExerciseId: PID_PRESS_D3, exerciseId: 'press-convergente-inclinado', exerciseName: 'Press Convergente Inclinado', action: 'add_sets' },
    },
    '2026-11-23T12:01:00.000Z'
  );
  assert.equal(recPress.magnitude.ruleId, 'D');
  assert.equal(recPress.magnitude.eligible, false);
  assert.equal(recPress.magnitude.coachReviewRequired.branch, 'D');

  // 3) Curl femoral D2 -> MAINTAIN (no adjustment)
  const recCurl = shadow.buildRecord(
    {
      clientId: UID, planId: PLAN_ID, activePlanId: PLAN_ID, plan: AYRTON_PLAN_SLICE, entries,
      week: 1, dayIndex: 1, calculatedAt: calcAt, sourceMatches: true, sourcePidCount: 1,
      recommendation: { prescriptionExerciseId: PID_CURL_D2, exerciseId: 'curl-femoral-sentado-maquina', exerciseName: 'Curl femoral sentado máquina', action: 'maintain', newReps: 10 },
    },
    '2026-11-23T12:01:00.000Z'
  );
  assert.equal(recCurl.state, 'REJECTED');
  assert.equal(recCurl.reasonCode, 'NO_NUMERIC_DELTA');

  // Static production guard stays OFF
  assert.equal(consumer.NUMERIC_APPLY_ENABLED, false);
  assert.equal(effective.NUMERIC_APPLY_ENABLED, false);
});

test('T874.2 REST-promoted --skip-domain deployment attestation defers to authoritative GET /v2/aliases/:alias and still rejects mismatched or foreign aliases', async () => {
  const prevGcloud = process.env.GCLOUD_PROJECT;
  const prevEmu = process.env.FIRESTORE_EMULATOR_HOST;
  process.env.GCLOUD_PROJECT = 'demo-vdsen-ops-test';
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  try {
  const SHA = 'df5caa39b273176d6fe415064c2b97619ddf7966';
  const OP = 'T874-ATTEST-REST-PROMOTE-01';
  const DPL = 'dpl_E949pJ41pmu3y3TDSwktYLrqtdrA';
  const ALIAS = 'vdsen-ecosistema.vercel.app';
  const OWN_URL = 'vdsen-ecosistema-3h979cslt-vdsenasesoria-svgs-projects.vercel.app';

  const makeDeployment = (alias) => ({
    id: DPL,
    url: OWN_URL,
    projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
    teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
    readyState: 'READY',
    target: 'production',
    alias,
    env: ['AUTONOMOUS_PROGRESSION_ENABLED', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'VDSEN_NUMERIC_PILOT_ENABLED', 'VDSEN_NUMERIC_PILOT_RUNTIME_SHA', 'VDSEN_NUMERIC_PILOT_WINDOW'],
    meta: { githubCommitSha: SHA, vdsenPilotOperation: OP, vdsenPilotUid: UID, vdsenPilotPlanId: PLAN_ID, vdsenPilotPid: PID_EXT },
  });

  const mockFetch = (dplPayload, liveAliasTarget) => async (url) => {
    if (String(url).includes('/v13/deployments/')) return { status: 200, json: async () => dplPayload };
    if (String(url).includes('/v2/aliases/')) return { status: 200, json: async () => ({ alias: ALIAS, deploymentId: liveAliasTarget }) };
    return { status: 404, json: async () => ({}) };
  };

  // Case A: alias=[] (or [ownUrl]) + live /v2/aliases confirms DPL -> ATTESTED
  for (const aliasArr of [[], [OWN_URL]]) {
    const ok = await attestRuntime({
      deploymentId: DPL, expectedSha: SHA, expectedOperationId: OP, expectedAlias: ALIAS,
      expectedUid: UID, expectedPlanId: PLAN_ID, expectedPid: PID_EXT,
      vercelToken: 'mock-token', fetcher: mockFetch(makeDeployment(aliasArr), DPL),
    });
    assert.equal(ok.attested, true, JSON.stringify(ok));
    assert.equal(ok.status, 'ATTESTED');
  }

  // Case B: alias=[] but live /v2/aliases points to a DIFFERENT deployment -> REJECTED ALIAS_LIVE_TARGET_MISMATCH
  const wrongLive = await attestRuntime({
    deploymentId: DPL, expectedSha: SHA, expectedOperationId: OP, expectedAlias: ALIAS,
    expectedUid: UID, expectedPlanId: PLAN_ID, expectedPid: PID_EXT,
    vercelToken: 'mock-token', fetcher: mockFetch(makeDeployment([]), 'dpl_other999'),
  });
  assert.equal(wrongLive.attested, false);
  assert.equal(wrongLive.reason, 'ALIAS_LIVE_TARGET_MISMATCH');

  // Case C: foreign alias listed on deployment -> REJECTED ALIAS_MISMATCH
  const foreign = await attestRuntime({
    deploymentId: DPL, expectedSha: SHA, expectedOperationId: OP, expectedAlias: ALIAS,
    expectedUid: UID, expectedPlanId: PLAN_ID, expectedPid: PID_EXT,
    vercelToken: 'mock-token', fetcher: mockFetch(makeDeployment(['staging.vdsen.com']), DPL),
  });
  assert.equal(foreign.attested, false);
  assert.equal(foreign.reason, 'ALIAS_MISMATCH');
  } finally {
    if (prevGcloud === undefined) delete process.env.GCLOUD_PROJECT; else process.env.GCLOUD_PROJECT = prevGcloud;
    if (prevEmu === undefined) delete process.env.FIRESTORE_EMULATOR_HOST; else process.env.FIRESTORE_EMULATOR_HOST = prevEmu;
  }
});
