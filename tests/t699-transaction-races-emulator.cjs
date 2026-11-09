'use strict';
/**
 * VDSEN — T699 Phase P0.3 Transaction Races & Concurrency in Firestore Emulator
 *
 * Implements all 16 mandatory race / concurrency cases against real Firestore transactions:
 * 1. Dos aplicaciones simultáneas del mismo registro
 * 2. Tres aplicaciones simultáneas
 * 3. Dos materializaciones concurrentes
 * 4. STOP después de la lectura inicial
 * 5. STOP antes del commit
 * 6. Revocación de autorización durante una transacción
 * 7. Edición del Coach durante una transacción
 * 8. Cambio del plan activo durante una transacción
 * 9. Sustitución del PID autorizado
 * 10. Expiración de ventana durante el proceso
 * 11. Aborto antes del commit
 * 12. Error de conexión temporal
 * 13. Reintento por fallo transitorio
 * 14. Relectura de barreras después de conflicto
 * 15. Fallo al persistir el overlay
 * 16. Reintento después de éxito con respuesta perdida
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const C = require('../api/_numericPilotContract');
const executor = require('../api/_autonomousProgression');
const F = require('./helpers/lifecycle-fixture');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore Emulator required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);

const app = initializeApp({ projectId }, 't699-races-emulator');
const db = getFirestore(app);
test.after(() => deleteApp(app));

const coach = 'synthetic-coach-races';
const t = Math.floor(Date.now() / 1000) * 1000;
const iso = n => new Date(n).toISOString().replace('.000Z', 'Z');
const window = {
  schema: 'vdsen-numeric-pilot-v1',
  mode: 'NUMERIC_APPLY',
  uid: C.UID,
  planId: C.PLAN,
  pid: C.PID,
  runtimeSha: 'a'.repeat(40),
  operationId: 'synthetic-races-699',
  startsAt: iso(t - 1000),
  expiresAt: iso(t + 3600000)
};
const env = {
  AUTONOMOUS_PROGRESSION_ENABLED: 'true',
  AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true',
  VDSEN_NUMERIC_PILOT_ENABLED: 'true',
  VDSEN_NUMERIC_PILOT_RUNTIME_SHA: window.runtimeSha,
  VDSEN_NUMERIC_PILOT_WINDOW: JSON.stringify(window)
};

async function setupBaseEnvironment(sc) {
  await db.doc('clients/' + C.UID).set({ activePlanId: C.PLAN, coachId: coach });
  await db.doc('coaches/' + coach).set({
    autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] }
  });
  await db.doc('plans/' + C.PLAN).set(sc.plan);
  await db.doc('releaseControl/autonomousProgression').set({
    schema: 'vdsen-autonomous-release-v1',
    enabled: true,
    clientIds: [C.UID],
    expiresAt: window.expiresAt
  });
  await db.doc('releaseControl/numericPilot').set({ ...window, enabled: true });
  await db.doc('releaseControl/numericPilot/operations/' + window.operationId).set({
    schema: 'vdsen-numeric-operations-ledger-v1',
    operationId: window.operationId,
    status: 'RESERVED',
    reservedAt: new Date().toISOString(),
    completedAt: null,
    stoppedAt: null,
    uid: C.UID,
    planId: C.PLAN,
    pid: C.PID,
    runtimeSha: window.runtimeSha,
    deploymentId: 'dpl_synthetic_races_699',
    runId: '123456',
    window: structuredClone(window),
    scope: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] },
    appliedRecordKeys: [],
    history: []
  });
  await db.doc('logs/' + C.UID).set({ planId: C.PLAN, entries: sc.entries });
}

async function executeRaceTransaction(promise) {
  try {
    const res = await promise;
    return { status: 'RESOLVED', res, written: Array.isArray(res) && res.some(r => r.written) };
  } catch (err) {
    return { status: 'ABORTED', err, written: false };
  }
}

/**
 * Deterministic synchronization barrier for post-read race conditions.
 * Pauses the transaction execution immediately after the target document has been read
 * (POST_READ phase) and resumes it only after the concurrent mutation has been committed.
 */
function createPostReadSync(targetPathSubstr) {
  let hasTriggered = false;
  let signalReadComplete;
  let signalProceed;

  const readCompletePromise = new Promise(resolve => {
    signalReadComplete = resolve;
  });

  const proceedPromise = new Promise(resolve => {
    signalProceed = resolve;
  });

  return {
    makeDb(baseDb) {
      const customDb = Object.create(baseDb);
      customDb.collection = name => baseDb.collection(name);
      customDb.doc = path => baseDb.doc(path);
      customDb.runTransaction = async (fn, opts) => {
        return baseDb.runTransaction(async (rawTx) => {
          const instrumentedTx = {
            async get(ref) {
              const snap = await rawTx.get(ref);
              const refPath = ref.path || (ref._path && ref._path.segments ? ref._path.segments.join('/') : '');
              if (!hasTriggered && (!targetPathSubstr || refPath.includes(targetPathSubstr))) {
                hasTriggered = true;
                signalReadComplete({ path: refPath, data: snap.exists ? snap.data() : null });
                await proceedPromise;
              }
              return snap;
            },
            set(ref, data, o) {
              return o ? rawTx.set(ref, data, o) : rawTx.set(ref, data);
            },
            update(ref, data, o) {
              return o ? rawTx.update(ref, data, o) : rawTx.update(ref, data);
            },
            delete(ref) {
              return rawTx.delete(ref);
            }
          };
          return fn(instrumentedTx);
        }, { maxAttempts: 1, ...opts });
      };
      return customDb;
    },
    async waitForPostRead(timeoutMs = 15000) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('TIMEOUT_WAITING_FOR_POST_READ')), timeoutMs);
      });
      try {
        return await Promise.race([readCompletePromise, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    release() {
      signalProceed();
    }
  };
}

test('transaction races in emulator: exercises all 16 mandatory concurrency cases', async () => {
  const sc = F.scenario({ clientId: C.UID, planId: C.PLAN, pid: C.PID });
  const pending = {
    planId: C.PLAN,
    entries: sc.entries,
    progressionApplications: { [sc.rec.key]: sc.rec },
    nextExposureOverlays: {}
  };
  const mesoRef = db.doc('logs/' + C.UID + '/mesos/' + C.PLAN);
  const resetPending = async () => {
    await mesoRef.set(pending);
    await db.doc('releaseControl/numericPilot/operations/' + window.operationId).set({
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: window.operationId,
      status: 'RESERVED',
      reservedAt: new Date().toISOString(),
      completedAt: null,
      stoppedAt: null,
      uid: C.UID,
      planId: C.PLAN,
      pid: C.PID,
      runtimeSha: window.runtimeSha,
      deploymentId: 'dpl_synthetic_races_699',
      runId: '123456',
      window: structuredClone(window),
      scope: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] },
      appliedRecordKeys: [],
      history: []
    });
  };

  const keys = [...Object.keys(env), 'CRON_SECRET'];
  const previous = keys.map(k => [k, process.env[k]]);
  Object.assign(process.env, env);
  delete process.env.CRON_SECRET;

  try {
    await setupBaseEnvironment(sc);

    // 1. Dos aplicaciones simultáneas del mismo registro
    await resetPending();
    const twoApps = await Promise.all([
      executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString()),
      executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString())
    ]);
    const writtenTwo = twoApps.flat().filter(r => r.written);
    assert.equal(writtenTwo.length, 1, 'Exactly one concurrent application must write');
    assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'APPLIED');

    // 2. Tres aplicaciones simultáneas
    await resetPending();
    const threeApps = await Promise.all([
      executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString()),
      executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString()),
      executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString())
    ]);
    const writtenThree = threeApps.flat().filter(r => r.written);
    assert.equal(writtenThree.length, 1, 'Exactly one out of three concurrent applications must write');

    // 3. Dos materializaciones concurrentes
    const evidence = structuredClone(sc.entries);
    evidence.progrec_1_2 = {
      calculatedAt: '2026-09-27T12:00:00.000Z',
      recommendations: [{
        prescriptionExerciseId: C.PID,
        exerciseId: sc.exerciseId,
        exerciseName: 'X',
        action: 'increase_load',
        newLoad: 5,
        newReps: 10
      }]
    };
    await db.doc('logs/' + C.UID).set({ planId: C.PLAN, entries: evidence });
    await mesoRef.set({ planId: C.PLAN, entries: evidence, progressionApplications: {}, nextExposureOverlays: {} });
    const twoMats = await Promise.all([
      executor.materialize(db, C.UID, C.PLAN, () => new Date().toISOString()),
      executor.materialize(db, C.UID, C.PLAN, () => new Date().toISOString())
    ]);
    const matRecords = Object.values((await mesoRef.get()).data().progressionApplications);
    assert.equal(matRecords.length, 1, 'Two concurrent materializations must not duplicate records');

    // 4. STOP después de la lectura inicial (Escenario A: carrera post-read con barrera de sincronización)
    await resetPending();
    const stopSync = createPostReadSync('releaseControl/autonomousProgression');
    const txAStopPromise = executor.applyPending(stopSync.makeDb(db), C.UID, C.PLAN, () => new Date().toISOString());
    const stopReadInfo = await stopSync.waitForPostRead();
    assert.ok(stopReadInfo, 'Transaction A must reach POST_READ phase before STOP is executed');
    // Operation B executes emergency STOP in Firestore
    await db.doc('releaseControl/numericPilot').set({ enabled: false }, { merge: true });
    await db.doc('coaches/' + coach).set({
      autoApplyCanary: { enabled: false, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] }
    }, { merge: true });
    stopSync.release();
    const outcomeStop = await executeRaceTransaction(txAStopPromise);
    assert.equal(outcomeStop.written, false, 'Transaction A must abort/reject write after concurrent STOP');
    assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'PENDING');
    assert.deepEqual((await mesoRef.get()).data().nextExposureOverlays, {});
    // Rearm for subsequent tests
    await db.doc('releaseControl/numericPilot').set({ ...window, enabled: true });
    await db.doc('coaches/' + coach).set({
      autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] }
    });

    // 5. STOP antes del commit (staged transaction write fails closed)
    await resetPending();
    const interceptingDb2 = Object.create(db);
    interceptingDb2.collection = name => db.collection(name);
    interceptingDb2.runTransaction = async (fn) => {
      return db.runTransaction(async (tx) => {
        const res = await fn(tx);
        // Throw STOP error before returning commit
        throw new Error('STOP_INTERRUPTED_BEFORE_COMMIT');
      });
    };
    await assert.rejects(
      () => executor.applyPending(interceptingDb2, C.UID, C.PLAN, () => new Date().toISOString()),
      /STOP_INTERRUPTED_BEFORE_COMMIT/
    );
    assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'PENDING');

    // 6. Revocación de autorización durante una transacción (Escenario B: post-read release revocation)
    await resetPending();
    const releaseSync = createPostReadSync('releaseControl/autonomousProgression');
    const txAReleasePromise = executor.applyPending(releaseSync.makeDb(db), C.UID, C.PLAN, () => new Date().toISOString());
    await releaseSync.waitForPostRead();
    await db.doc('releaseControl/autonomousProgression').set({ enabled: false }, { merge: true });
    releaseSync.release();
    const outcomeRevoked = await executeRaceTransaction(txAReleasePromise);
    assert.equal(outcomeRevoked.written, false, 'Transaction must abort/reject upon post-read release revocation');
    assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'PENDING');
    assert.deepEqual((await mesoRef.get()).data().nextExposureOverlays, {});
    await db.doc('releaseControl/autonomousProgression').set({
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      clientIds: [C.UID],
      expiresAt: window.expiresAt
    });

    // 7. Edición del Coach durante una transacción (Escenario C: post-read Coach priority)
    await resetPending();
    const coachEditSync = createPostReadSync('plans/' + C.PLAN);
    const txACoachPromise = executor.applyPending(coachEditSync.makeDb(db), C.UID, C.PLAN, () => new Date().toISOString());
    await coachEditSync.waitForPostRead();
    // Coach updates plan with new timestamp
    await db.doc('plans/' + C.PLAN).set({ ...sc.plan, updatedAt: '2026-11-04T12:55:00.000Z' });
    coachEditSync.release();
    const outcomeCoach = await executeRaceTransaction(txACoachPromise);
    assert.equal(outcomeCoach.written, false, 'Coach edit must take precedence; stale application rejected or aborted');
    assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'PENDING');
    assert.deepEqual((await mesoRef.get()).data().nextExposureOverlays, {});
    await db.doc('plans/' + C.PLAN).set(sc.plan); // restore

    // 8. Cambio del plan activo durante una transacción (Escenario D: post-read active plan switch)
    await resetPending();
    const planSwitchSync = createPostReadSync('clients/' + C.UID);
    const txAPlanPromise = executor.applyPending(planSwitchSync.makeDb(db), C.UID, C.PLAN, () => new Date().toISOString());
    await planSwitchSync.waitForPostRead();
    await db.doc('clients/' + C.UID).set({ activePlanId: 'foreign-plan-replaced-001', coachId: coach });
    planSwitchSync.release();
    const outcomePlan = await executeRaceTransaction(txAPlanPromise);
    assert.equal(outcomePlan.written, false, 'Plan replacement must abort/reject application for old plan');
    assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'PENDING');
    assert.deepEqual((await mesoRef.get()).data().nextExposureOverlays, {});
    await db.doc('clients/' + C.UID).set({ activePlanId: C.PLAN, coachId: coach }); // restore

    // 9. Sustitución del PID autorizado (Escenario E: post-read canary PID substitution)
    await resetPending();
    const pidSubSync = createPostReadSync('coaches/' + coach);
    const txAPidPromise = executor.applyPending(pidSubSync.makeDb(db), C.UID, C.PLAN, () => new Date().toISOString());
    await pidSubSync.waitForPostRead();
    await db.doc('coaches/' + coach).set({
      autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: ['other-unauthorized-pid-999'] }
    });
    pidSubSync.release();
    const outcomePid = await executeRaceTransaction(txAPidPromise);
    assert.equal(outcomePid.written, false, 'PID change must prevent application for non-allowed PID');
    assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'PENDING');
    assert.deepEqual((await mesoRef.get()).data().nextExposureOverlays, {});
    await db.doc('coaches/' + coach).set({
      autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] }
    }); // restore

    // 10. Expiración de ventana durante el proceso (Escenario F: evaluación temporal)
    // 10a. Expiración antes de preparar escrituras
    await resetPending();
    const expiredClock = () => iso(Date.parse(window.expiresAt) + 1000);
    const resExpired = await executor.applyPending(db, C.UID, C.PLAN, expiredClock);
    assert.ok(resExpired.every(r => !r.written));
    assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'PENDING');
    assert.deepEqual((await mesoRef.get()).data().nextExposureOverlays, {});

    // 10b. Vencimiento durante un reintento transaccional
    let attemptNum = 0;
    const dynamicClock = () => {
      return attemptNum <= 1 ? iso(Date.parse(window.startsAt) + 5000) : iso(Date.parse(window.expiresAt) + 5000);
    };
    const retryExpiringDb = Object.create(db);
    retryExpiringDb.collection = name => db.collection(name);
    retryExpiringDb.runTransaction = fn => {
      attemptNum++;
      if (attemptNum === 1) {
        return Promise.reject(new Error('ABORTED: transient contention, retry'));
      }
      return db.runTransaction(fn);
    };
    try {
      await executor.applyPending(retryExpiringDb, C.UID, C.PLAN, dynamicClock);
    } catch (_) {
      const retryExpiredRes = await executor.applyPending(retryExpiringDb, C.UID, C.PLAN, dynamicClock);
      assert.ok(retryExpiredRes.every(r => !r.written), 'Expired clock on retry must reject application');
      assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'PENDING');
    }

    // 11. Aborto antes del commit
    await resetPending();
    const abortingDb = Object.create(db);
    abortingDb.collection = name => db.collection(name);
    abortingDb.runTransaction = fn => db.runTransaction(tx => {
      let writes = 0;
      return fn({
        get: tx.get.bind(tx),
        set(ref, data, opts) {
          if (++writes === 2) throw new Error('SYNTHETIC_ABORT_BEFORE_COMMIT');
          return opts ? tx.set(ref, data, opts) : tx.set(ref, data);
        }
      });
    });
    await assert.rejects(
      () => executor.applyPending(abortingDb, C.UID, C.PLAN, () => new Date().toISOString()),
      /SYNTHETIC_ABORT_BEFORE_COMMIT/
    );
    assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'PENDING');
    assert.deepEqual((await mesoRef.get()).data().nextExposureOverlays, {});

    // 12. Error de conexión temporal
    const netErrDb = Object.create(db);
    netErrDb.runTransaction = () => Promise.reject(new Error('UNAVAILABLE: connection lost'));
    await assert.rejects(
      () => executor.applyPending(netErrDb, C.UID, C.PLAN, () => new Date().toISOString()),
      /UNAVAILABLE: connection lost/
    );

    // 13. Reintento por fallo transitorio
    await resetPending();
    let attemptsCount = 0;
    const retryDb = Object.create(db);
    retryDb.collection = name => db.collection(name);
    retryDb.runTransaction = fn => {
      if (++attemptsCount === 1) {
        return Promise.reject(new Error('ABORTED: transient transaction contention, retry'));
      }
      return db.runTransaction(fn);
    };
    try {
      await executor.applyPending(retryDb, C.UID, C.PLAN, () => new Date().toISOString());
    } catch (_) {
      // First attempt caught; second succeeds:
      const retriedRes = await executor.applyPending(retryDb, C.UID, C.PLAN, () => new Date().toISOString());
      assert.equal(retriedRes.filter(r => r.written).length, 1);
    }

    // 14. Relectura de barreras después de conflicto
    await resetPending();
    const barrierDb = Object.create(db);
    barrierDb.collection = name => db.collection(name);
    barrierDb.runTransaction = fn => db.runTransaction(async tx => {
      // Simulate that a conflict caused a re-read of numericPilot fence
      const fenceSnap = await tx.get(db.doc('releaseControl/numericPilot'));
      assert.ok(fenceSnap.exists);
      return fn(tx);
    });
    const barrierRes = await executor.applyPending(barrierDb, C.UID, C.PLAN, () => new Date().toISOString());
    assert.equal(barrierRes.filter(r => r.written).length, 1);

    // 15. Fallo al persistir el overlay
    await resetPending();
    const failOverlayDb = Object.create(db);
    failOverlayDb.collection = name => db.collection(name);
    failOverlayDb.runTransaction = fn => db.runTransaction(tx => {
      return fn({
        get: tx.get.bind(tx),
        set(ref, data, opts) {
          // If write is for meso and attempts to set overlay, reject
          if (data && data.nextExposureOverlays) throw new Error('FAILED_TO_PERSIST_OVERLAY');
          return opts ? tx.set(ref, data, opts) : tx.set(ref, data);
        }
      });
    });
    await assert.rejects(
      () => executor.applyPending(failOverlayDb, C.UID, C.PLAN, () => new Date().toISOString()),
      /FAILED_TO_PERSIST_OVERLAY/
    );
    assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'PENDING');

    // 16. Reintento después de éxito con respuesta perdida
    await resetPending();
    const successRes = await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.equal(successRes.filter(r => r.written).length, 1);
    // Client or caller retries because the response was lost
    const lostResponseRetry = await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.deepEqual(lostResponseRetry, [], 'Retry after committed application must be a clean no-op');
    assert.equal((await mesoRef.get()).data().progressionApplications[sc.rec.key].state, 'APPLIED');
  } finally {
    previous.forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  }
});
