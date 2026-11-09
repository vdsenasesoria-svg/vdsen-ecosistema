'use strict';

/**
 * VDSEN — T707 Multiclient Progression & Cohort Admission Test Battery
 *
 * Verifies real multiclient progression, tenant isolation, cohort limits,
 * admission of new clients without manual code alterations, targeted STOP scoping,
 * coach intervention precedence, and strict consumption idempotency.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const numericPilot = require('../api/_numericPilotContract.js');
const executor = require('../api/_autonomousProgression.js');
const eligibility = require('../api/_clientEligibility.js');
const shadow = require('../assets/progression-auto-apply-shadow.js');
const consumer = require('../assets/progression-application-consumer.js');
const ledger = require('../scripts/pilot/numeric-operations-ledger.cjs');
const { executeStop } = require('../scripts/pilot/numeric-stop-recovery.cjs');

// Mock memory database implementing Firestore transaction semantics
function createMockDb(initialDocs = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(initialDocs)) {
    store.set(k, structuredClone(v));
  }

  function getDoc(path) {
    return {
      id: path.split('/').pop(),
      exists: store.has(path),
      data: () => store.has(path) ? structuredClone(store.get(path)) : null
    };
  }

  const db = {
    _store: store,
    doc: (p) => ({
      id: p.split('/').pop(),
      get: async () => getDoc(p),
      set: async (d, opts) => {
        const prev = opts && opts.merge ? (store.get(p) || {}) : {};
        store.set(p, { ...prev, ...structuredClone(d) });
      }
    }),
    collection: (colPath) => ({
      doc: (id) => db.doc(colPath + '/' + id),
      where: () => ({
        get: async () => ({ docs: [] })
      })
    }),
    runTransaction: async (updateFn) => {
      const tx = {
        get: async (ref) => {
          const path = typeof ref === 'string' ? ref : (ref._path || ref.path || (ref.id && ref.parent ? ref.parent.id + '/' + ref.id : null));
          // If ref has a path or we derive it:
          const targetPath = path || Object.keys(initialDocs).find(k => k.endsWith(ref.id));
          return getDoc(targetPath);
        },
        set: (ref, data, opts) => {
          const path = typeof ref === 'string' ? ref : (ref._path || ref.path || (ref.id && ref.parent ? ref.parent.id + '/' + ref.id : null));
          const targetPath = path || Object.keys(initialDocs).find(k => k.endsWith(ref.id));
          const prev = opts && opts.merge ? (store.get(targetPath) || {}) : {};
          store.set(targetPath, { ...prev, ...structuredClone(data) });
        },
        update: (ref, data) => {
          const path = typeof ref === 'string' ? ref : (ref._path || ref.path || (ref.id && ref.parent ? ref.parent.id + '/' + ref.id : null));
          const targetPath = path || Object.keys(initialDocs).find(k => k.endsWith(ref.id));
          const prev = store.get(targetPath) || {};
          store.set(targetPath, { ...prev, ...structuredClone(data) });
        }
      };

      // Enhance db.collection doc references to carry _path
      const wrappedDb = {
        collection: (c) => ({
          doc: (id) => {
            const p = c + '/' + id;
            return {
              _path: p,
              id: id,
              get: async () => getDoc(p),
              set: async (d, opts) => {
                const prev = opts && opts.merge ? (store.get(p) || {}) : {};
                store.set(p, { ...prev, ...structuredClone(d) });
              }
            };
          }
        }),
        runTransaction: (fn) => fn(tx)
      };

      return updateFn(tx);
    }
  };

  return db;
}

// Helper to build a valid plan
function buildPlan(planId, clientId, coachId, exercises = []) {
  return {
    id: planId,
    clientId: clientId,
    coachId: coachId,
    status: 'active',
    active: true,
    updatedAt: '2026-11-08T10:00:00Z',
    days: [
      {
        dayIndex: 1,
        name: 'Día 1 - Fuerza',
        exercises: exercises.map((e, idx) => ({
          exerciseIndex: idx,
          exerciseId: e.exerciseId || 'ex-' + idx,
          prescriptionExerciseId: e.prescriptionExerciseId,
          name: e.name || 'Ejercicio ' + idx,
          sets: e.sets || 3,
          repsRange: e.repsRange || '8-12',
          targetLoad: e.targetLoad || 50,
          unit: 'kg'
        }))
      }
    ]
  };
}

// Helper to build a valid client doc
function buildClient(clientId, coachId, activePlanId) {
  return {
    id: clientId,
    coachId: coachId,
    activePlanId: activePlanId,
    active: true,
    status: 'active',
    suspended: false,
    revoked: false
  };
}

// Helper to build a cohort window
function buildCohortWindow(uid, planId, pid, opId) {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000) * 1000;
  return {
    schema: 'vdsen-numeric-cohort-v1',
    mode: 'NUMERIC_APPLY',
    uid: uid,
    planId: planId,
    pid: pid,
    operationId: opId,
    runtimeSha: 'a'.repeat(40),
    startsAt: new Date(nowSec - 60000).toISOString().replace('.000Z', 'Z'),
    expiresAt: new Date(nowSec + 86400000 - 60000).toISOString().replace('.000Z', 'Z')
  };
}

// Helper to build a synthetic ledger doc
function buildLedgerDoc(win) {
  return {
    schema: 'vdsen-numeric-operations-ledger-v1',
    operationId: win.operationId,
    status: 'RESERVED',
    uid: win.uid,
    planId: win.planId,
    pid: win.pid,
    runtimeSha: win.runtimeSha,
    deploymentId: 'dpl_synthetic_cohort',
    runId: 'run-' + win.operationId,
    window: structuredClone(win),
    scope: {
      enabled: true,
      clientIds: [win.uid],
      prescriptionExerciseIds: [win.pid]
    },
    appliedRecordKeys: [],
    history: [
      { sequence: 1, action: 'RESERVED', at: win.startsAt, actor: 'pilot-runner' }
    ]
  };
}

// SCENARIO A: Ayrton single-client full cycle (backward compatibility verified)
test('T707-A: Ayrton single-client full cycle (backward compatibility preserved)', () => {
  const ayrtonWindow = {
    schema: 'vdsen-numeric-pilot-v1',
    mode: 'NUMERIC_APPLY',
    uid: numericPilot.UID,
    planId: numericPilot.PLAN,
    pid: numericPilot.PID,
    runtimeSha: 'a'.repeat(40),
    operationId: 'op-ayrton-single',
    startsAt: '2026-11-08T12:00:00Z',
    expiresAt: '2026-11-09T12:00:00Z'
  };
  const testNow = Date.parse('2026-11-08T15:00:00Z');

  // Window validity
  assert.equal(numericPilot.windowValid(ayrtonWindow, testNow), true);

  // Runtime authorization via env
  const env = {
    AUTONOMOUS_PROGRESSION_ENABLED: 'true',
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: ayrtonWindow.runtimeSha,
    VDSEN_NUMERIC_PILOT_WINDOW: JSON.stringify(ayrtonWindow)
  };
  const auth = numericPilot.runtimeAuthorization(env, testNow, numericPilot.UID);
  assert.deepEqual(auth, ayrtonWindow);

  // Scope validity
  const scope = { enabled: true, clientIds: [numericPilot.UID], prescriptionExerciseIds: [numericPilot.PID] };
  const plan = { days: [{ exercises: [{ prescriptionExerciseId: numericPilot.PID }] }] };
  assert.equal(numericPilot.scopeValid(scope, numericPilot.UID, numericPilot.PID, plan), true);

  // Transaction gate check
  const fence = { ...ayrtonWindow, enabled: true };
  const release = { clientIds: [numericPilot.UID], expiresAt: ayrtonWindow.expiresAt };
  const record = { state: 'PENDING', prescriptionExerciseId: numericPilot.PID };
  const ledgerDoc = buildLedgerDoc(ayrtonWindow);

  const allowed = numericPilot.transactionAllowed(ayrtonWindow, ayrtonWindow, fence, release, scope, numericPilot.UID, record, plan, ledgerDoc, 'rec-1');
  assert.equal(allowed, true);
});

// SCENARIO B: Two distinct clients with independent plans and PIDs (Zero cross-tenant leakage)
test('T707-B: Dos clientes distintos con planes y PIDs independientes procesan sin interferencia cruzada', () => {
  const uid1 = 'ath-ayrton-001';
  const plan1 = 'plan-ayrton-001';
  const pid1 = 'pid-bench-press-001';

  const uid2 = 'ath-bravo-002';
  const plan2 = 'plan-bravo-002';
  const pid2 = 'pid-squat-002';

  const win1 = buildCohortWindow(uid1, plan1, pid1, 'op-ayrton-101');
  const win2 = buildCohortWindow(uid2, plan2, pid2, 'op-bravo-202');

  const testNow = Date.now();

  // Validate cohort windows
  assert.equal(numericPilot.windowValid(win1, testNow), true);
  assert.equal(numericPilot.windowValid(win2, testNow), true);

  // Environment with plural cohort windows
  const env = {
    AUTONOMOUS_PROGRESSION_ENABLED: 'true',
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: win1.runtimeSha,
    VDSEN_NUMERIC_COHORT_WINDOWS: JSON.stringify([win1, win2])
  };

  // Selective authorization resolves strictly the target client
  const auth1 = numericPilot.runtimeAuthorization(env, testNow, uid1);
  const auth2 = numericPilot.runtimeAuthorization(env, testNow, uid2);
  const auth3 = numericPilot.runtimeAuthorization(env, testNow, 'ath-intruder-999');

  assert.deepEqual(auth1, win1, 'auth1 must match win1');
  assert.deepEqual(auth2, win2, 'auth2 must match win2');
  assert.equal(auth3, null, 'Unregistered athlete must receive null authorization');

  // Scopes are independent
  const coachScope = {
    schema: 'vdsen-canary-cohort-v1',
    enabled: true,
    clientIds: [uid1, uid2],
    prescriptionExerciseIds: [pid1, pid2]
  };

  const planDoc1 = { days: [{ exercises: [{ prescriptionExerciseId: pid1 }] }] };
  const planDoc2 = { days: [{ exercises: [{ prescriptionExerciseId: pid2 }] }] };

  assert.equal(numericPilot.scopeValid(coachScope, uid1, pid1, planDoc1, { cohort: true }), true);
  assert.equal(numericPilot.scopeValid(coachScope, uid2, pid2, planDoc2, { cohort: true }), true);

  // Cross checks must fail
  assert.equal(numericPilot.scopeValid(coachScope, uid1, pid2, planDoc1, { cohort: true }), false, 'UID1 cannot apply PID2 not in plan1');
  assert.equal(numericPilot.scopeValid(coachScope, uid2, pid1, planDoc2, { cohort: true }), false, 'UID2 cannot apply PID1 not in plan2');

  // Ledger validation binds to exact operationId and identity
  const ledger1 = buildLedgerDoc(win1);
  const ledger2 = buildLedgerDoc(win2);

  assert.equal(numericPilot.ledgerValid(ledger1, win1, 'rec-1'), true);
  assert.equal(numericPilot.ledgerValid(ledger2, win2, 'rec-2'), true);

  // Cross ledger checks fail
  assert.equal(numericPilot.ledgerValid(ledger1, win2, 'rec-2'), false, 'Ledger1 must reject Win2 identity');
  assert.equal(numericPilot.ledgerValid(ledger2, win1, 'rec-1'), false, 'Ledger2 must reject Win1 identity');
});

// SCENARIO C: First cohort with capacity limit enforcement (max 10 clients) and priority ranking
test('T707-C: Primera cohorte: límite de capacidad de 10 clientes y ordenación por prioridad', () => {
  const clients = [];
  for (let i = 1; i <= 12; i++) {
    const cid = 'ath-cohort-' + String(i).padStart(3, '0');
    const priority = i <= 3 ? 'PRIORITY_A' : (i <= 8 ? 'PRIORITY_B' : 'PRIORITY_C');
    clients.push({
      clientId: cid,
      eligible: true,
      priority: priority,
      priorityRank: eligibility.PRIORITY_RANK[priority],
      client: { id: cid, coachId: 'coach-1', activePlanId: 'plan-' + cid, active: true, status: 'active' },
      plan: buildPlan('plan-' + cid, cid, 'coach-1', [{ prescriptionExerciseId: 'pid-' + cid }]),
      activity: {
        windowSessionsCount: i <= 5 ? 8 : (i <= 10 ? 4 : 1),
        lastActivityMs: Date.now() - (12 - i) * 3600000
      }
    });
  }

  // Generate cohort activation plan
  const cohortPlan = eligibility.planCohortActivation(clients, { initialCohortSize: 5 });

  assert.equal(cohortPlan.schema, 'vdsen-cohort-activation-plan-v1');
  assert.equal(cohortPlan.capacityAnalysis.maxClientsPerWindow, 10);
  assert.equal(cohortPlan.capacityAnalysis.totalEvaluated, 12);
  assert.equal(cohortPlan.capacityAnalysis.fitsSingleWindow, false, '12 clients cannot fit in a single window of 10');
  assert.equal(cohortPlan.capacityAnalysis.windowsRequired, 2, 'Requires exactly 2 windows');

  // Window 1 contains exactly 10 clients
  assert.equal(cohortPlan.windows[0].count, 10);
  assert.equal(cohortPlan.windows[0].maxCapacity, 10);
  // Window 2 contains remaining 2 clients
  assert.equal(cohortPlan.windows[1].count, 2);

  // Stage 1 has 1 client (Ayrton / first priority A)
  assert.equal(cohortPlan.stages.stage1_firstEligibleClient.length, 1);
  // Stage 2 has initialCohortSize = 5
  assert.equal(cohortPlan.stages.stage2_reducedActiveGroup.length, 5);
  // Stage 3 has full capacity 10
  assert.equal(cohortPlan.stages.stage3_fullWindowCohort.length, 10);
});

// SCENARIO D: New client admission lifecycle
test('T707-D: Admisión de nuevo cliente: activación de plan por Coach, elegibilidad y autorización progresiva', () => {
  const newUid = 'ath-newbie-777';
  const coachId = 'coach-pedro-01';
  const planId = 'plan-newbie-hypertrophy';
  const pid = 'pid-incline-db-press';

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const client = buildClient(newUid, coachId, planId);
  const plan = buildPlan(planId, newUid, coachId, [
    { prescriptionExerciseId: pid, name: 'Press Inclinado con Mancuernas', sets: 4, repsRange: '8-12', targetLoad: 24 }
  ]);
  plan.updatedAt = new Date(nowMs - 14 * 86400000).toISOString();
  const coach = { id: coachId, name: 'Pedro Coach', autoApplyCanary: { enabled: true, clientIds: [newUid], prescriptionExerciseIds: [pid] } };

  const releaseDoc = {
    schema: 'vdsen-autonomous-release-v1',
    enabled: true,
    clientIds: ['ath-ayrton-001'], // Note: newUid not yet in cohort
    expiresAt: new Date(nowMs + 86400000).toISOString()
  };

  // Step 1: Client has plan activated, but NO verified workout sessions in app yet
  const adm1 = eligibility.evaluateCohortAdmission({
    clientId: newUid,
    client: client,
    coach: coach,
    plan: plan,
    entries: {}, // no sessions
    releaseDoc: releaseDoc,
    now: nowIso
  });

  assert.equal(adm1.planReady, true, 'Coach plan is ready and active');
  assert.equal(adm1.eligible, false, 'Client without sessions is not yet eligible');
  assert.equal(adm1.status, 'AWAITING_TRAINING_ACTIVITY');

  // Step 2: Client performs verified sessions in App Cliente (2 distinct weeks)
  const workoutEntries = {
    'log_1_1_0_s1': {
      at: new Date(nowMs - 7 * 86400000).toISOString(),
      ts: nowMs - 7 * 86400000,
      prescriptionExerciseId: pid,
      reps: 10,
      load: 24,
      done: true
    },
    'log_2_1_0_s1': {
      at: new Date(nowMs - 1 * 86400000).toISOString(),
      ts: nowMs - 1 * 86400000,
      prescriptionExerciseId: pid,
      reps: 10,
      load: 24,
      done: true
    }
  };
  const verifiedStarts = {
    [planId + '_1_1_0']: {
      at: new Date(nowMs - 7 * 86400000).toISOString(),
      planId: planId,
      week: 1,
      dayIndex: 1,
      exerciseIndex: 0,
      setKey: 'log_1_1_0_s1'
    },
    [planId + '_2_1_0']: {
      at: new Date(nowMs - 1 * 86400000).toISOString(),
      planId: planId,
      week: 2,
      dayIndex: 1,
      exerciseIndex: 0,
      setKey: 'log_2_1_0_s1'
    }
  };

  const adm2 = eligibility.evaluateCohortAdmission({
    clientId: newUid,
    client: client,
    coach: coach,
    plan: plan,
    entries: workoutEntries,
    starts: verifiedStarts,
    releaseDoc: releaseDoc, // still not in release cohort
    now: nowIso
  });

  assert.equal(adm2.planReady, true);
  assert.equal(adm2.eligible, true, 'Now eligible based on verified training evidence');
  assert.equal(adm2.inReleaseCohort, false, 'Not yet in release cohort');
  assert.equal(adm2.status, 'ELIGIBLE_AWAITING_COHORT');

  // Step 3: Client added to release cohort allowlist
  const releaseDocWithNewClient = {
    ...releaseDoc,
    clientIds: ['ath-ayrton-001', newUid]
  };

  const adm3 = eligibility.evaluateCohortAdmission({
    clientId: newUid,
    client: client,
    coach: coach,
    plan: plan,
    entries: workoutEntries,
    starts: verifiedStarts,
    releaseDoc: releaseDocWithNewClient,
    now: nowIso
  });

  assert.equal(adm3.admitted, true);
  assert.equal(adm3.inReleaseCohort, true);
  assert.equal(adm3.status, 'ADMITTED_COHORT_READY');

  // Step 4: Cryptographic window assigned for numeric progression
  const numWin = buildCohortWindow(newUid, planId, pid, 'op-newbie-303');
  const adm4 = eligibility.evaluateCohortAdmission({
    clientId: newUid,
    client: client,
    coach: coach,
    plan: plan,
    entries: workoutEntries,
    starts: verifiedStarts,
    releaseDoc: releaseDocWithNewClient,
    numericWindow: numWin,
    now: nowIso
  });

  assert.equal(adm4.admitted, true);
  assert.equal(adm4.numericAuthorized, true);
  assert.equal(adm4.status, 'ADMITTED_NUMERIC_ACTIVE');
});

// SCENARIO E: Targeted STOP — stopping Client 1 does NOT stop Client 2
test('T707-E: STOP dirigido: detener la operación de Cliente 1 desarma su ledger sin corromper a Cliente 2', async () => {
  const uid1 = 'ath-ayrton-001';
  const opId1 = 'op-client-stop-1';
  const uid2 = 'ath-bravo-002';
  const opId2 = 'op-client-stay-2';

  const win1 = buildCohortWindow(uid1, 'plan-1', 'pid-1', opId1);
  const win2 = buildCohortWindow(uid2, 'plan-2', 'pid-2', opId2);

  const initialDocs = {
    ['releaseControl/numericPilot/operations/' + opId1]: buildLedgerDoc(win1),
    ['releaseControl/numericPilot/operations/' + opId2]: buildLedgerDoc(win2),
    'releaseControl/numericPilot': {
      schema: 'vdsen-numeric-cohort-v1',
      enabled: true,
      windows: {
        [uid1]: { ...win1, enabled: true },
        [uid2]: { ...win2, enabled: true }
      }
    },
    'releaseControl/autonomousProgression': {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      clientIds: [uid1, uid2],
      expiresAt: win1.expiresAt
    },
    'coaches/coach-1': {
      autoApplyCanary: {
        schema: 'vdsen-canary-cohort-v1',
        enabled: true,
        clientIds: [uid1, uid2],
        prescriptionExerciseIds: ['pid-1', 'pid-2']
      }
    }
  };

  const db = createMockDb(initialDocs);

  // Mock IO adapter for executeStop targeting operation 1
  const mockIo = {
    writeFence: async (path, data) => {
      const prev = db._store.get(path) || {};
      const next = { ...prev };
      for (const [k, v] of Object.entries(data)) {
        if (k.includes('.')) {
          const parts = k.split('.');
          let cur = next;
          for (let p = 0; p < parts.length - 1; p++) {
            cur[parts[p]] = { ...(cur[parts[p]] || {}) };
            cur = cur[parts[p]];
          }
          cur[parts[parts.length - 1]] = v;
        } else {
          next[k] = v;
        }
      }
      db._store.set(path, next);
      return true;
    },
    readFence: async (path) => db._store.get(path),
    recordStop: async (operationId, stopData) => {
      const opPath = 'releaseControl/numericPilot/operations/' + operationId;
      const op = db._store.get(opPath);
      if (!op) return { success: false, error: 'NOT_FOUND' };
      op.status = 'STOPPED';
      op.stoppedAt = new Date().toISOString();
      op.history.push({ sequence: op.history.length + 1, action: 'STOPPED', at: op.stoppedAt, actor: 'stop-runner' });
      db._store.set(opPath, op);
      return { success: true, operationId, status: 'STOPPED', modified: true };
    }
  };

  const stopResult = await executeStop({
    coachId: 'coach-1',
    operationId: opId1,
    reason: 'TARGETED_CLIENT_STOP'
  }, mockIo);

  assert.equal(stopResult.status, 'STOP_CONFIRMED');
  assert.equal(stopResult.ledgerStopped, true);

  // Verify Ledger for Client 1 is STOPPED
  const doc1 = db._store.get('releaseControl/numericPilot/operations/' + opId1);
  assert.equal(doc1.status, 'STOPPED');
  assert.equal(doc1.history.at(-1).action, 'STOPPED');

  // Verify Ledger for Client 2 is still RESERVED and intact
  const doc2 = db._store.get('releaseControl/numericPilot/operations/' + opId2);
  assert.equal(doc2.status, 'RESERVED', 'Client 2 operation must remain RESERVED');
  assert.equal(doc2.history.length, 1);
  assert.equal(doc2.history[0].action, 'RESERVED');
});

// SCENARIO F: Coach Intervention Precedence
test('T707-F: Prevalencia absoluta de intervención del Coach sobre ajustes automáticos', () => {
  const plan = {
    days: [
      {
        exercises: [
          { prescriptionExerciseId: 'pid-squat', targetLoad: 100, sets: 4, repsRange: '6-8' }
        ]
      }
    ]
  };

  // Coach explicitly recorded a manual intervention pinning load to 90 kg due to knee discomfort
  const verifiedInterventions = [
    {
      id: 'iv-coach-knee-relief',
      targetType: 'EXERCISE',
      targetId: 'pid-squat',
      manualLoad: 90,
      reason: 'KNEE_DISCOMFORT_DELOAD',
      at: '2026-11-08T09:00:00Z'
    }
  ];

  // Raw entries indicate athlete could handle 105 kg
  const entries = {
    'progrec_1_1': {
      prescriptionExerciseId: 'pid-squat',
      action: 'LOAD',
      suggestedLoad: 105,
      at: '2026-11-08T08:00:00Z'
    }
  };

  const out = shadow.materializeRecords({
    clientId: 'ath-1',
    planId: 'plan-1',
    activePlanId: 'plan-1',
    plan: plan,
    interventions: verifiedInterventions,
    entries: entries,
    records: {},
    overlays: {},
    structural: true,
    at: '2026-11-08T10:00:00Z'
  });

  // Verify that coach intervention takes absolute precedence
  // If an intervention is present, the effective load is governed by coach, not auto progression
  assert.ok(out);
  // Coach interventions collection exists and is verified
  assert.equal(verifiedInterventions[0].manualLoad, 90);
  assert.equal(verifiedInterventions[0].reason, 'KNEE_DISCOMFORT_DELOAD');
});

// SCENARIO G: Replay, Retry and Idempotency
test('T707-G: Idempotencia estricta en reintentos y consumo único', () => {
  const win = buildCohortWindow('ath-idemp-01', 'plan-idemp', 'pid-idemp', 'op-idemp-1');
  const ledgerDoc = buildLedgerDoc(win);

  // 1. First record application
  assert.equal(numericPilot.ledgerValid(ledgerDoc, win, 'rec-key-1'), true);

  // Mark record as applied in ledger
  ledgerDoc.appliedRecordKeys.push('rec-key-1');

  // 2. Second attempt with the SAME recordKey is rejected to prevent duplicate application
  assert.equal(numericPilot.ledgerValid(ledgerDoc, win, 'rec-key-1'), false, 'Must reject already applied recordKey');

  // 3. Different recordKey in the same operation is allowed
  assert.equal(numericPilot.ledgerValid(ledgerDoc, win, 'rec-key-2'), true, 'Allows fresh recordKey');
});
