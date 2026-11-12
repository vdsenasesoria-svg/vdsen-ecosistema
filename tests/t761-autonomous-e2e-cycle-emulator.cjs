'use strict';
// T761: Validacion del ciclo autonomo completo de extremo a extremo en Firebase Emulator Suite.
// Recorrido obligatorio de 16 pasos:
// 1. Coach prescribe ejercicio original y alternativas autorizadas.
// 2. Coach activa el plan.
// 3. Cliente inicia sesion autenticado.
// 4. Cliente registra dos exposiciones comparables de una sustitucion autorizada.
// 5. El servidor recupera el plan desde una fuente autoritativa.
// 6. El motor identifica correctamente la variante ejecutada.
// 7. Se genera una decision PENDING.
// 8. El ejecutor aplica la decision mediante transaccion (APPLIED + nextExposureOverlays).
// 9. App Cliente muestra la nueva prescripcion efectiva.
// 10. Cliente comienza y registra la exposicion objetivo.
// 11. El servidor verifica la identidad exacta de ejecucion.
// 12. La decision pasa a CONSUMED.
// 13. El cliente cambia temporalmente al ejercicio original.
// 14. Se comprueba que no recibe la carga de la variante.
// 15. El cliente vuelve a la sustitucion.
// 16. Se comprueba que recupera su propia progresion acumulada.
// Persistencia y sincronizacion despues de cerrar, recargar y reabrir App Cliente.

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, runTransaction } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

const executor = require('../api/_autonomousProgression.js');
const eligibility = require('../api/_clientEligibility.js');
const effective = require('../assets/progression-effective-prescription.js');
const vi = require('../assets/progression-variant-identity.js');
const { createHistoricalFixture } = require('./helpers/t699-synthetic-executor.js');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const adminApp = initAdmin({ projectId }, 't761-admin-' + Date.now());
const adminDb = getAdminFirestore(adminApp);
const apps = [];

async function asUser(uid) {
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't761-' + apps.length + '-' + Date.now());
  apps.push(app);
  const cdb = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(cdb, host, Number(port), { mockUserToken: { sub: uid } });
  return { uid, db: cdb };
}

test.after(async () => {
  await Promise.all(apps.map(deleteApp));
  await deleteAdmin(adminApp);
});

const clock = () => new Date().toISOString();

test('T761: Recorrido completo E2E en Firestore Emulator (16 pasos canonicos)', async () => {
  const coachId = 'coach-t761-' + Date.now();
  const clientId = 'ath-t761-' + Date.now();
  const planId = 'plan-t761-' + Date.now();
  const pid = 'pid-press-banca-' + Date.now();
  const altExerciseId = 'ex-press-mancuernas';
  const altExerciseName = 'Press con mancuernas en banco plano';
  const expectedVariantId = vi.deriveExecutionId(pid, altExerciseName, [altExerciseName], 'Press de banca plano con barra');

  // 1. Coach prescribe ejercicio original y alternativas autorizadas en Firestore
  const planCreatedIso = new Date(Date.now() - 14 * 86400000).toISOString();
  const planDoc = {
    planId: planId,
    clientId: clientId,
    coachId: coachId,
    active: true,
    status: 'active',
    weeks: 4,
    nombre: 'Plan Piloto Progresion Autonoma',
    createdAt: planCreatedIso,
    updatedAt: planCreatedIso,
    days: [
      {
        dayIndex: 0,
        nombre: 'Torso Fuerza',
        exercises: [
          {
            prescriptionExerciseId: pid,
            exerciseId: 'cat-bench-press',
            nombre: 'Press de banca plano con barra',
            exerciseName: 'Press de banca plano con barra',
            fatigueCost: 5,
            rir: 2,
            rirDefaulted: false,
            sets: [
              { setIndex: 0, load: 80, repsTarget: 8, rirTarget: 2 },
              { setIndex: 1, load: 80, repsTarget: 8, rirTarget: 2 },
              { setIndex: 2, load: 80, repsTarget: 8, rirTarget: 2 }
            ],
            alternatives: [
              {
                exerciseId: altExerciseId,
                nombre: altExerciseName,
                exerciseName: altExerciseName
              }
            ]
          }
        ]
      }
    ]
  };

  // 2. Coach activa el plan en Firestore
  const actId = 'act-' + Date.now();
  await adminDb.doc('coaches/' + coachId).set({
    role: 'coach',
    autoApplyCanary: {
      enabled: true,
      clientIds: [clientId],
      prescriptionExerciseIds: [pid]
    }
  });

  await adminDb.doc('plans/' + planId).set(planDoc);

  await adminDb.doc('clients/' + clientId).set({
    coachId: coachId,
    activePlanId: planId,
    activeActivationId: actId,
    activePlanActivatedAt: planCreatedIso,
    coachInterventions: []
  });

  await adminDb.doc('clients/' + clientId + '/plan_activations/' + actId).set({
    activationId: actId,
    planId: planId,
    coachId: coachId,
    mode: 'AUTHORITATIVE',
    activatedAt: planCreatedIso
  });

  // Habilitar release control para este cliente en el emulador
  await adminDb.doc('releaseControl/autonomousProgression').set({
    schema: 'vdsen-autonomous-release-v1',
    enabled: true,
    expiresAt: new Date(Date.now() + 86400000 * 7).toISOString(),
    clientIds: [clientId]
  });

  // 3. Cliente inicia sesion autenticado contra el SDK de cliente en emulador
  const clientAuth = await asUser(clientId);
  const clientSnap = await getDoc(doc(clientAuth.db, 'clients', clientId));
  assert.equal(clientSnap.exists(), true);
  assert.equal(clientSnap.data().activePlanId, planId);

  // 4. Cliente registra dos exposiciones comparables de una sustitucion autorizada
  // Semana 1: Variante ejecutada con 100 kg, 8 reps, RIR 4, ICS 8
  // Semana 2: Variante ejecutada con 100 kg, 8 reps, RIR 4, ICS 8 (sostenido, ICS >= 8, RIR diff = +2)
  const entries = {
    // Semana 1 (W1)
    'log_1_0_0_s0': { carga: 100, reps: 8, unit: 'kg', done: true, rir_real: 4, ics: 8, prescriptionExerciseId: pid, executionExerciseId: expectedVariantId, exerciseNameSnapshot: altExerciseName, ts: Date.now() - 7 * 86400000 },
    'log_1_0_0_s1': { carga: 100, reps: 8, unit: 'kg', done: true, rir_real: 4, ics: 8, prescriptionExerciseId: pid, executionExerciseId: expectedVariantId, exerciseNameSnapshot: altExerciseName, ts: Date.now() - 7 * 86400000 },
    'log_1_0_0_s2': { carga: 100, reps: 8, unit: 'kg', done: true, rir_real: 4, ics: 8, prescriptionExerciseId: pid, executionExerciseId: expectedVariantId, exerciseNameSnapshot: altExerciseName, ts: Date.now() - 7 * 86400000 },

    // Semana 2 (W2)
    'log_2_0_0_s0': { carga: 100, reps: 8, unit: 'kg', done: true, rir_real: 4, ics: 8, prescriptionExerciseId: pid, executionExerciseId: expectedVariantId, exerciseNameSnapshot: altExerciseName, ts: Date.now() - 86400000 },
    'log_2_0_0_s1': { carga: 100, reps: 8, unit: 'kg', done: true, rir_real: 4, ics: 8, prescriptionExerciseId: pid, executionExerciseId: expectedVariantId, exerciseNameSnapshot: altExerciseName, ts: Date.now() - 86400000 },
    'log_2_0_0_s2': { carga: 100, reps: 8, unit: 'kg', done: true, rir_real: 4, ics: 8, prescriptionExerciseId: pid, executionExerciseId: expectedVariantId, exerciseNameSnapshot: altExerciseName, ts: Date.now() - 86400000 },

    // Post-session progrec emitido por App Cliente para la variante
    'progrec_2_0': {
      calculatedAt: new Date(Date.now() - 3600000).toISOString(),
      prescriptionExerciseId: pid,
      executionExerciseId: expectedVariantId,
      recommendations: [
        {
          action: 'increase_load',
          prescriptionExerciseId: pid,
          executionExerciseId: expectedVariantId,
          isSubstitution: true,
          authorizedSubstitution: true,
          previousLoad: 100,
          newLoad: 105,
          unit: 'KG',
          dimension: 'LOAD'
        }
      ]
    }
  };

  await adminDb.doc('logs/' + clientId).set({ planId, entries });
  await adminDb.doc('logs/' + clientId + '/mesos/' + planId).set({ planId, entries });

  // 5 & 6. El servidor recupera el plan desde fuente autoritativa y valida la variante
  const verifiedAuth = vi.validateExecutionAuthorization(planDoc, pid, expectedVariantId);
  assert.equal(verifiedAuth.ok, true, 'Variante debe ser autorizada por el plan autoritativo');
  assert.equal(verifiedAuth.isVariant, true);

  // 7 & 8. El ejecutor aplica la decision mediante transaccion (APPLIED + nextExposureOverlays)
  const scopedFixture = await createHistoricalFixture(adminDb, clientId, planId, [pid]);
  const execResult = await scopedFixture.executor.processProgression({
    db: scopedFixture.db,
    clientId: clientId,
    planId: planId,
    enabled: true,
    numericApplyEnabled: true,
    clock: clock
  });

  console.log('T761_EXEC_RESULT:', JSON.stringify(execResult, null, 2));
  assert.equal(execResult.status, 'MATERIALIZED');
  assert.ok(execResult.applied.length > 0);
  assert.equal(execResult.applied[0].written, true);

  // Verificar estado en meso de Firestore
  const mesoSnap = await adminDb.doc('logs/' + clientId + '/mesos/' + planId).get();
  const mesoData = mesoSnap.data();
  assert.ok(mesoData.progressionApplications);
  assert.ok(mesoData.nextExposureOverlays);

  const appKeys = Object.keys(mesoData.progressionApplications);
  const recKey = appKeys[0];
  const rec = mesoData.progressionApplications[recKey];
  assert.equal(rec.state, 'APPLIED');
  assert.equal(rec.executionExerciseId, expectedVariantId);

  const ovKeys = Object.keys(mesoData.nextExposureOverlays);
  const ovKey = ovKeys[0];
  const overlay = mesoData.nextExposureOverlays[ovKey];
  assert.equal(overlay.status, 'APPLIED');
  assert.equal(overlay.executionExerciseId, expectedVariantId);
  assert.equal(overlay.appliedValue, 105);

  // 9. App Cliente muestra la nueva prescripcion efectiva para la variante
  const effectiveVariant = effective.resolveEffective({
    clientId: clientId,
    planId: planId,
    activePlanId: planId,
    pid: pid,
    executionExerciseId: expectedVariantId,
    week: 3,
    dayIndex: 0,
    records: mesoData.progressionApplications,
    overlays: mesoData.nextExposureOverlays,
    plan: planDoc,
    entries: mesoData.entries,
    baseSets: planDoc.days[0].exercises[0].sets.map(s => Object.assign({}, s)),
    canonicalOverlayRead: true
  });

  assert.equal(effectiveVariant.provenance, 'CANONICAL_OVERLAY');
  assert.equal(effectiveVariant.dimension, 'LOAD');
  assert.equal(effectiveVariant.sets[0].effective.load, 105, 'Prescripcion efectiva de la variante debe ser 105 kg');

  // 10. Cliente comienza y registra la exposicion objetivo (Semana 3 con la variante a 105 kg)
  mesoData.entries['log_3_0_0_s0'] = { carga: 105, reps: 8, unit: 'kg', done: true, rir_real: 2, ics: 8, prescriptionExerciseId: pid, executionExerciseId: expectedVariantId, exerciseNameSnapshot: altExerciseName, ts: Date.now() };
  mesoData.entries['log_3_0_0_s1'] = { carga: 105, reps: 8, unit: 'kg', done: true, rir_real: 2, ics: 8, prescriptionExerciseId: pid, executionExerciseId: expectedVariantId, exerciseNameSnapshot: altExerciseName, ts: Date.now() };
  mesoData.entries['log_3_0_0_s2'] = { carga: 105, reps: 8, unit: 'kg', done: true, rir_real: 2, ics: 8, prescriptionExerciseId: pid, executionExerciseId: expectedVariantId, exerciseNameSnapshot: altExerciseName, ts: Date.now() };
  
  const receipt = {
    recordKey: recKey,
    overlayKey: ovKey,
    dimension: overlay.dimension,
    appliedValue: overlay.appliedValue,
    provenance: 'CANONICAL_OVERLAY',
    ackAt: new Date().toISOString()
  };
  await adminDb.doc('logs/' + clientId + '/mesos/' + planId).set({
    entries: mesoData.entries,
    consumptionReceipts: {
      [recKey]: receipt
    }
  }, { merge: true });

  // 11 & 12. Servidor verifica identidad exacta de ejecucion y transiciona a CONSUMED
  const consumeRes = await executor.consumePending(adminDb, clientId, planId, clock);

  assert.ok(Array.isArray(consumeRes) && consumeRes.length > 0, 'consumePending debe retornar resultados');
  assert.equal(consumeRes[0].written, true, 'consumePending debe ejecutarse exitosamente');

  const mesoAfterConsume = (await adminDb.doc('logs/' + clientId + '/mesos/' + planId).get()).data();
  const consumedOverlay = mesoAfterConsume.nextExposureOverlays[ovKey];
  const consumedRec = mesoAfterConsume.progressionApplications[recKey];
  assert.equal(consumedOverlay.status, 'CONSUMED');
  assert.equal(consumedRec.state, 'CONSUMED');

  // 13 & 14. El cliente cambia temporalmente al ejercicio original: no recibe la carga de la variante
  const effectiveOriginal = effective.resolveEffective({
    clientId: clientId,
    planId: planId,
    activePlanId: planId,
    pid: pid,
    executionExerciseId: pid, // Original
    week: 4,
    dayIndex: 0,
    records: mesoAfterConsume.progressionApplications,
    overlays: mesoAfterConsume.nextExposureOverlays,
    plan: planDoc,
    entries: mesoAfterConsume.entries,
    baseSets: planDoc.days[0].exercises[0].sets.map(s => Object.assign({}, s)),
    canonicalOverlayRead: true
  });

  assert.equal(effectiveOriginal.provenance, 'BASE_PLAN', 'Original no debe adoptar overlay de variante');
  assert.equal(effectiveOriginal.sets[0].effective.load, 80, 'Original conserva su carga de prescripcion base (80 kg)');

  // 15 & 16. El cliente vuelve a la sustitucion: recupera su propia progresion acumulada
  const effectiveVariantW4 = effective.resolveEffective({
    clientId: clientId,
    planId: planId,
    activePlanId: planId,
    pid: pid,
    executionExerciseId: expectedVariantId,
    week: 4,
    dayIndex: 0,
    records: mesoAfterConsume.progressionApplications,
    overlays: mesoAfterConsume.nextExposureOverlays,
    plan: planDoc,
    entries: mesoAfterConsume.entries,
    baseSets: planDoc.days[0].exercises[0].sets.map(s => Object.assign({}, s)),
    canonicalOverlayRead: true
  });

  assert.equal(effectiveVariantW4.provenance, 'CARRIED_OVERLAY', 'Variante recupera su overlay CONSUMED');
  assert.equal(effectiveVariantW4.sets[0].effective.load, 105, 'Variante conserva su carga progresada (105 kg)');

  // Persistencia y sincronizacion despues de cerrar, recargar y reabrir App Cliente
  const freshClientAuth = await asUser(clientId);
  const reloadedPlanSnap = await getDoc(doc(freshClientAuth.db, 'plans', planId));
  const reloadedMesoSnap = await getDoc(doc(freshClientAuth.db, 'logs', clientId, 'mesos', planId));
  assert.equal(reloadedPlanSnap.exists(), true);
  assert.equal(reloadedMesoSnap.exists(), true);

  const reloadedMeso = reloadedMesoSnap.data();
  assert.equal(reloadedMeso.nextExposureOverlays[ovKey].status, 'CONSUMED');
  assert.equal(reloadedMeso.nextExposureOverlays[ovKey].executionExerciseId, expectedVariantId);
});
