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

  // Contrato separado de revisión del Coach bajo clients/{clientId}/checkin_reviews/{reviewId}
  const revIdx = rulesSrc.indexOf('match /checkin_reviews/{reviewId}');
  assert.ok(revIdx !== -1, 'match /checkin_reviews/{reviewId} debe existir bajo clients/{clientId}');
  const revBlock = rulesSrc.slice(revIdx, revIdx + 850);
  assert.match(revBlock, /allow read:\s*if isSelfOrOwnerCoach\(clientId\);/);
  assert.match(revBlock, /allow create:\s*if ownsClient\(clientId\)/);
  assert.doesNotMatch(revBlock, /allow update:/);
  assert.match(revBlock, /reviewId == 'rev_' \+ request\.resource\.data\.checkinId/);
  assert.match(revBlock, /exists\(\/databases\/\$\(database\)\/documents\/clients\/\$\(clientId\)\/checkins\/\$\(request\.resource\.data\.checkinId\)\)/);
  assert.match(revBlock, /request\.resource\.data\.status == 'reviewed'/);
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
  // Campos breves y opcionales (incluyendo escalas 1-5 completas: energia, recuperacion, sueno, fatiga, rendimiento)
  assert.match(buildSegBody, /seg_pesoKg/);
  assert.match(buildSegBody, /seg_fechaMedicion/);
  assert.match(buildSegBody, /energia/);
  assert.match(buildSegBody, /recuperacion/);
  assert.match(buildSegBody, /sueno/);
  assert.match(buildSegBody, /fatiga/);
  assert.match(buildSegBody, /rendimiento/);
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

test('T788.4b FE151: Cliente recibe solicitud e historial desde logs y descarta lectura de otra cuenta', async () => {
  const loadBody = extractFn(clientSrc, 'async function loadClientSeguimiento()');
  const ctx = {
    window: {}, console, USER: { uid: 'cliente-a' },
    _seguimientoHistory: [], _seguimientoRequests: [], _seguimientoDraft: null,
    _segCliToMs: v => Number(v) || 0,
    localStorage: { getItem: () => '1' },
    FB: {
      db: {}, collection: (...parts) => parts, doc: (...parts) => parts,
      getDocs: async () => { throw Object.assign(new Error('FE151'), { code: 'permission-denied' }); },
      getDoc: async () => ({ exists: () => true, data: () => ({
        seguimientoItems: [{ id: 'chk-a', clientId: 'cliente-a', createdAtMs: 1 }],
        seguimientoRequests: [{ id: 'req-a', clientId: 'cliente-a', status: 'pending', createdAtMs: 2 }]
      }) })
    }
  };
  vm.createContext(ctx);
  vm.runInContext(loadBody, ctx);
  await ctx.loadClientSeguimiento();
  assert.equal(ctx._seguimientoHistory.length, 1);
  assert.equal(ctx._seguimientoHistory[0].id, 'chk-a');
  assert.equal(ctx._seguimientoRequests[0].id, 'req-a');

  ctx._seguimientoHistory = [];
  ctx._seguimientoRequests = [];
  ctx.FB.getDoc = async () => { ctx.USER = { uid: 'cliente-b' }; return { exists: () => true, data: () => ({ seguimientoRequests: [{ id: 'req-a' }] }) }; };
  await ctx.loadClientSeguimiento();
  assert.equal(ctx._seguimientoRequests.length, 0);
});

test('T788.5 Prioridad 0, 2 y 3: App Coach distingue permission-denied de ficha inexistente, integra Seguimiento y persiste 4 contratos separados', () => {
  const showDetailBody = extractFn(coachSrc, 'async function showClientDetail(clientId, opts)');
  assert.match(showDetailBody, /ctab_seguimiento/);
  assert.match(showDetailBody, /Seguimiento y actualizaciones/);
  assert.match(showDetailBody, /seguimientoPendingDot/);
  assert.match(showDetailBody, /_detailFichaError\s*=\s*\{/);

  const renderFichaBody = extractFn(coachSrc, 'function _renderClientTabFicha(cont)');
  assert.match(renderFichaBody, /Error al consultar la ficha/);
  assert.match(renderFichaBody, /no se interpreta como ficha inexistente/);
  assert.match(renderFichaBody, /_retryDetailFichaLoad/);
  assert.match(renderFichaBody, /const fichaReadErr = _detailFichaError;/);
  assert.match(showDetailBody, /catch\(_fErr\)\s*\{\s*_detailFichaError\s*=/);

  const loadIntakeBody = extractFn(coachSrc, 'async function loadIntakeForClient(clientId)');
  assert.match(loadIntakeBody, /ensureCoachDoc\(\)/);
  assert.match(loadIntakeBody, /no se interpreta como ficha inexistente/);

  const switchTabBody = extractFn(coachSrc, 'async function _switchClientTab(tab)');
  assert.match(switchTabBody, /tab === 'seguimiento'/);
  assert.match(switchTabBody, /_renderClientTabSeguimiento\(cont\)/);

  const reqFnBody = extractFn(coachSrc, 'async function requestClientSeguimiento(clientId)');
  assert.match(reqFnBody, /doc\(db, 'clients', clientId, 'checkin_requests', reqId\)/);
  assert.match(reqFnBody, /status:\s*'pending'/);
  assert.match(reqFnBody, /_detailSeguimientoRequests \|\| \[\]\)\.some\(r => r && r\.status === 'pending'/);

  const revFnBody = extractFn(coachSrc, 'async function markSeguimientoReviewed(clientId, checkinId)');
  assert.match(revFnBody, /setDoc\(doc\(db, 'clients', clientId, 'checkin_reviews', reviewId\)/);
  assert.match(revFnBody, /updateDoc\(doc\(db, 'clients', clientId, 'checkins', checkinId\)/);
  assert.match(revFnBody, /status:\s*'reviewed'/);
  assert.match(revFnBody, /reviewedByCoachId:\s*currentCoach\.uid/);
  // Nunca sobrescribe pesoKg ni métricas del cliente al marcar como revisada
  assert.doesNotMatch(revFnBody, /pesoKg/);
});

test('T792/T795: una solicitud del Coach conserva historial ya cumplido y asigna _detailSeguimientoRequests desde nextReqs', async () => {
  const body = extractFn(coachSrc, 'async function requestClientSeguimiento(clientId)');
  const logs = { seguimientoRequests: [{ id: 'req_other', status: 'sent' }] };
  const ctx = {
    currentCoach: { uid: 'coach_A' },
    _detailClientData: { coachId: 'coach_A', activePlanId: 'plan_A' },
    _detailPlanData: null, _detailSeguimientoRequests: [], _detailSeguimientoData: [],
    _detailLogsData: { clientId: 'client_A', data: {} },
    _detailClientId: null, _detailActiveTab: '', _segReqInFlight: false,
    document: { getElementById: () => null },
    Date: class extends Date { static now() { return 1000; } },
    db: {}, serverTimestamp: () => 'server-time',
    doc: (_db, ...parts) => parts.join('/'),
    setDoc: async () => {},
    runTransaction: async (_db, fn) => fn({
      get: async ref => {
        if (String(ref).startsWith('clients/')) return { exists: () => false, data: () => ({}) };
        return { exists: () => true, data: () => ({ ...logs }) };
      },
      set: (ref, data) => { if (String(ref).startsWith('logs/')) Object.assign(logs, data); }
    }),
    showToast: () => {}, loadClientList: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  await ctx.requestClientSeguimiento('client_A');
  assert.equal(logs.seguimientoRequests.length, 2);
  assert.ok(logs.seguimientoRequests.some(x => x.id === 'req_other'));
  assert.equal(ctx._detailSeguimientoRequests.length, 2, 'nextReqs se devuelve de la transacción y actualiza _detailSeguimientoRequests');
  await ctx.requestClientSeguimiento('client_A');
  assert.equal(logs.seguimientoRequests.length, 2, 'un reintento conserva el invariante de única solicitud pendiente');
});

test('T795 Prioridad 3: dos pestañas concurrentes del Coach no crean solicitudes pendientes duplicadas', async () => {
  const body = extractFn(coachSrc, 'async function requestClientSeguimiento(clientId)');
  const logs = { seguimientoRequests: [{ id: 'req_tab1', status: 'pending' }] };
  const notices = [];
  const ctx = {
    currentCoach: { uid: 'coach_A' },
    _detailClientData: { coachId: 'coach_A', activePlanId: 'plan_A' },
    _detailPlanData: null, _detailSeguimientoRequests: [], _detailSeguimientoData: [],
    _detailLogsData: { clientId: 'client_A', data: {} },
    _detailClientId: null, _detailActiveTab: '', _segReqInFlight: false,
    document: { getElementById: () => null },
    Date: class extends Date { static now() { return 2000; } },
    db: {}, serverTimestamp: () => 'server-time',
    doc: (_db, ...parts) => parts.join('/'),
    runTransaction: async (_db, fn) => fn({
      get: async ref => {
        if (String(ref).startsWith('clients/')) throw new Error('FE151');
        return { exists: () => true, data: () => ({ ...logs }) };
      },
      set: (ref, data) => { if (String(ref).startsWith('logs/')) Object.assign(logs, data); }
    }),
    showToast: (message, error) => notices.push({ message, error }), loadClientList: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  await ctx.requestClientSeguimiento('client_A');
  assert.equal(logs.seguimientoRequests.length, 1);
  assert.equal(logs.seguimientoRequests[0].id, 'req_tab1');
  assert.equal(ctx._detailSeguimientoRequests.length, 1);
  assert.ok(notices.some(n => n.error === true && /pendiente/i.test(n.message)));
});

test('T792: un fallo del espejo y de la subcolección no confirma la solicitud', async () => {
  const body = extractFn(coachSrc, 'async function requestClientSeguimiento(clientId)');
  const notices = [];
  const ctx = {
    currentCoach: { uid: 'coach_A' }, _detailClientData: { coachId: 'coach_A' },
    _detailPlanData: null, _detailSeguimientoRequests: [], _detailSeguimientoData: [], _detailClientId: null, _detailActiveTab: '', _segReqInFlight: false,
    document: { getElementById: () => null }, db: {},
    doc: (_db, ...parts) => parts.join('/'), serverTimestamp: () => 'server-time',
    setDoc: async () => { throw new Error('FE151'); },
    runTransaction: async () => { throw new Error('offline'); },
    showToast: (message, error) => notices.push({ message, error }), loadClientList: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  await ctx.requestClientSeguimiento('client_A');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].error, true);
  assert.doesNotMatch(notices[0].message, /Solicitud de seguimiento enviada/);
});

test('T792: el Cliente conserva historial concurrente en FE151 y solo confirma tras guardar', async () => {
  const body = extractFn(clientSrc, 'async function saveSeguimientoClient()');
  const logs = { seguimientoItems: [{ id: 'chk_existing', status: 'sent' }], seguimientoRequests: [] };
  const notices = [];
  const ctx = {
    _savingSeguimiento: false, _seguimientoHistory: [], _seguimientoRequests: [],
    _seguimientoDraft: { draftId: 'chk_new', comentarios: 'Actualización' }, _seguimientoDraftId: 'chk_new',
    _initSeguimientoDraft: () => ctx._seguimientoDraft, _persistSeguimientoDraft: () => {},
    USER: { uid: 'client_A' }, PLAN: null, ACTIVE_PLAN_ID: null, CURRENT_WEEK: 1,
    document: { getElementById: () => null },
    FB: {
      db: {}, doc: (_db, ...parts) => parts.join('/'), serverTimestamp: () => 'server-time',
      setDoc: async () => { throw new Error('FE151'); }, updateDoc: async () => {},
      runTransaction: async (_db, fn) => fn({
        get: async ref => {
          if (String(ref).startsWith('clients/')) throw new Error('FE151');
          return { exists: () => true, data: () => ({ ...logs }) };
        },
        set: (ref, data) => { if (String(ref).startsWith('logs/')) Object.assign(logs, data); },
        update: () => {}
      })
    },
    showToast: (message, error) => notices.push({ message, error }),
    renderCheckin: () => {}, renderResumen: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  assert.equal(await ctx.saveSeguimientoClient(), true);
  assert.deepEqual(Array.from(logs.seguimientoItems, x => x.id).sort(), ['chk_existing', 'chk_new']);
  assert.ok(notices.some(x => /Seguimiento enviado/.test(x.message) && !x.error));
});

test('T795 Prioridad 0: cambio de cuenta Cliente A -> Cliente B durante saveSeguimientoClient no contamina la sesión B', async () => {
  const body = extractFn(clientSrc, 'async function saveSeguimientoClient()');
  const logsA = { seguimientoItems: [], seguimientoRequests: [] };
  const notices = [];
  let renderCalls = 0;
  let persistCalls = 0;
  const ctx = {
    _authSessionGen: 1,
    _savingSeguimiento: false,
    _seguimientoHistory: [{ id: 'chk_A_old', clientId: 'client_A' }],
    _seguimientoRequests: [],
    _seguimientoDraft: { draftId: 'chk_A_new', comentarios: 'Dato privado de A' },
    _seguimientoDraftId: 'chk_A_new',
    _initSeguimientoDraft: () => ctx._seguimientoDraft,
    _persistSeguimientoDraft: () => { persistCalls++; },
    USER: { uid: 'client_A' }, PLAN: null, ACTIVE_PLAN_ID: null, CURRENT_WEEK: 1,
    document: { getElementById: () => null },
    FB: {
      db: {}, doc: (_db, ...parts) => parts.join('/'), serverTimestamp: () => 'server-time',
      runTransaction: async (_db, fn) => {
        const res = await fn({
          get: async ref => {
            if (String(ref).startsWith('clients/')) throw new Error('FE151');
            return { exists: () => true, data: () => ({ ...logsA }) };
          },
          set: (ref, data) => { if (String(ref).startsWith('logs/')) Object.assign(logsA, data); },
          update: () => {}
        });
        // Simular logout de A e inicio de sesión de B mientras la transacción de logs/{client_A} resolvía
        ctx.USER = { uid: 'client_B' };
        ctx._authSessionGen = 2;
        ctx._seguimientoHistory = [{ id: 'chk_B_only', clientId: 'client_B' }];
        ctx._seguimientoRequests = [{ id: 'req_B_only', clientId: 'client_B', status: 'pending' }];
        ctx._seguimientoDraft = { draftId: 'chk_B_draft', comentarios: 'Borrador de B' };
        ctx._seguimientoDraftId = 'chk_B_draft';
        return res;
      }
    },
    showToast: (message, error) => notices.push({ message, error }),
    renderCheckin: () => { renderCalls++; }, renderResumen: () => { renderCalls++; }
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  const ok = await ctx.saveSeguimientoClient();
  assert.equal(ok, false);
  assert.deepEqual(ctx._seguimientoHistory.map(x => x.id), ['chk_B_only']);
  assert.deepEqual(ctx._seguimientoRequests.map(x => x.id), ['req_B_only']);
  assert.equal(ctx._seguimientoDraft.draftId, 'chk_B_draft');
  assert.equal(notices.length, 0);
  assert.equal(renderCalls, 0);
  assert.equal(persistCalls, 0);
});

test('T795 Prioridad 1: check-in y cumplimiento de checkin_requests son atómicos y un fallo parcial no confirma éxito', async () => {
  const body = extractFn(clientSrc, 'async function saveSeguimientoClient()');
  const notices = [];
  let committedCheckin = null;
  let committedReq = { id: 'req_1', status: 'pending' };
  const ctx = {
    _authSessionGen: 1,
    _savingSeguimiento: false,
    _seguimientoHistory: [],
    _seguimientoRequests: [{ id: 'req_1', status: 'pending' }],
    _seguimientoDraft: { draftId: 'chk_1', requestId: 'req_1', comentarios: 'Listo' },
    _seguimientoDraftId: 'chk_1',
    _initSeguimientoDraft: () => ctx._seguimientoDraft,
    _persistSeguimientoDraft: () => {},
    USER: { uid: 'client_A' }, PLAN: null, ACTIVE_PLAN_ID: null, CURRENT_WEEK: 1,
    document: { getElementById: () => null },
    FB: {
      db: {}, doc: (_db, ...parts) => parts.join('/'), serverTimestamp: () => 'server-time',
      runTransaction: async (_db, fn) => {
        let stageCheckin = committedCheckin;
        let stageReq = { ...committedReq };
        await fn({
          get: async ref => {
            if (String(ref).includes('/checkins/')) return { exists: () => Boolean(stageCheckin), data: () => stageCheckin };
            if (String(ref).includes('/checkin_requests/')) return { exists: () => true, data: () => stageReq };
            throw new Error('logs unreachable');
          },
          set: (ref, data) => {
            if (String(ref).includes('/checkins/')) stageCheckin = data;
          },
          update: (ref) => {
            if (String(ref).includes('/checkin_requests/')) throw new Error('simulated request update failure');
          }
        });
        committedCheckin = stageCheckin;
        committedReq = stageReq;
      }
    },
    showToast: (message, error) => notices.push({ message, error }),
    renderCheckin: () => {}, renderResumen: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  const ok = await ctx.saveSeguimientoClient();
  assert.equal(ok, false);
  assert.equal(committedCheckin, null, 'el fallo de solicitud revierte el check-in en la operación atómica');
  assert.equal(committedReq.status, 'pending');
  assert.ok(notices.some(n => n.error === true));
  assert.ok(!notices.some(n => /Seguimiento enviado/.test(n.message) && !n.error));
});
