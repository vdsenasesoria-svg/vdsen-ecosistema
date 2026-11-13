'use strict';
/**
 * T788 — Recuperación de fichas y seguimiento periódico (App Coach + App Cliente + Firestore Rules)
 *
 * Verifica:
 * 1. Prioridad 0 (Error real en App Coach: "Error: Missing or insufficient permissions."):
 *    - firestore.rules en fichas_publicas permite lectura por coach propietario mediante igualdad directa
 *      resource.data.coachId == request.auth.uid (compatible con el query planner estático de Firestore)
 *      sin abrir permisos generales a otros coaches ni a usuarios no autorizados.
 *    - vdsen-coach.html normaliza fichas tanto en formato { data: {...} } como en formato plano legacy
 *      de enviarFicha/guardarFicha (_normalizeFichaDoc), distingue entre enviada, pendiente y recibida,
 *      y carga tanto fichas_publicas como fichas_onboarding de los propios clientes del coach.
 *    - vdsen-cliente.html guarda en guardarFicha() tanto campos planos legacy como el objeto canónico .data
 *      con status: 'enviada' y updatedBy: 'client'.
 * 2. Prioridad 1 (Seguimiento periódico del cliente — "Mi seguimiento"):
 *    - Sección "Mi seguimiento" (#miSeguimientoCard) independiente de la evaluación 360° inicial,
 *      con motivos (voluntary, block_end, coach_request, scheduled), métricas opcionales sin metas de peso
 *      ni juicios corporales, protección contra doble envío (_savingSeguimiento + draftId determinista),
 *      recuperación ante fallo de red conservando el borrador y limpieza completa en doLogout().
 * 3. Prioridad 2 y 3 (Recepción en App Coach, Solicitudes, Revisión e Integridad):
 *    - Pestaña "Seguimiento y actualizaciones" (ctab_seguimiento) en el expediente del cliente,
 *      solicitud de actualización por el Coach (requestClientSeguimiento -> clients/{id}/checkin_requests),
 *      marcado como revisada (markSeguimientoReviewed -> status: 'reviewed' sin alterar datos del cliente),
 *      indicador de pendientes en la lista de clientes (0 lecturas extra de Firestore) y reglas de seguridad
 *      estrictas en clients/{clientId}/checkins y clients/{clientId}/checkin_requests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const rulesSrc = fs.readFileSync(path.join(ROOT, 'firestore.t788.rules'), 'utf8');
const rulesDocSrc = fs.readFileSync(path.join(ROOT, 'docs', 'T788_FIRESTORE_RULES_PROPOSAL.md'), 'utf8');
const coachSrc = fs.readFileSync(path.join(ROOT, 'vdsen-coach.html'), 'utf8');
const clientSrc = fs.readFileSync(path.join(ROOT, 'vdsen-cliente.html'), 'utf8');

function extractFn(source, fnSignature) {
  const start = source.indexOf(fnSignature);
  assert.ok(start !== -1, `No se encontró ${fnSignature}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Función no cerrada: ${fnSignature}`);
}

test('T788.1 Prioridad 0: firestore.rules permite consulta tenant-scoped de fichas_publicas por coachId y protege checkins/checkin_requests', () => {
  // fichas_publicas debe usar igualdad directa resource.data.coachId == request.auth.uid para que where('coachId','==',uid) no falle con permission-denied
  const pubIdx = rulesSrc.indexOf('match /fichas_publicas/{docId}');
  assert.ok(pubIdx !== -1, 'match /fichas_publicas/{docId} debe existir en firestore.rules');
  const pubBlock = rulesSrc.slice(pubIdx, pubIdx + 700);
  assert.match(pubBlock, /allow read, update, delete:\s*if isCoachUser\(\)\s*&&\s*resource\.data\.coachId == request\.auth\.uid;/);
  assert.doesNotMatch(pubBlock, /allow read:\s*if true/);

  // Subcolecciones de seguimiento periódico bajo clients/{clientId}
  const chkIdx = rulesSrc.indexOf('match /checkins/{checkinId}');
  assert.ok(chkIdx !== -1, 'match /checkins/{checkinId} debe existir bajo clients/{clientId}');
  const chkBlock = rulesSrc.slice(chkIdx, chkIdx + 900);
  // Lectura solo para el propio cliente o su coach autorizado
  assert.match(chkBlock, /allow read:\s*if isSelfOrOwnerCoach\(clientId\);/);
  // Creación exclusiva del cliente propietario con status == 'sent' y submittedAt == request.time
  assert.match(chkBlock, /allow create:\s*if request\.auth != null && request\.auth\.uid == clientId/);
  assert.match(chkBlock, /request\.resource\.data\.clientId == clientId/);
  assert.match(chkBlock, /request\.resource\.data\.status == 'sent'/);
  // El Coach solo puede marcar como revisado (no alterar métricas declaradas por el cliente)
  assert.match(chkBlock, /ownsClient\(clientId\)/);
  assert.match(chkBlock, /affectedKeys\(\)\.hasOnly\(\['status', 'reviewedAt', 'reviewedByCoachId', 'coachNote'\]\)/);

  // Solicitudes de seguimiento bajo clients/{clientId}/checkin_requests/{requestId}
  const reqIdx = rulesSrc.indexOf('match /checkin_requests/{requestId}');
  assert.ok(reqIdx !== -1, 'match /checkin_requests/{requestId} debe existir bajo clients/{clientId}');
  const reqBlock = rulesSrc.slice(reqIdx, reqIdx + 950);
  assert.match(reqBlock, /allow read:\s*if isSelfOrOwnerCoach\(clientId\);/);
  assert.match(reqBlock, /allow create:\s*if ownsClient\(clientId\)/);
  assert.match(rulesDocSrc, /Ruta de despliegue independiente/);
});

test('T788.2 Prioridad 0: _normalizeFichaDoc normaliza fichas planas legacy (enviarFicha) y fichas con .data (v1.1), diferenciando estados', () => {
  const normFnCode = extractFn(coachSrc, 'function _normalizeFichaDoc(raw, clientDoc)');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(normFnCode, ctx);

  // Caso 1: Ficha plana enviada desde guardarFicha() legacy
  const flatRaw = {
    nombre: 'Carlos Mendoza',
    peso: 83.4,
    altura: 180,
    dias: '5',
    equipo: 'Gimnasio completo',
    objetivo: 'Volumen',
    experiencia: 'Intermedio',
    comidas: '4',
    alim_pref: 'Pollo, arroz, huevo',
    alergias: 'Ninguna',
    peds: 'No',
    notas: 'Enfoque en espalda',
    completedAt: 1700000000000
  };
  const normFlat = ctx._normalizeFichaDoc(flatRaw, { displayName: 'Carlos Mendoza', email: 'carlos@vdsen.test' });
  assert.equal(normFlat.hasContent, true);
  assert.equal(normFlat.status, 'enviada');
  assert.equal(normFlat.updatedBy, 'client');
  assert.equal(normFlat.data.peso_kg, 83.4);
  assert.equal(normFlat.data.talla_cm, 180);
  assert.equal(normFlat.data.dias_semana, '5');
  assert.equal(normFlat.data.gimnasio, 'Gimnasio completo');
  assert.equal(normFlat.data.objetivo_mesociclo, 'Volumen');
  assert.equal(normFlat.data.nivel, 'Intermedio');
  assert.equal(normFlat.data.perfil, 'Natural');

  // Caso 2: Ficha vacía (creada al dar de alta al cliente, aún pendiente)
  const emptyRaw = { data: {}, createdAt: 1700000000000 };
  const normEmpty = ctx._normalizeFichaDoc(emptyRaw, { displayName: 'Ana López', email: 'ana@vdsen.test' });
  assert.equal(normEmpty.hasContent, false);
  assert.equal(normEmpty.status, 'pendiente');

  // Caso 3: Ficha en formato canónico .data recibida/editada por coach
  const canonRaw = {
    schemaVersion: '1.1',
    updatedAt: 1700000500000,
    updatedBy: 'coach',
    data: { nombre: 'Ana López', peso_kg: 61, talla_cm: 164, dias_semana: 4 }
  };
  const normCanon = ctx._normalizeFichaDoc(canonRaw, null);
  assert.equal(normCanon.hasContent, true);
  assert.equal(normCanon.status, 'recibida');
  assert.equal(normCanon.data.peso_kg, 61);
});

test('T788.3 Prioridad 0 y 1: guardarFicha() y saveIntakeClient() en App Cliente persisten estructura compatible y estado enviada', () => {
  const guardarFichaBody = extractFn(clientSrc, 'async function guardarFicha()');
  assert.match(guardarFichaBody, /status:\s*'enviada'/);
  assert.match(guardarFichaBody, /updatedBy:\s*'client'/);
  assert.match(guardarFichaBody, /data:\s*canonData/);
  assert.match(guardarFichaBody, /peso_kg:\s*\+peso/);
  assert.match(guardarFichaBody, /talla_cm:\s*\+altura/);

  const saveIntakeBody = extractFn(clientSrc, 'async function saveIntakeClient()');
  assert.match(saveIntakeBody, /status:\s*'enviada'/);
  assert.match(saveIntakeBody, /updatedBy:\s*'client'/);
});

test('T788.4 Prioridad 1: App Cliente incluye sección Mi seguimiento independiente de la ficha 360°, con motivos, campos opcionales y protección de envío', () => {
  const buildSegBody = extractFn(clientSrc, 'function _buildMiSeguimientoSection()');
  assert.match(buildSegBody, /MI SEGUIMIENTO PERIÓDICO/);
  assert.match(buildSegBody, /independiente de tu evaluación 360° inicial/);
  // Motivos soportados
  assert.match(buildSegBody, /voluntary/);
  assert.match(buildSegBody, /block_end/);
  assert.match(buildSegBody, /coach_request/);
  assert.match(buildSegBody, /scheduled/);
  // Campos breves y opcionales
  assert.match(buildSegBody, /seg_pesoKg/);
  assert.match(buildSegBody, /seg_fechaMedicion/);
  assert.match(buildSegBody, /recuperacion/);
  assert.match(buildSegBody, /energiaRendimiento/);
  assert.match(buildSegBody, /sueno/);
  assert.match(buildSegBody, /seg_adherenciaEntreno/);
  assert.match(buildSegBody, /seg_adherenciaNutricion/);
  assert.match(buildSegBody, /seg_nutriNABtn/);
  assert.match(buildSegBody, /seg_fatigaMolestias/);
  assert.match(buildSegBody, /seg_comentarios/);

  // Guardado idempotente y resiliente ante fallos de red
  const saveSegBody = extractFn(clientSrc, 'async function saveSeguimientoClient()');
  assert.match(saveSegBody, /if \(_savingSeguimiento\) return false;/);
  assert.match(saveSegBody, /FB\.doc\(FB\.db, 'clients', uidAtStart, 'checkins', checkinId\)/);
  assert.match(saveSegBody, /status:\s*'sent'/);
  assert.match(saveSegBody, /_persistSeguimientoDraft\(\)/);

  // Limpieza en doLogout
  const logoutBody = extractFn(clientSrc, 'async function doLogout()');
  assert.match(logoutBody, /_seguimientoHistory = \[\];/);
  assert.match(logoutBody, /_seguimientoRequests = \[\];/);
  assert.match(logoutBody, /_seguimientoDraft = null;/);
});

test('T788.5 Prioridad 2 y 3: App Coach integra Seguimiento y actualizaciones en expediente, solicitudes por cliente y revisión inmutable', () => {
  const showDetailBody = extractFn(coachSrc, 'async function showClientDetail(clientId, opts)');
  assert.match(showDetailBody, /ctab_seguimiento/);
  assert.match(showDetailBody, /Seguimiento y actualizaciones/);
  assert.match(showDetailBody, /seguimientoPendingDot/);

  const switchTabBody = extractFn(coachSrc, 'async function _switchClientTab(tab)');
  assert.match(switchTabBody, /tab === 'seguimiento'/);
  assert.match(switchTabBody, /_renderClientTabSeguimiento\(cont\)/);

  const reqFnBody = extractFn(coachSrc, 'async function requestClientSeguimiento(clientId)');
  assert.match(reqFnBody, /doc\(db, 'clients', clientId, 'checkin_requests', reqId\)/);
  assert.match(reqFnBody, /status:\s*'pending'/);

  const revFnBody = extractFn(coachSrc, 'async function markSeguimientoReviewed(clientId, checkinId)');
  assert.match(revFnBody, /updateDoc\(doc\(db, 'clients', clientId, 'checkins', checkinId\)/);
  assert.match(revFnBody, /status:\s*'reviewed'/);
  assert.match(revFnBody, /reviewedByCoachId:\s*currentCoach\.uid/);
  // Nunca sobrescribe pesoKg ni métricas del cliente al marcar como revisada
  assert.doesNotMatch(revFnBody, /pesoKg/);
});
