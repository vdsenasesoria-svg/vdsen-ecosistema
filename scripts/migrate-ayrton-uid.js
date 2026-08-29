'use strict';
/**
 * migrate-ayrton-uid.js
 *
 * Migración puntual: mueve el doc de Ayrton en clients/ y logs/
 * del UID antiguo (doc ID creado por el coach) al UID real de Firebase Auth.
 *
 * USO:
 *   1. Descarga tu service account key desde Firebase Console:
 *      https://console.firebase.google.com/project/vdsen-ecosistema/settings/serviceaccounts/adminsdk
 *      → Generar nueva clave privada → guarda el JSON como serviceAccountKey.json
 *      en esta misma carpeta (scripts/).
 *
 *   2. Instala la dependencia:
 *      npm install firebase-admin --no-save
 *
 *   3. Ejecuta:
 *      node scripts/migrate-ayrton-uid.js
 *
 * El script es NO-DESTRUCTIVO hasta que confirmas.
 * Lee → muestra los datos → pregunta confirmación → escribe → verifica → borra el viejo.
 */

const admin  = require('firebase-admin');
const path   = require('path');
const readline = require('readline');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'serviceAccountKey.json');
const PROJECT_ID = 'vdsen-ecosistema';

// ── UIDs ────────────────────────────────────────────────────────────────────
const OLD_UID = 'bXtyOkXlpjfUWBF5dd6xYf6OEny2';   // doc ID en clients/ → plan guardado aquí
const NEW_UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';    // Auth UID real de ayrtonvd@gmail.com
// ────────────────────────────────────────────────────────────────────────────

async function confirm(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim().toLowerCase()); }));
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' VDSEN — Migración de UID de cliente (Ayrton)');
  console.log('═══════════════════════════════════════════════════');
  console.log(' OLD:', OLD_UID);
  console.log(' NEW:', NEW_UID);
  console.log('');

  // Init Admin SDK
  let serviceAccount;
  try {
    serviceAccount = require(SERVICE_ACCOUNT_PATH);
  } catch (e) {
    console.error('❌ No se encontró serviceAccountKey.json en scripts/');
    console.error('   Descárgalo desde Firebase Console (ver instrucciones al inicio del script).');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: PROJECT_ID
  });
  const db = admin.firestore();

  // ── 1. Verificar que OLD existe ──────────────────────────────────────────
  console.log('▸ Leyendo clients/' + OLD_UID + '...');
  const oldSnap = await db.collection('clients').doc(OLD_UID).get();
  if (!oldSnap.exists) {
    console.error('❌ El documento clients/' + OLD_UID + ' no existe. Nada que migrar.');
    process.exit(1);
  }
  const oldData = oldSnap.data();
  console.log('  ✓ Encontrado. email=' + oldData.email + ' activePlanId=' + oldData.activePlanId);

  // ── 2. Verificar que NEW no existe ya (o que no tiene activePlanId) ──────
  console.log('▸ Revisando clients/' + NEW_UID + '...');
  const newSnap = await db.collection('clients').doc(NEW_UID).get();
  if (newSnap.exists) {
    const newData = newSnap.data();
    console.log('  ⚠  El documento destino YA existe:');
    console.log('     email=' + newData.email + ' activePlanId=' + (newData.activePlanId || 'null'));
    if (newData.activePlanId) {
      console.error('❌ El destino ya tiene activePlanId. Aborta para no perder datos.');
      process.exit(1);
    }
    console.log('  → El doc existe pero sin plan. Se sobreescribirá con los datos del doc viejo.');
  } else {
    console.log('  ✓ No existe aún. Se creará.');
  }

  // ── 3. Buscar plan con clientId == OLD_UID ───────────────────────────────
  console.log('▸ Buscando planes con clientId=' + OLD_UID + '...');
  const plansSnap = await db.collection('plans').where('clientId', '==', OLD_UID).get();
  console.log('  → ' + plansSnap.size + ' plan(es) encontrado(s).');
  plansSnap.docs.forEach(d => console.log('    - plans/' + d.id + ' (activePlanId del cliente: ' + oldData.activePlanId + ')'));

  // ── 4. Buscar logs del UID viejo ─────────────────────────────────────────
  console.log('▸ Revisando logs/' + OLD_UID + '...');
  const oldLogSnap = await db.collection('logs').doc(OLD_UID).get();
  const hasOldLog = oldLogSnap.exists;
  console.log('  → ' + (hasOldLog ? 'Encontrado (' + Object.keys(oldLogSnap.data().entries || {}).length + ' entries)' : 'No existe'));

  // ── 5. Confirmación ──────────────────────────────────────────────────────
  console.log('');
  console.log('══ PLAN DE MIGRACIÓN ══════════════════════════════');
  console.log('  [1] Crear  clients/' + NEW_UID + ' ← datos de ' + OLD_UID);
  if (plansSnap.size > 0) {
    console.log('  [2] Actualizar clientId en ' + plansSnap.size + ' plan(es)');
  }
  if (hasOldLog) {
    console.log('  [3] Crear  logs/' + NEW_UID + ' ← datos de logs/' + OLD_UID);
    console.log('  [4] Borrar logs/' + OLD_UID);
  }
  console.log('  [5] Borrar clients/' + OLD_UID);
  console.log('═══════════════════════════════════════════════════');

  const ans = await confirm('\n¿Ejecutar migración? (escribe "si" para confirmar): ');
  if (ans !== 'si') {
    console.log('Cancelado. No se modificó nada.');
    process.exit(0);
  }

  // ── 6. Ejecutar migración en batch ───────────────────────────────────────
  console.log('');
  console.log('▸ Ejecutando...');

  const batch = db.batch();

  // [1] clients/ nuevo doc
  batch.set(db.collection('clients').doc(NEW_UID), oldData);
  console.log('  ✓ clients/' + NEW_UID + ' preparado');

  // [2] Planes: actualizar clientId
  plansSnap.docs.forEach(d => {
    batch.update(db.collection('plans').doc(d.id), { clientId: NEW_UID });
    console.log('  ✓ plans/' + d.id + ' clientId → ' + NEW_UID);
  });

  // [3] Logs nuevo doc
  if (hasOldLog) {
    batch.set(db.collection('logs').doc(NEW_UID), oldLogSnap.data());
    console.log('  ✓ logs/' + NEW_UID + ' preparado');
    batch.delete(db.collection('logs').doc(OLD_UID));
    console.log('  ✓ logs/' + OLD_UID + ' marcado para borrar');
  }

  // [5] Borrar doc viejo de clients/
  batch.delete(db.collection('clients').doc(OLD_UID));
  console.log('  ✓ clients/' + OLD_UID + ' marcado para borrar');

  await batch.commit();
  console.log('');
  console.log('▸ Batch commit OK.');

  // ── 7. Verificación post-migración ───────────────────────────────────────
  console.log('▸ Verificando resultado...');
  const verifySnap = await db.collection('clients').doc(NEW_UID).get();
  const verifyOld  = await db.collection('clients').doc(OLD_UID).get();

  if (!verifySnap.exists) {
    console.error('❌ El doc nuevo NO existe tras el commit. Algo falló.');
    process.exit(1);
  }
  const vData = verifySnap.data();
  console.log('  ✓ clients/' + NEW_UID + ' existe. email=' + vData.email + ' activePlanId=' + vData.activePlanId);

  if (verifyOld.exists) {
    console.warn('  ⚠  clients/' + OLD_UID + ' todavía existe. Intenta borrarlo manualmente desde Firestore Console.');
  } else {
    console.log('  ✓ clients/' + OLD_UID + ' eliminado correctamente.');
  }

  if (hasOldLog) {
    const verifyLogNew = await db.collection('logs').doc(NEW_UID).get();
    const verifyLogOld = await db.collection('logs').doc(OLD_UID).get();
    if (verifyLogNew.exists) console.log('  ✓ logs/' + NEW_UID + ' existe.');
    if (!verifyLogOld.exists) console.log('  ✓ logs/' + OLD_UID + ' eliminado.');
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log(' ✅ Migración completada. Ayrton puede refrescar la app cliente.');
  console.log('═══════════════════════════════════════════════════\n');

  process.exit(0);
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
