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
const effectivePrescription = require('../assets/progression-effective-prescription.js');
const ledger = require('../scripts/pilot/numeric-operations-ledger.cjs');
const { executeStop, executeClientRevocation } = require('../scripts/pilot/numeric-stop-recovery.cjs');

// Mock memory database implementing Firestore transaction semantics
function createMockDb(initialDocs = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(initialDocs)) {
    store.set(k, structuredClone(v));
  }

  function getDoc(path) {
    if (!path) return { id: null, exists: false, data: () => null };
    return {
      id: path.split('/').pop(),
      exists: store.has(path),
      data: () => store.has(path) ? structuredClone(store.get(path)) : null
    };
  }

  const db = {
    _store: store,
    doc: (p) => ({
      _path: p,
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
    weeks: 4,
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

// SCENARIO E: Scoped STOP & Individual Revocation vs Global Emergency Stop
test('T707-E: Revocación individual vs STOP global: revocar a Cliente 1 mantiene a Cliente 2 operativo hasta CONSUMED', async () => {
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

  // Mock IO adapter with full support for unflattening dotted keys and transaction execution
  const mockIo = {
    db: db,
    runTransaction: (fn) => db.runTransaction(fn),
    writeFence: async (path, data, opts) => {
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
      op.history.push({ sequence: op.history.length + 1, action: 'STOPPED', at: op.stoppedAt, actor: stopData.actor || 'stop-runner' });
      db._store.set(opPath, op);
      return { success: true, operationId, status: 'STOPPED', modified: true };
    }
  };

  // 1. Execute individual client revocation on Client 1
  const revResult = await executeClientRevocation({
    clientId: uid1,
    operationId: opId1,
    coachId: 'coach-1',
    reason: 'TARGETED_CLIENT_REVOCATION'
  }, mockIo);

  assert.equal(revResult.status, 'REVOCATION_CONFIRMED');
  assert.equal(revResult.success, true);
  assert.equal(revResult.fencesScopedDisarmed, true);
  assert.equal(revResult.ledgerStopped, true);

  // Verify Client 1 is revoked in all fences and ledger
  const numPost = db._store.get('releaseControl/numericPilot');
  assert.equal(numPost.enabled, true, 'Global numeric pilot must remain enabled');
  assert.equal(numPost.windows[uid1].enabled, false, 'Client 1 window must be disabled');
  assert.equal(numPost.windows[uid2].enabled, true, 'Client 2 window must remain enabled');

  const relPost = db._store.get('releaseControl/autonomousProgression');
  assert.equal(relPost.enabled, true, 'Global release control must remain enabled');
  assert.deepEqual(relPost.clientIds, [uid2], 'Client 1 must be removed, leaving Client 2');

  const coachPost = db._store.get('coaches/coach-1');
  assert.equal(coachPost.autoApplyCanary.enabled, true, 'Coach canary must remain enabled');
  assert.deepEqual(coachPost.autoApplyCanary.clientIds, [uid2], 'Client 1 removed from coach canary, leaving Client 2');

  const doc1 = db._store.get('releaseControl/numericPilot/operations/' + opId1);
  assert.equal(doc1.status, 'STOPPED');
  assert.equal(doc1.history.at(-1).action, 'STOPPED');

  // Verify Client 2 operation remains RESERVED
  const doc2 = db._store.get('releaseControl/numericPilot/operations/' + opId2);
  assert.equal(doc2.status, 'RESERVED', 'Client 2 operation must remain RESERVED');

  // 2. Client 1 progression attempt fails closed (window disabled and removed from allowlist)
  const adm1 = eligibility.evaluateCohortAdmission({
    clientId: uid1,
    client: { activePlanId: 'plan-1' },
    coach: { coachId: 'coach-1' },
    plan: { id: 'plan-1' },
    entries: {},
    starts: {},
    releaseDoc: relPost,
    numericWindow: numPost.windows[uid1]
  });
  assert.equal(adm1.inReleaseCohort, false, 'Client 1 is no longer in release cohort allowlist');
  assert.equal(adm1.numericAuthorized, false, 'Client 1 is not numerically authorized');

  // 3. Client 2 progression succeeds: PENDING -> APPLIED -> CONSUMED
  const client2 = buildClient(uid2, 'coach-1', 'plan-2');
  const plan2 = buildPlan('plan-2', uid2, 'coach-1', [
    { prescriptionExerciseId: 'pid-2', sets: 3, repsRange: '8-12', targetLoad: 80 }
  ]);
  plan2.updatedAt = new Date(Date.now() - 14 * 86400000).toISOString();

  const calcAt2 = new Date(Date.now() - 3600000).toISOString();
  const entries2 = {
    progrec_1_1: {
      calculatedAt: calcAt2,
      recommendations: [
        {
          prescriptionExerciseId: 'pid-2',
          exerciseName: 'Ejercicio 0',
          action: 'increase_load',
          currentLoad: 80,
          newLoad: 82.5,
          unit: 'kg'
        }
      ]
    },
    log_1_1_0_s1: { at: new Date(Date.now() - 7 * 86400000).toISOString(), prescriptionExerciseId: 'pid-2', done: true, reps: 8, load: 80, rpe: 8, sts: Date.now() - 7 * 86400000 },
    log_2_1_0_s1: { at: new Date(Date.now() - 1 * 86400000).toISOString(), prescriptionExerciseId: 'pid-2', done: true, reps: 8, load: 80, rpe: 8, sts: Date.now() - 1 * 86400000 }
  };
  const verifiedStarts2 = {
    ['plan-2_1_1_0']: {
      at: new Date(Date.now() - 7 * 86400000).toISOString(),
      planId: 'plan-2',
      week: 1,
      dayIndex: 1,
      exerciseIndex: 0,
      setKey: 'log_1_1_0_s1'
    },
    ['plan-2_2_1_0']: {
      at: new Date(Date.now() - 1 * 86400000).toISOString(),
      planId: 'plan-2',
      week: 2,
      dayIndex: 1,
      exerciseIndex: 0,
      setKey: 'log_2_1_0_s1'
    }
  };

  const adm2 = eligibility.evaluateCohortAdmission({
    clientId: uid2,
    client: client2,
    coach: { id: 'coach-1', autoApplyCanary: { enabled: true, clientIds: [uid2], prescriptionExerciseIds: ['pid-2'] } },
    plan: plan2,
    entries: entries2,
    starts: verifiedStarts2,
    releaseDoc: relPost,
    numericWindow: numPost.windows[uid2]
  });
  assert.equal(adm2.admitted, true, 'Client 2 admission confirmed');
  assert.equal(adm2.inReleaseCohort, true, 'Client 2 in release cohort');
  assert.equal(adm2.numericAuthorized, true, 'Client 2 authorized');

  // Materialize Client 2 record (PENDING)
  const mat2 = shadow.materializeRecords({
    clientId: uid2,
    planId: 'plan-2',
    activePlanId: 'plan-2',
    plan: plan2,
    entries: entries2,
    records: {},
    overlays: {},
    structural: true,
    at: new Date().toISOString()
  });
  const recKeys2 = Object.keys(mat2.records || {});
  assert.ok(recKeys2.length > 0, 'Client 2 record materialized');
  const recKey2 = recKeys2[0];
  const rec2 = mat2.records[recKey2];
  assert.equal(rec2.state, 'PENDING');

  // Verify transactionAllowed fails for revoked Client 1
  const rec1 = { state: 'PENDING', prescriptionExerciseId: 'pid-1' };
  const scopePost = db._store.get('coaches/coach-1').autoApplyCanary;
  const planDoc1 = { days: [{ exercises: [{ prescriptionExerciseId: 'pid-1' }] }] };
  const allowed1 = numericPilot.transactionAllowed(win1, win1, numPost.windows[uid1], relPost, scopePost, uid1, rec1, planDoc1, doc1, 'rec-1');
  assert.equal(allowed1, false, 'Client 1 transaction must be rejected');

  // Verify transactionAllowed succeeds for active Client 2
  const planDoc2 = { days: [{ exercises: [{ prescriptionExerciseId: 'pid-2' }] }] };
  const allowed2 = numericPilot.transactionAllowed(win2, win2, numPost.windows[uid2], relPost, scopePost, uid2, rec2, planDoc2, doc2, rec2.key);
  assert.equal(allowed2, true, 'Client 2 transaction must be allowed');

  // Transition Client 2 record to APPLIED
  const opKey2 = 'apply:' + rec2.key;
  const isoNow2 = new Date().toISOString();
  const appliedTrans = shadow.lifecycleTransition(rec2, 'APPLIED', {
    expectedRevision: rec2.revision,
    operationKey: opKey2,
    at: isoNow2,
    trustedServer: true,
    patch: { overlayKey: 'ovl_' + rec2.key, appliedAt: isoNow2 }
  });
  assert.equal(appliedTrans.ok, true, 'Transition to APPLIED succeeded');
  const appliedRec2 = appliedTrans.record;
  assert.equal(appliedRec2.state, 'APPLIED');

  // Transition Client 2 record to CONSUMED
  const consumeOpKey2 = 'consume:' + rec2.key;
  const consumedTrans = shadow.lifecycleTransition(appliedRec2, 'CONSUMED', {
    expectedRevision: appliedRec2.revision,
    operationKey: consumeOpKey2,
    at: isoNow2,
    trustedServer: true,
    patch: { consumedAt: isoNow2 }
  });
  assert.equal(consumedTrans.ok, true, 'Transition to CONSUMED succeeded');
  const consumedRec2 = consumedTrans.record;
  assert.equal(consumedRec2.state, 'CONSUMED');

  // 4. Test Emergency STOP GLOBAL: disarms all fences and halts the entire cohort
  const stopGlobalResult = await executeStop({
    coachId: 'coach-1',
    operationId: opId2,
    reason: 'EMERGENCY_GLOBAL_HALT'
  }, mockIo);
  assert.equal(stopGlobalResult.status, 'STOP_CONFIRMED');
  assert.equal(stopGlobalResult.allDisarmed, true);
  assert.equal(db._store.get('releaseControl/numericPilot').enabled, false);
  assert.equal(db._store.get('releaseControl/autonomousProgression').enabled, false);
  assert.equal(db._store.get('coaches/coach-1').autoApplyCanary.enabled, false);
});

// SCENARIO F: Coach Intervention Precedence & Non-Regression
test('T707-F: Prevalencia absoluta de intervención del Coach sobre ajustes automáticos', () => {
  const planId = 'plan-squat-strength';
  const pid = 'pid-squat';
  const plan = {
    id: planId,
    weeks: 4,
    updatedAt: '2026-11-08T09:30:00Z',
    days: [
      {
        dayIndex: 1,
        exercises: [
          { prescriptionExerciseId: pid, targetLoad: 90, sets: 4, repsRange: '6-8' }
        ]
      }
    ]
  };

  // Athlete log evidence at T0 (08:00) would have suggested 105 kg
  const calculatedAt = '2026-11-08T08:00:00Z';
  const entries = {
    log_1_1_0_s1: { prescriptionExerciseId: pid, done: true, reps: 8, load: 100, rpe: 7, sts: Date.parse(calculatedAt) }
  };

  // Coach explicitly records manual intervention at T1 (09:00 > T0) pinning load to 90 kg
  const coachDecisionTime = '2026-11-08T09:00:00Z';
  const verifiedInterventions = [
    {
      id: 'iv-coach-knee-relief',
      targetType: 'EXERCISE',
      targetId: pid,
      planId: planId,
      manualLoad: 90,
      action: 'MANUAL_OVERRIDE',
      reason: 'KNEE_DISCOMFORT_DELOAD',
      decidedAt: coachDecisionTime,
      at: coachDecisionTime
    }
  ];

  // 1. Materialization detects Coach intervention after calculation and marks candidate STALE
  const matOut = shadow.materializeRecords({
    clientId: 'ath-1',
    planId: planId,
    activePlanId: planId,
    plan: plan,
    interventions: verifiedInterventions,
    entries: entries,
    records: {},
    overlays: {},
    structural: true,
    at: '2026-11-08T10:00:00Z'
  });
  assert.ok(matOut);

  // 2. Candidate overlay evaluation strictly rejects auto-suggestion in favor of Coach override
  const candidateRecord = {
    key: 'rec_candidate_105',
    clientId: 'ath-1',
    planId: planId,
    prescriptionExerciseId: pid,
    state: 'APPLIED',
    createdAt: calculatedAt,
    source: { calculatedAt: calculatedAt, week: 1, dayIndex: 1 },
    nextExposure: { week: 2, dayIndex: 1 },
    lifecycle: { overlayKey: 'ovl_rec_candidate_105' }
  };
  const candidateOverlay = {
    key: 'ovl_rec_candidate_105',
    schema: 'vdsen-next-exposure-overlay-v1',
    sourceRecordKey: 'rec_candidate_105',
    clientId: 'ath-1',
    planId: planId,
    prescriptionExerciseId: pid,
    dimension: 'LOAD',
    previousValue: 100,
    appliedValue: 105,
    unit: 'KG',
    loadUnit: 'KG',
    status: 'APPLIED',
    target: { week: 2, dayIndex: 1 },
    source: { calculatedAt: calculatedAt, week: 1, dayIndex: 1 }
  };

  const evalResult = effectivePrescription.evaluateOverlay({
    clientId: 'ath-1',
    planId: planId,
    activePlanId: planId,
    pid: pid,
    week: 2,
    dayIndex: 1,
    plan: plan,
    interventions: verifiedInterventions,
    entries: entries,
    records: { [candidateRecord.key]: candidateRecord },
    overlays: { [candidateOverlay.key]: candidateOverlay }
  });

  assert.equal(evalResult.usable, false, 'Auto overlay must be unusable due to Coach intervention');
  assert.equal(evalResult.reason, 'COACH_OVERRIDE');
  assert.equal(evalResult.provenance, 'COACH_OVERRIDE');

  // 3. Resolve effective prescription: returns Coach prescription (90 kg), NEVER 105 kg
  const effectiveResult = effectivePrescription.resolveEffective({
    clientId: 'ath-1',
    planId: planId,
    activePlanId: planId,
    pid: pid,
    week: 2,
    dayIndex: 1,
    plan: plan,
    baseSets: [{ load: 90, repsTarget: 8 }],
    interventions: verifiedInterventions,
    entries: entries,
    records: { [candidateRecord.key]: candidateRecord },
    overlays: { [candidateOverlay.key]: candidateOverlay },
    canonicalOverlayRead: true
  });

  assert.equal(effectiveResult.provenance, 'COACH_OVERRIDE');
  assert.equal(effectiveResult.reason, 'COACH_OVERRIDE');
  assert.equal(effectiveResult.sets[0].effective.load, 90, 'Effective load must be Coach-defined 90 kg');
  assert.notEqual(effectiveResult.sets[0].effective.load, 105, 'Must NEVER recover auto-suggested 105 kg');

  // 4. Continuity & Restart persistence: carriedBaseline rejects carrying the displaced 105 kg
  const carried = effectivePrescription.carriedBaseline({
    clientId: 'ath-1',
    planId: planId,
    activePlanId: planId,
    pid: pid,
    week: 3,
    dayIndex: 1,
    plan: plan,
    interventions: verifiedInterventions,
    entries: entries,
    records: { [candidateRecord.key]: { ...candidateRecord, state: 'CONSUMED' } },
    overlays: { [candidateOverlay.key]: { ...candidateOverlay, status: 'CONSUMED' } }
  });

  assert.deepEqual(carried, {}, 'Carried baseline must be empty; coach override permanently displaces prior auto values');
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

// SCENARIO H: Cohort Readiness & Operational Staging
const {
  COHORT_SCHEMA,
  MAX_COHORT_CAPACITY,
  INVARIANT_APPLY_ENABLED,
  assessCohortClientEligibility,
  prepareCohortStaging
} = require('../scripts/pilot/cohort-readiness.cjs');

test('T707-H1: assessCohortClientEligibility clasifica correctamente elegibilidad de cliente', () => {
  const plan = { id: 'plan-ready-1', days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: 'pid-1' }] }] };
  const entries = {
    'log_1_0_0_s0': { done: true, prescriptionExerciseId: 'pid-1' },
    'log_2_0_0_s0': { done: true, prescriptionExerciseId: 'pid-1' }
  };
  const starts = {
    'st_1': { at: '2026-11-01T10:00:00Z', planId: 'plan-ready-1', week: 1, dayIndex: 0, exerciseIndex: 0 },
    'st_2': { at: '2026-11-08T10:00:00Z', planId: 'plan-ready-1', week: 2, dayIndex: 0, exerciseIndex: 0 }
  };

  const eligibleClient = {
    clientId: 'ath-cohort-01',
    coachId: 'coach-01',
    plan,
    entries,
    starts,
    priorityRank: 1
  };

  const res = assessCohortClientEligibility(eligibleClient);
  assert.equal(res.clientId, 'ath-cohort-01');
  assert.equal(res.planReady, true);
  assert.equal(res.status, 'NEEDS_VERIFIED_ACTIVITY');
  assert.equal(res.isAyrton, false);

  // Ayrton identification
  const ayrtonClient = {
    clientId: numericPilot.UID,
    coachId: 'coach-ayrton',
    plan: { id: numericPilot.PLAN },
    priorityRank: 0
  };
  const resAyrton = assessCohortClientEligibility(ayrtonClient);
  assert.equal(resAyrton.isAyrton, true);

  // Wildcards rejected
  assert.equal(assessCohortClientEligibility({ clientId: 'ath-*', coachId: 'c', plan }).eligible, false);
  assert.equal(assessCohortClientEligibility({ clientId: 'ath-1', coachId: 'coach-*', plan }).eligible, false);
  assert.equal(assessCohortClientEligibility({ clientId: 'ath-1', coachId: 'c', plan: { id: 'plan-*' } }).eligible, false);
});

test('T707-H2: prepareCohortStaging genera especificación de cohorte segura, inicialmente apagada y con tope de 10 clientes', () => {
  const ayrtonPilot0 = {
    clientId: numericPilot.UID,
    coachId: 'coach-ayrton',
    plan: { id: numericPilot.PLAN, days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: numericPilot.PID }] }] },
    entries: {},
    starts: {},
    priorityRank: 0
  };

  // 12 candidates to test capacity limit (max 10)
  const candidates = [];
  for (let i = 1; i <= 12; i++) {
    const cid = 'ath-cand-' + String(i).padStart(2, '0');
    const pid = 'pid-cand-' + i;
    const planId = 'plan-cand-' + i;
    candidates.push({
      clientId: cid,
      coachId: 'coach-01',
      plan: { id: planId, days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: pid }] }] },
      entries: {
        'log_1_0_0_s0': { done: true, prescriptionExerciseId: pid },
        'log_2_0_0_s0': { done: true, prescriptionExerciseId: pid }
      },
      starts: {
        'st_1': { at: '2026-11-01T10:00:00Z', planId, week: 1, dayIndex: 0, exerciseIndex: 0 },
        'st_2': { at: '2026-11-08T10:00:00Z', planId, week: 2, dayIndex: 0, exerciseIndex: 0 }
      },
      priorityRank: i
    });
  }

  const staging = prepareCohortStaging({
    pilot0: ayrtonPilot0,
    candidates
  });

  assert.equal(staging.schema, COHORT_SCHEMA);
  assert.equal(staging.status, 'COHORT_STAGED_OFF');
  assert.equal(staging.applyEnabled, false);
  assert.equal(staging.capacity.max, 10);
  assert.equal(staging.capacity.totalAdmitted, 10, 'Strict capacity limit of 10 enforced');
  assert.equal(staging.capacity.overflowCount, 3, 'Overflow candidates queued');
  assert.equal(staging.admittedClients[0].clientId, numericPilot.UID, 'Pilot 0 is Ayrton at rank 0');
  assert.equal(staging.safetyGuarantees.globalStopAvailable, true);
  assert.equal(staging.safetyGuarantees.individualRevocationAvailable, true);
  assert.equal(staging.safetyGuarantees.wildcardsForbidden, true);
  assert.ok(staging.operationalCriteria.expansionRules.length > 0);
  assert.ok(staging.operationalCriteria.haltTriggers.length > 0);
});

// SCENARIO I: Targeted Revocation Security & OCC Concurrency Guarantees (T710)
test('T710-A: Revocar un cliente con operationId ajeno resulta en rechazo inmediato y cero mutaciones indebidas', async () => {
  const uid1 = 'ath-ayrton-001';
  const opId1 = 'op-client-1';
  const uid2 = 'ath-bravo-002';
  const opId2 = 'op-client-2';

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
  const io = {
    db: db,
    runTransaction: (fn) => db.runTransaction(fn),
    writeFence: async (path, data) => true,
    readFence: async (path) => db._store.get(path)
  };

  // Attempt cross-client revocation: Client 1 attempting to revoke Client 2's operationId
  const result = await executeClientRevocation({
    clientId: uid1,
    operationId: opId2,
    coachId: 'coach-1',
    reason: 'MALICIOUS_CROSS_CLIENT_STOP'
  }, io);

  assert.equal(result.status, 'REVOCATION_INCOMPLETE');
  assert.equal(result.success, false);
  assert.ok(result.errors.some(e => e.includes('CROSS_CLIENT_OPERATION_DENIED') || e.includes('OPERATION_MISMATCH')));

  // Case 2: Window without operationId restriction, ledger uid mismatch triggers CROSS_CLIENT_OPERATION_DENIED directly
  const winNoOp = { ...buildCohortWindow(uid1, 'plan-1', 'pid-1', null), enabled: true };
  delete winNoOp.operationId;
  db._store.get('releaseControl/numericPilot').windows[uid1] = winNoOp;

  const result2 = await executeClientRevocation({
    clientId: uid1,
    operationId: opId2,
    coachId: 'coach-1',
    reason: 'ATTEMPT_CROSS_CLIENT_LEDGER_STOP'
  }, io);

  assert.equal(result2.status, 'REVOCATION_INCOMPLETE');
  assert.equal(result2.success, false);
  assert.ok(result2.errors.some(e => e.includes('CROSS_CLIENT_OPERATION_DENIED')));

  // ZERO mutations: verify Client 2 operation remains RESERVED
  const op2Doc = db._store.get('releaseControl/numericPilot/operations/' + opId2);
  assert.equal(op2Doc.status, 'RESERVED');
  assert.equal(op2Doc.history.length, 1);

  // Both windows remain enabled
  const numDoc = db._store.get('releaseControl/numericPilot');
  assert.equal(numDoc.windows[uid1].enabled, true);
  assert.equal(numDoc.windows[uid2].enabled, true);

  // Both clients remain in allowlists
  const relDoc = db._store.get('releaseControl/autonomousProgression');
  assert.deepEqual(relDoc.clientIds, [uid1, uid2]);
});

test('T710-B: Revocar cliente cuya ventana no existe produce REVOCATION_INCOMPLETE y cero mutaciones', async () => {
  const initialDocs = {
    'releaseControl/numericPilot': {
      schema: 'vdsen-numeric-cohort-v1',
      enabled: true,
      windows: {
        'ath-known': { enabled: true, uid: 'ath-known' }
      }
    },
    'releaseControl/autonomousProgression': {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      clientIds: ['ath-known']
    },
    'coaches/coach-1': {
      autoApplyCanary: { enabled: true, clientIds: ['ath-known'] }
    }
  };

  const db = createMockDb(initialDocs);
  const io = {
    db: db,
    runTransaction: (fn) => db.runTransaction(fn),
    writeFence: async (path, data) => true,
    readFence: async (path) => db._store.get(path)
  };

  const result = await executeClientRevocation({
    clientId: 'ath-unknown-ghost',
    operationId: 'op-ghost-01',
    coachId: 'coach-1'
  }, io);

  assert.equal(result.status, 'REVOCATION_INCOMPLETE');
  assert.equal(result.success, false);
  assert.ok(result.errors.some(e => e.includes('WINDOW_NOT_FOUND')));

  // Fences remain untouched
  const relDoc = db._store.get('releaseControl/autonomousProgression');
  assert.deepEqual(relDoc.clientIds, ['ath-known']);
});

test('T710-C: Dos revocaciones concurrentes con adaptadores atómicos no producen pérdida de cambios', async () => {
  const uid1 = 'ath-ayrton-001', uid2 = 'ath-bravo-002', uid3 = 'ath-charlie-003';
  const opId1 = 'op-c1', opId2 = 'op-c2', opId3 = 'op-c3';

  const win1 = buildCohortWindow(uid1, 'p1', 'pid1', opId1);
  const win2 = buildCohortWindow(uid2, 'p2', 'pid2', opId2);
  const win3 = buildCohortWindow(uid3, 'p3', 'pid3', opId3);

  const initialDocs = {
    ['releaseControl/numericPilot/operations/' + opId1]: buildLedgerDoc(win1),
    ['releaseControl/numericPilot/operations/' + opId2]: buildLedgerDoc(win2),
    ['releaseControl/numericPilot/operations/' + opId3]: buildLedgerDoc(win3),
    'releaseControl/numericPilot': {
      schema: 'vdsen-numeric-cohort-v1',
      enabled: true,
      windows: {
        [uid1]: { ...win1, enabled: true },
        [uid2]: { ...win2, enabled: true },
        [uid3]: { ...win3, enabled: true }
      }
    },
    'releaseControl/autonomousProgression': {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      clientIds: [uid1, uid2, uid3]
    },
    'coaches/coach-1': {
      autoApplyCanary: {
        enabled: true,
        clientIds: [uid1, uid2, uid3],
        prescriptionExerciseIds: ['pid1', 'pid2', 'pid3']
      }
    }
  };

  const db = createMockDb(initialDocs);
  const io = {
    db: db,
    runTransaction: (fn) => db.runTransaction(fn),
    writeFence: async (path, data) => true,
    readFence: async (path) => db._store.get(path)
  };

  const [res1, res2] = await Promise.all([
    executeClientRevocation({ clientId: uid1, operationId: opId1, coachId: 'coach-1', reason: 'REV_1' }, io),
    executeClientRevocation({ clientId: uid2, operationId: opId2, coachId: 'coach-1', reason: 'REV_2' }, io)
  ]);

  assert.equal(res1.status, 'REVOCATION_CONFIRMED');
  assert.equal(res2.status, 'REVOCATION_CONFIRMED');

  const finalRel = db._store.get('releaseControl/autonomousProgression');
  assert.deepEqual(finalRel.clientIds, [uid3], 'Both uid1 and uid2 excluded; uid3 retained without lost updates');

  const finalCoach = db._store.get('coaches/coach-1');
  assert.deepEqual(finalCoach.autoApplyCanary.clientIds, [uid3], 'Both clients removed from coach canary');

  const finalNum = db._store.get('releaseControl/numericPilot');
  assert.equal(finalNum.windows[uid1].enabled, false);
  assert.equal(finalNum.windows[uid2].enabled, false);
  assert.equal(finalNum.windows[uid3].enabled, true);
});

test('T710-D: Admisión y revocación concurrentes: conservar miembros autorizados y excluir al revocado', async () => {
  const uid1 = 'ath-c1', uid2 = 'ath-c2', uidNew = 'ath-admitted-new';
  const opId1 = 'op-c1', opId2 = 'op-c2';

  const win1 = buildCohortWindow(uid1, 'p1', 'pid1', opId1);
  const win2 = buildCohortWindow(uid2, 'p2', 'pid2', opId2);

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
      clientIds: [uid1, uid2]
    },
    'coaches/coach-1': {
      autoApplyCanary: {
        enabled: true,
        clientIds: [uid1, uid2],
        prescriptionExerciseIds: ['pid1', 'pid2']
      }
    }
  };

  const db = createMockDb(initialDocs);
  const io = {
    db: db,
    runTransaction: (fn) => db.runTransaction(fn),
    writeFence: async (path, data) => true,
    readFence: async (path) => db._store.get(path)
  };

  // Concurrently: revoke uid1 while an admission process adds uidNew
  const admissionTask = db.runTransaction(async (tx) => {
    const relRef = db.doc('releaseControl/autonomousProgression');
    const coachRef = db.doc('coaches/coach-1');
    const [relSnap, coachSnap] = await Promise.all([tx.get(relRef), tx.get(coachRef)]);
    const relData = relSnap.data();
    const coachData = coachSnap.data();

    const newRelIds = [...relData.clientIds, uidNew];
    const newCoachIds = [...coachData.autoApplyCanary.clientIds, uidNew];

    tx.set(relRef, { clientIds: newRelIds }, { merge: true });
    tx.set(coachRef, { autoApplyCanary: { ...coachData.autoApplyCanary, clientIds: newCoachIds } }, { merge: true });
    return true;
  });

  const revocationTask = executeClientRevocation({
    clientId: uid1,
    operationId: opId1,
    coachId: 'coach-1',
    reason: 'TARGETED_STOP'
  }, io);

  const [admitted, revResult] = await Promise.all([admissionTask, revocationTask]);
  assert.equal(admitted, true);
  assert.equal(revResult.status, 'REVOCATION_CONFIRMED');

  const finalRel = db._store.get('releaseControl/autonomousProgression');
  assert.ok(finalRel.clientIds.includes(uid2), 'Existing client 2 preserved');
  assert.ok(finalRel.clientIds.includes(uidNew), 'Newly admitted client preserved');
  assert.ok(!finalRel.clientIds.includes(uid1), 'Revoked client excluded');
});

test('T710-E: Adaptador sin precondiciones OCC ni transacción atómica falla cerrado sin realizar escrituras', async () => {
  let writesAttempted = 0;
  const insecureIo = {
    readFence: async (p) => ({ enabled: true }),
    writeFence: async (p, d) => { writesAttempted++; return true; },
    recordStop: async () => ({ success: true })
  };

  const result = await executeClientRevocation({
    clientId: 'ath-1',
    operationId: 'op-1',
    coachId: 'coach-1'
  }, insecureIo);

  assert.equal(result.status, 'REVOCATION_INCOMPLETE');
  assert.equal(result.success, false);
  assert.equal(writesAttempted, 0, 'Zero writes must be performed on adapters without concurrency guarantees');
  assert.ok(result.errors.some(e => e.includes('ADAPTER_UNSUPPORTED_CONCURRENCY_GUARANTEES')));
});

test('T710-F: STOP repetido sobre ledger en estado terminal preserva integridad e idempotencia sin eventos duplicados', async () => {
  const uid = 'ath-ayrton-001';
  const opId = 'op-terminal-01';
  const win = buildCohortWindow(uid, 'plan-1', 'pid-1', opId);

  const initialDocs = {
    ['releaseControl/numericPilot/operations/' + opId]: buildLedgerDoc(win),
    'releaseControl/numericPilot': {
      schema: 'vdsen-numeric-cohort-v1',
      enabled: true,
      windows: { [uid]: { ...win, enabled: true } }
    },
    'releaseControl/autonomousProgression': {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      clientIds: [uid]
    },
    'coaches/coach-1': {
      autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: ['pid-1'] }
    }
  };

  const db = createMockDb(initialDocs);
  const io = {
    db: db,
    runTransaction: (fn) => db.runTransaction(fn),
    writeFence: async (path, data) => true,
    readFence: async (path) => db._store.get(path)
  };

  // First revocation: transitions ledger from RESERVED to STOPPED
  const firstRev = await executeClientRevocation({ clientId: uid, operationId: opId, coachId: 'coach-1' }, io);
  assert.equal(firstRev.status, 'REVOCATION_CONFIRMED');

  const docAfterFirst = db._store.get('releaseControl/numericPilot/operations/' + opId);
  assert.equal(docAfterFirst.status, 'STOPPED');
  const historyLenAfterFirst = docAfterFirst.history.length;
  assert.equal(docAfterFirst.history.at(-1).action, 'STOPPED');

  // Second revocation with same parameters: idempotent, must NOT add duplicate STOP action
  const secondRev = await executeClientRevocation({ clientId: uid, operationId: opId, coachId: 'coach-1' }, io);
  assert.equal(secondRev.status, 'REVOCATION_CONFIRMED');

  const docAfterSecond = db._store.get('releaseControl/numericPilot/operations/' + opId);
  assert.equal(docAfterSecond.status, 'STOPPED');
  assert.equal(docAfterSecond.history.length, historyLenAfterFirst, 'Duplicate STOP event must not be appended to history');
});
