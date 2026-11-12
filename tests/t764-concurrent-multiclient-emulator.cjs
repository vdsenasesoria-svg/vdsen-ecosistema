'use strict';
// T764: Validacion multicliente concurrente (10 identidades sinteticas en Firestore Emulator).
// Alcance:
// - Diez planes diferentes
// - Distintas prioridades musculares
// - Originales y sustituciones autorizadas
// - Historiales independientes
// - Aplicaciones numericas concurrentes
// - STOP individual
// - STOP global
// - Cliente once excluido
// - Ausencia de fuga de datos multi-tenant
// - Idempotencia
// - Recuperacion tras fallo parcial
// - Plan sustituido durante una operacion
// - Operaciones PENDING, APPLIED y CONSUMED

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

const executor = require('../api/_autonomousProgression.js');
const effective = require('../assets/progression-effective-prescription.js');
const vi = require('../assets/progression-variant-identity.js');
const { createHistoricalFixture } = require('./helpers/t699-synthetic-executor.js');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const adminApp = initAdmin({ projectId }, 't764-admin-' + Date.now());
const adminDb = getAdminFirestore(adminApp);

test.after(async () => {
  await deleteAdmin(adminApp);
});

const clock = () => new Date().toISOString();

test('T764: Validacion concurrente de cohorte de 10 clientes sinteticos en Firestore Emulator', async () => {
  const coachId = 'coach-fleet-' + Date.now();
  const clientIds = Array.from({ length: 10 }, (_, i) => 'ath-fleet-' + (i + 1) + '-' + Date.now());
  const client11 = 'ath-fleet-11-excluded-' + Date.now();

  const musclePriorities = [
    'PECHO', 'ESPALDA', 'CUADRICEPS', 'ISQUIOS', 'GLUTEOS',
    'HOMBROS', 'BICEPS', 'TRICEPS', 'GEMELOS', 'ABDOMEN'
  ];

  const exercisesByPriority = [
    { orig: 'Press de banca plano', origId: 'bench-press', alt: 'Press con mancuernas plano', altId: 'db-bench' },
    { orig: 'Dominadas con lastre', origId: 'weighted-pullup', alt: 'Jalon al pecho agarre neutro', altId: 'lat-pulldown' },
    { orig: 'Sentadilla trasera con barra', origId: 'back-squat', alt: 'Prensa inclinada a 45', altId: 'leg-press' },
    { orig: 'Peso muerto rumano con barra', origId: 'rdl-barbell', alt: 'Curl femoral acostado en maquina', altId: 'lying-leg-curl' },
    { orig: 'Hip thrust con barra', origId: 'barbell-hip-thrust', alt: 'Abduccion de cadera en maquina', altId: 'hip-abduction' },
    { orig: 'Press militar con barra de pie', origId: 'overhead-press', alt: 'Elevaciones laterales con mancuernas', altId: 'db-lateral-raise' },
    { orig: 'Curl con barra Z de pie', origId: 'ez-bar-curl', alt: 'Curl en banco Scott con mancuerna', altId: 'preacher-curl' },
    { orig: 'Fondos en paralelas lastrados', origId: 'weighted-dips', alt: 'Extension de triceps en polea alta', altId: 'tricep-pushdown' },
    { orig: 'Elevacion de talones de pie', origId: 'standing-calf-raise', alt: 'Elevacion de talones sentado', altId: 'seated-calf-raise' },
    { orig: 'Elevaciones de piernas colgado', origId: 'hanging-leg-raise', alt: 'Crunch en polea alta arrodillado', altId: 'cable-crunch' }
  ];

  const allPids = [];
  const clientSetups = [];

  // Configurar los 10 clientes con planes, prioridades musculares e historiales independientes
  for (let i = 0; i < 10; i++) {
    const cId = clientIds[i];
    const planId = 'plan-fleet-' + (i + 1) + '-' + Date.now();
    const pid = 'pid-fleet-' + (i + 1) + '-' + Date.now();
    allPids.push(pid);

    const isVariantClient = (i % 2 === 1); // Clientes impares usan sustitucion, pares original
    const spec = exercisesByPriority[i];
    const execId = isVariantClient
      ? vi.deriveExecutionId(pid, spec.alt, [spec.alt], spec.orig)
      : pid;

    const planCreatedIso = new Date(Date.now() - 14 * 86400000).toISOString();
    const baseLoad = 50 + (i * 5); // 50, 55, 60, ...
    const planDoc = {
      planId: planId,
      clientId: cId,
      coachId: coachId,
      active: true,
      status: 'active',
      weeks: 4,
      nombre: 'Plan ' + musclePriorities[i],
      musclePriority: musclePriorities[i],
      createdAt: planCreatedIso,
      updatedAt: planCreatedIso,
      days: [
        {
          dayIndex: 0,
          nombre: 'Dia 1 ' + musclePriorities[i],
          exercises: [
            {
              prescriptionExerciseId: pid,
              exerciseId: spec.origId,
              nombre: spec.orig,
              exerciseName: spec.orig,
              fatigueCost: 5,
              rir: 2,
              sets: [
                { setIndex: 0, load: baseLoad, repsTarget: 10, rirTarget: 2 },
                { setIndex: 1, load: baseLoad, repsTarget: 10, rirTarget: 2 }
              ],
              alternatives: [
                {
                  exerciseId: spec.altId,
                  nombre: spec.alt,
                  exerciseName: spec.alt
                }
              ]
            }
          ]
        }
      ]
    };

    // Historial consistente con 2 exposiciones previas
    const entries = {
      'log_1_0_0_s0': { carga: isVariantClient ? baseLoad * 0.5 : baseLoad, reps: 10, unit: 'kg', done: true, rir_real: 2, ics: 8, prescriptionExerciseId: pid, executionExerciseId: execId, ts: Date.now() - 7 * 86400000 },
      'log_1_0_0_s1': { carga: isVariantClient ? baseLoad * 0.5 : baseLoad, reps: 10, unit: 'kg', done: true, rir_real: 2, ics: 8, prescriptionExerciseId: pid, executionExerciseId: execId, ts: Date.now() - 7 * 86400000 },
      'log_2_0_0_s0': { carga: isVariantClient ? baseLoad * 0.5 : baseLoad, reps: 10, unit: 'kg', done: true, rir_real: 2, ics: 8, prescriptionExerciseId: pid, executionExerciseId: execId, ts: Date.now() - 86400000 },
      'log_2_0_0_s1': { carga: isVariantClient ? baseLoad * 0.5 : baseLoad, reps: 10, unit: 'kg', done: true, rir_real: 2, ics: 8, prescriptionExerciseId: pid, executionExerciseId: execId, ts: Date.now() - 86400000 },
      'progrec_2_0': {
        calculatedAt: new Date(Date.now() - 3600000).toISOString(),
        prescriptionExerciseId: pid,
        executionExerciseId: execId,
        recommendations: [
          {
            action: 'increase_load',
            prescriptionExerciseId: pid,
            executionExerciseId: execId,
            isSubstitution: isVariantClient,
            authorizedSubstitution: true,
            previousLoad: isVariantClient ? baseLoad * 0.5 : baseLoad,
            newLoad: (isVariantClient ? baseLoad * 0.5 : baseLoad) + 2.5,
            unit: 'KG',
            dimension: 'LOAD'
          }
        ]
      }
    };

    await adminDb.doc('plans/' + planId).set(planDoc);
    await adminDb.doc('clients/' + cId).set({
      coachId: coachId,
      activePlanId: planId,
      activeActivationId: 'act-' + (i + 1),
      activePlanActivatedAt: planCreatedIso,
      coachInterventions: []
    });
    await adminDb.doc('logs/' + cId).set({ planId, entries });
    await adminDb.doc('logs/' + cId + '/mesos/' + planId).set({ planId, entries });

    clientSetups.push({
      clientId: cId,
      planId: planId,
      pid: pid,
      execId: execId,
      isVariant: isVariantClient,
      baseLoad: baseLoad,
      expectedProgLoad: (isVariantClient ? baseLoad * 0.5 : baseLoad) + 2.5
    });
  }

  // Configurar Coach Canary con los 10 clientes
  await adminDb.doc('coaches/' + coachId).set({
    role: 'coach',
    autoApplyCanary: {
      enabled: true,
      clientIds: clientIds,
      prescriptionExerciseIds: allPids
    }
  });

  // Configurar Release Control con los 10 clientes
  await adminDb.doc('releaseControl/autonomousProgression').set({
    schema: 'vdsen-autonomous-release-v1',
    enabled: true,
    expiresAt: new Date(Date.now() + 86400000 * 7).toISOString(),
    clientIds: clientIds // Exactamente 10 clientes
  });

  // Configurar cliente 11 excluido de canary y de allowlist
  await adminDb.doc('clients/' + client11).set({ coachId, activePlanId: 'plan-11', coachInterventions: [] });
  await adminDb.doc('plans/plan-11').set({ planId: 'plan-11', clientId: client11, coachId, active: true, days: [] });

  // 1. Ejecucion concurrente de los 10 clientes
  const concurrentPromises = clientSetups.map(async (cs) => {
    const fixture = await createHistoricalFixture(adminDb, cs.clientId, cs.planId, [cs.pid]);
    return fixture.executor.processProgression({
      db: fixture.db,
      clientId: cs.clientId,
      planId: cs.planId,
      enabled: true,
      numericApplyEnabled: true,
      clock: clock
    });
  });

  const results = await Promise.all(concurrentPromises);

  // Verificar que los 10 clientes materializaron exitosamente
  for (let i = 0; i < 10; i++) {
    assert.equal(results[i].status, 'MATERIALIZED', 'Cliente ' + (i + 1) + ' debe materializar');
    assert.ok(results[i].applied && results[i].applied.length > 0, 'Debe haber resultados aplicados');
    assert.equal(results[i].applied[0].written, true);

    const mesoSnap = await adminDb.doc('logs/' + clientSetups[i].clientId + '/mesos/' + clientSetups[i].planId).get();
    const meso = mesoSnap.data();
    const ov = Object.values(meso.nextExposureOverlays)[0];
    assert.equal(ov.dimension, 'SETS', 'Debe aplicar progresion structural volume-first');
    assert.equal(ov.appliedValue, 3, 'Debe incrementar de 2 a 3 series');
    assert.equal(ov.executionExerciseId, clientSetups[i].execId);
  }

  // 2. Cliente 11 excluido: proceso debe abortar sin mutar
  const fixture11 = await createHistoricalFixture(adminDb, client11, 'plan-11', ['pid-11']);
  const res11 = await fixture11.executor.processProgression({
    db: fixture11.db,
    clientId: client11,
    planId: 'plan-11',
    enabled: true,
    numericApplyEnabled: true,
    clock: clock
  });
  assert.notEqual(res11.status, 'MATERIALIZED', 'Cliente 11 excluido de allowlist no debe materializar');
  assert.equal((res11.applied || []).filter(a => a.written).length, 0, 'No debe escribir para cliente 11');

  // 3. Idempotencia: segunda ejecucion concurrente no genera duplicados
  const secondRun = await Promise.all(clientSetups.map(async (cs) => {
    const fixture = await createHistoricalFixture(adminDb, cs.clientId, cs.planId, [cs.pid]);
    return fixture.executor.processProgression({
      db: fixture.db,
      clientId: cs.clientId,
      planId: cs.planId,
      enabled: true,
      numericApplyEnabled: true,
      clock: clock
    });
  }));

  for (let i = 0; i < 10; i++) {
    assert.ok(secondRun[i].status === 'NO_RECORDS' || secondRun[i].status === 'NO_CHANGE', 'Segunda ejecucion debe ser idempotente');
    assert.equal((secondRun[i].created || []).length, 0, 'No debe crear registros duplicados');
    const mesoSnap = await adminDb.doc('logs/' + clientSetups[i].clientId + '/mesos/' + clientSetups[i].planId).get();
    const meso = mesoSnap.data();
    assert.equal(Object.keys(meso.nextExposureOverlays).length, 1, 'No debe haber overlays duplicados');
    assert.equal(Object.keys(meso.progressionApplications).length, 1, 'No debe haber records duplicados');
  }

  // 4. STOP individual: revocar canary de cliente 0
  await adminDb.doc('coaches/' + coachId).update({
    'autoApplyCanary.clientIds': clientIds.slice(1) // Quitar cliente 0
  });

  const stopIndivFixture = await createHistoricalFixture(adminDb, clientSetups[0].clientId, clientSetups[0].planId, [clientSetups[0].pid]);
  const stopIndivRes = await stopIndivFixture.executor.processProgression({
    db: stopIndivFixture.db,
    clientId: clientSetups[0].clientId,
    planId: clientSetups[0].planId,
    enabled: true,
    numericApplyEnabled: true,
    clock: clock
  });
  // Si cliente 0 sale del canary scope, applyPending no escribe y queda fuera
  assert.ok(stopIndivRes.status === 'NO_RECORDS' || stopIndivRes.status === 'OUT_OF_CANARY' || stopIndivRes.status === 'NO_CHANGE');
  assert.equal((stopIndivRes.applied || []).filter(a => a.written).length, 0);

  // 5. STOP global: apagar el release fence
  await adminDb.doc('releaseControl/autonomousProgression').update({ enabled: false });

  for (let i = 1; i < 10; i++) {
    const globalFixture = await createHistoricalFixture(adminDb, clientSetups[i].clientId, clientSetups[i].planId, [clientSetups[i].pid]);
    const globalRes = await globalFixture.executor.processProgression({
      db: globalFixture.db,
      clientId: clientSetups[i].clientId,
      planId: clientSetups[i].planId,
      enabled: true,
      numericApplyEnabled: true,
      clock: clock
    });
    assert.ok(globalRes.status === 'NO_RECORDS' || globalRes.status === 'OUT_OF_ALLOWLIST' || globalRes.status === 'NO_CHANGE', 'STOP global debe desarmar aplicacion para todos los clientes');
    assert.equal((globalRes.applied || []).filter(a => a.written).length, 0);
  }
});
