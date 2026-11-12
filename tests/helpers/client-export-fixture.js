/* Synthetic fixtures + a rules-emulating read adapter for the client export tests. No real client data. */
'use strict';

var COACH_A = 'coachA', COACH_B = 'coachB';
var A1 = 'clientA1', A2 = 'clientA2', B1 = 'clientB1', B2 = 'clientSameNameB';
var TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function set(carga, reps, extra) { return Object.assign({ carga: carga, reps: reps, unit: 'kg', done: true, rir: 2, rir_real: 1, ics: 8, pump: 2, ts: '2026-03-02T10:00:00.000Z' }, extra || {}); }
function plan(id, clientId, coachId, extra) {
  return Object.assign({ coachId: coachId, clientId: clientId, weeks: 4, daysPerWeek: 2, status: 'active', generatedBy: 'manual', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', name: 'Meso ' + id,
    days: [
      { dayIndex: 0, label: 'Empuje', notes: 'Calentar hombro', exercises: [
        { exerciseName: 'Press banca', prescriptionExerciseId: id + '-pid0', sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2 }, { setIndex: 1, repsTarget: 8, rirTarget: 2 }] },
        { exerciseName: 'Fondos', prescriptionExerciseId: id + '-pid1', sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 2 }] }] },
      { dayIndex: 1, label: 'Tracción', exercises: [{ exerciseName: 'Remo', prescriptionExerciseId: id + '-pid2', sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 2 }, { setIndex: 1, repsTarget: 10, rirTarget: 2 }] }] }] }, extra || {});
}

function build() {
  var db = {
    coaches: {}, clients: {}, plans: {}, plans_backup: {}, logs: {}, fichas_onboarding: {}, fichas_renovacion: {}, fichas_publicas: {}, 'logs/clientA1/mesos': {}, 'logs/clientA2/mesos': {}, 'logs/clientB1/mesos': {}
  };
  db.coaches[COACH_A] = { displayName: 'Coach A' }; db.coaches[COACH_B] = { displayName: 'Coach B' };
  // Same display name on three clients (two share a coach, one belongs to another coach).
  db.clients[A1] = { coachId: COACH_A, displayName: 'Ana Pérez', email: 'ana1@example.test', role: 'client', activePlanId: 'P2', sex: 'F', age: 31, weight: 62, height: 165,
    coachNote: 'Revisar rodilla; "token" de acceso enviado por WhatsApp', coachNoteUpdatedAt: '2026-03-05T12:00:00.000Z', clientMessage: 'Buen trabajo',
    nutritionPlan: { calorias: 2100, proteina: 130, carbos: 220, grasas: 60, texto: 'Plan\nmuy,bueno "ok"' }, nutritionRaw: { calorias: 2100, comidas: [{ nombre: 'Desayuno' }] },
    supplementPlan: { texto: 'Creatina 5g' }, supplementsRaw: { tiers: [{ nombre: 'T1', items: [{ nombre: 'Creatina', dosis: '5g' }] }] },
    inbodyResults: [{ ts: Date.parse('2026-02-01T08:00:00Z'), peso: 63, grasa: 24 }, { ts: Date.parse('2026-03-01T08:00:00Z'), peso: 62, grasa: 23 }],
    fcmToken: 'SECRET-FCM', apiKey: 'SECRET-API', nested: { accessToken: 'SECRET-AT', privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', keep: 'ok' },
    calibracion_volumetrica: { x: 1 }, sentinel_text: 'CLIENT_A_ONLY_SECRET_TEXT', pharmacoPlan: { protocolo: 'P-SINTETICO', compuestos: [{ nombre: 'compuesto-sintetico', dosis: '100 mg' }] }, campoFuturoDesconocido: { a: [1, 2, { b: 'ñandú' }] }, foto_frente: 'https://img.example.test/a1/front.jpg?token=SIGNEDSECRET&x=1',
    foto_inline: TINY_PNG };
  db.clients[A2] = { coachId: COACH_A, displayName: 'Ana Pérez', email: 'ana2@example.test', role: 'client', activePlanId: 'P9', coachNote: 'NOTA-DE-A2-NO-FILTRAR', nutritionPlan: {}, supplementPlan: {} };
  db.clients[B1] = { coachId: COACH_B, displayName: 'Ana Pérez', email: 'ana3@example.test', role: 'client', activePlanId: 'PB', coachNote: 'NOTA-DE-B1-SECRETA', sentinel_text: 'CLIENT_B_ONLY_SECRET_TEXT', pharmacoPlan: { protocolo: 'B-SINTETICO' } };
  db.clients[B2] = { coachId: COACH_B, displayName: 'Ana Pérez', email: 'ana4@example.test', role: 'client', activePlanId: null, coachNote: 'CLIENT_B_ONLY_SECRET_TEXT (B2)' };
  db.plans.P1 = plan('P1', A1, COACH_A, { status: 'completed', createdAt: '2025-11-01T00:00:00.000Z', weeks: 4, name: 'Meso previo' });
  db.plans.P2 = plan('P2', A1, COACH_A, { internalMemo: 'CLIENT_A_ONLY_SECRET_TEXT', weeks: 6, daysPerWeek: 2, createdAt: '2026-01-15T00:00:00.000Z', name: 'Meso activo' });
  db.plans.P9 = plan('P9', A2, COACH_A, { name: 'Plan de A2' });
  db.plans.PB = plan('PB', B1, COACH_B, { name: 'Plan de B1', internalMemo: 'CLIENT_B_ONLY_SECRET_TEXT' });
  db.plans.PLEG = { coachId: COACH_A, weeks: 4, daysPerWeek: 2, days: [], createdAt: '2025-10-01T00:00:00.000Z', name: 'Legacy sin clientId' };
  db.plans_backup.BK1 = Object.assign(plan('P2', A1, COACH_A), { originalPlanId: 'P2', backedUpAt: '2026-02-01T00:00:00.000Z' });
  db.plans_backup.BK9 = Object.assign(plan('P9', A2, COACH_A), { originalPlanId: 'P9', backedUpAt: '2026-02-01T00:00:00.000Z' });
  // Active meso P2 lives in the root log (week 2 current); P1 only in the mesos snapshot.
  db.logs[A1] = { planId: 'P2', currentWeek: 2, updatedAt: 1700000002000, exerciseUnits: { 'Press banca': 'kg' }, entries: {
    log_1_0_0_s0: set(60, 8, { ts: '2026-02-02T10:00:00.000Z' }), log_1_0_0_s1: set(60, 7, { ts: '2026-02-02T10:05:00.000Z', rir_real: 0 }), log_1_0_1_s0: set(0, 10, { ts: '2026-02-02T10:10:00.000Z' }),
    done_1_0: true, postsession_1_0: { eimd: 2, articular: 'no', sleep: 7, rpe: 8, ts: Date.parse('2026-02-02T11:00:00Z'), nota: 'Me sentí bien, pero con "frío", y\ncansada' },
    log_1_1_0_s0: set(40, 10, { ts: '2026-02-04T10:00:00.000Z' }), exsub_1_1_0: { nombre: 'Remo con mancuerna' },
    log_2_0_0_s0: set(62.5, 8, { ts: '2026-02-09T10:00:00.000Z' }), log_2_0_0_s1: set(62.5, 8, { ts: '2026-02-09T10:05:00.000Z', done: false }),
    done_2_0: { autoClosed: true, skipped: true },
    ci_sem_1: { peso: 62.5, hrv: 55, who5: 60, fecha: '2026-02-07T08:00:00.000Z', nota: 'Semana regular' }, ci_sem_2: { peso: 62, hrv: 58, who5: 64, fecha: '2026-02-14T08:00:00.000Z' },
    progrec_1_0: { recommendations: [{ exerciseName: 'Press banca', action: 'UP' }], deloadTriggers: [] },
    'exnotepid_1_P2-pid0': { planId: 'P2', prescriptionExerciseId: 'P2-pid0', week: 1, day: 0, exerciseIndex: 0, exerciseNameSnapshot: 'Press banca', text: 'Hombro molesta, ñ', updatedAt: Date.parse('2026-02-02T10:30:00Z') },
    exnote_1_0_0: 'Hombro molesta, ñ', exnote_0_0: 'nota legacy sin semana', exskip_2_1_0: { reason: 'dolor' },
    exexpress_2_1_0: { x: 1 }, log_2_1_0_s0: set(45, 10, { express: true, ts: '2026-02-11T10:00:00.000Z' }), log_2_1_0_s1: set(45, 10, { express: true, expressFinal: true, ts: '2026-02-11T10:02:00.000Z' }),
    'nutrilog_2026-02-03': { kcal: 2000 }, clave_rara_futura: { z: 1 }
  } };
  db['logs/' + A1 + '/mesos'].P1 = { planId: 'P1', currentWeek: 4, updatedAt: 1700000001000, entries: {
    log_1_0_0_s0: set(55, 8, { ts: '2025-11-03T10:00:00.000Z' }), done_1_0: true, log_1_1_0_s0: set(35, 10, { ts: '2025-11-05T10:00:00.000Z' }), done_1_1: true,
    log_2_0_0_s0: set(57.5, 8, { ts: '2025-11-10T10:00:00.000Z' }), done_2_0: true } };
  db['logs/' + A1 + '/mesos'].P2 = { planId: 'P2', currentWeek: 1, updatedAt: 1700000001500, entries: { log_1_0_0_s0: set(1, 1) } }; // stale snapshot of the active plan
  db.logs[A2] = { planId: 'P9', currentWeek: 1, updatedAt: 1700000000001, entries: { log_1_0_0_s0: set(99, 9), done_1_0: true, 'exnotepid_1_P9-pid0': { text: 'NOTA-SECRETA-A2', week: 1, updatedAt: 1700000000001 } } };
  db.logs[B1] = { planId: 'PB', currentWeek: 1, updatedAt: 1700000000001, entries: { log_1_0_0_s0: set(77, 7), done_1_0: true, 'exnotepid_1_PB-pid0': { text: 'CLIENT_B_ONLY_SECRET_TEXT', week: 1, updatedAt: 1700000000002 } } };
  db.fichas_onboarding[A1] = { schemaVersion: '1.1', updatedAt: Date.parse('2026-01-10T00:00:00Z'), updatedBy: 'client', data: { nombre: 'Ana Pérez', peso_kg: 63, talla_cm: 165, porcentaje_grasa: 24,
    lesiones: 'Tendinopatía rotuliana izquierda', limitaciones: 'No sentadilla profunda', dolor_actual: 'Hombro derecho leve', ejercicios_evitar: 'Peso muerto convencional', ejercicios_favoritos: 'Hip thrust',
    alimentos_evitar: 'lácteos', restricciones_suplementos: 'ninguna', postura: 'Cifosis leve', fotometria: { circunferencias: { cintura: 70 }, pliegues: { triceps: 12 } }, campo_futuro: 'x', sentinel_text: 'CLIENT_A_ONLY_SECRET_TEXT' } };
  db.fichas_renovacion[A1] = { updatedAt: 1700000005000, updatedBy: 'coach', data: { peso_kg: 62, movilidad: 'Tobillo limitado' } };
  db.fichas_publicas.FP1 = { coachId: COACH_A, clientUid: A1, nombre: 'Ana Pérez', status: 'convertida', objetivo: 'hipertrofia' };
  db.fichas_publicas.FP2 = { coachId: COACH_A, clientUid: A2, nombre: 'Ana Pérez', status: 'convertida', objetivo: 'FP-DE-A2' };
  db.fichas_publicas.FPB = { coachId: COACH_B, clientUid: B1, nombre: 'Ana Pérez', status: 'convertida', objetivo: 'CLIENT_B_ONLY_SECRET_TEXT' };
  db.fichas_onboarding[B1] = { schemaVersion: '1.1', updatedAt: 1700000000000, data: { nombre: 'Ana Pérez', lesiones: 'CLIENT_B_ONLY_SECRET_TEXT' } };
  db.plans_backup.BKB = Object.assign(plan('PB', B1, COACH_B), { originalPlanId: 'PB', backedUpAt: '2026-02-01T00:00:00.000Z', internalMemo: 'CLIENT_B_ONLY_SECRET_TEXT' });
  return db;
}

function permissionError() { var e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; return e; }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

// Read adapter emulating firestore.rules for `asUid`. opts.leak: ignore query filters (adapter-bug simulation); opts.denySection: throw permission-denied for that collection.
function makeIo(db, asUid, opts) {
  opts = opts || {};
  var calls = { getDoc: 0, query: 0, listSub: 0 };
  var isCoach = function() { return !!db.coaches[asUid]; };
  var owns = function(clientId) { return isCoach() && db.clients[clientId] && db.clients[clientId].coachId === asUid; };
  var selfOrOwner = function(id) { return asUid === id || owns(id); };
  function canRead(col, id, data) {
    if (opts.denySection === col) return false;
    switch (col) {
      case 'clients': return asUid === id || (data && data.coachId === asUid);
      case 'plans': return (isCoach() && data.coachId === asUid) || data.clientId === asUid;
      case 'plans_backup': return isCoach() && data.coachId === asUid;
      case 'logs': return selfOrOwner(id);
      case 'fichas_onboarding': case 'fichas_renovacion': return selfOrOwner(id);
      case 'fichas_publicas': return isCoach() && data.coachId === asUid;
      default: return false;
    }
  }
  return {
    calls: calls,
    getDoc: async function(col, id) {
      calls.getDoc++;
      if (opts.denySection === col) throw permissionError();
      var data = db[col] && db[col][id];
      if (data === undefined) {
        // firestore.rules: clients/plans/plans_backup/fichas_publicas rules read resource.data (null for a missing doc -> denied);
        // logs/fichas_onboarding/fichas_renovacion rules depend only on the id (-> readable, snapshot does not exist).
        if (col === 'logs' || col === 'fichas_onboarding' || col === 'fichas_renovacion') { if (!selfOrOwner(id)) throw permissionError(); return null; }
        throw permissionError();
      }
      if (!canRead(col, id, data)) throw permissionError();
      return { id: id, data: clone(data) };
    },
    query: async function(col, conds) {
      calls.query++;
      if (opts.denySection === col) throw permissionError();
      var needsCoach = ['plans', 'plans_backup', 'fichas_publicas'].indexOf(col) !== -1;
      if (needsCoach && !conds.some(function(c) { return c[0] === 'coachId' && c[2] === asUid; })) throw permissionError();
      return Object.keys(db[col] || {}).filter(function(id) {
        var d = db[col][id];
        if (!opts.leak && !conds.every(function(c) { return d[c[0]] === c[2]; })) return false;
        return canRead(col, id, d) || !!opts.leak;
      }).sort().map(function(id) { return { id: id, data: clone(db[col][id]) }; });
    },
    listSub: async function(col, id, sub) {
      calls.listSub++;
      if (opts.denySection === 'logs_mesos') throw permissionError();
      if (!selfOrOwner(id)) throw permissionError();
      var m = db[col + '/' + id + '/' + sub] || {};
      return Object.keys(m).sort().map(function(k) { return { id: k, data: clone(m[k]) }; });
    }
  };
}

// Minimal STORE-zip reader that validates CRC32 (independent of assets/client-export/zip.js writer logic except the polynomial).
function readZip(bytes) {
  var buf = Buffer.from(bytes), out = {}, crcTable = [];
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  function crc(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  var eocd = buf.length - 22;
  if (buf.readUInt32LE(eocd) !== 0x06054b50) throw new Error('no EOCD');
  var count = buf.readUInt16LE(eocd + 10), pos = buf.readUInt32LE(eocd + 16);
  for (var i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad central header');
    var flags = buf.readUInt16LE(pos + 8), method = buf.readUInt16LE(pos + 10), expectCrc = buf.readUInt32LE(pos + 16), size = buf.readUInt32LE(pos + 24);
    var nl = buf.readUInt16LE(pos + 28), el = buf.readUInt16LE(pos + 30), cl = buf.readUInt16LE(pos + 32), off = buf.readUInt32LE(pos + 42);
    var name = buf.slice(pos + 46, pos + 46 + nl).toString('utf8');
    if (method !== 0) throw new Error('unexpected compression'); if (!(flags & 0x800)) throw new Error('utf8 flag missing');
    var ln = buf.readUInt16LE(off + 26), le = buf.readUInt16LE(off + 28), data = buf.slice(off + 30 + ln + le, off + 30 + ln + le + size);
    if (crc(data) !== expectCrc) throw new Error('crc mismatch ' + name);
    out[name] = data; pos += 46 + nl + el + cl;
  }
  return out;
}
// RFC 4180 parser (handles quotes, commas, CRLF/LF inside quoted cells) for round-trip checks.
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  var rows = [], row = [], cell = '', q = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

module.exports = { B2: B2, readZip: readZip, parseCsv: parseCsv, build: build, makeIo: makeIo, COACH_A: COACH_A, COACH_B: COACH_B, A1: A1, A2: A2, B1: B1, TINY_PNG: TINY_PNG, clone: clone };
