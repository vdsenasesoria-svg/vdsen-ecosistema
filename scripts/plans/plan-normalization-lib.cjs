'use strict';
// T587 / FASE A3 · Normalización de planes heredados — BIBLIOTECA PURA (sin red, sin Firestore, sin reloj implícito).
// Un plan "listo" para la progresión autónoma tiene (1) `updatedAt` como ISO string y (2) un `prescriptionExerciseId` único por ejercicio.
// La biblioteca trabaja sobre el árbol REST tipado de Firestore SIN decodificar los demás valores (dobles, marcas de tiempo, nulos, mapas anidados quedan idénticos).
//
// Reglas de seguridad (probadas en tests/t587-plan-normalization.test.js):
//  * Conserva los PID existentes (primera aparición); acuña SOLO los que faltan; un duplicado dentro del plan recibe un PID nuevo (la primera aparición conserva el suyo).
//  * No toca ejercicios, series, repeticiones, RIR, descansos, orden, técnicas ni ningún otro campo. No asocia historial antiguo a ningún PID nuevo.
//  * Idempotente: un plan que ya cumple NO se vuelve a escribir (su fecha de revisión no se mueve).
//  * `updatedAt` es la ÚLTIMA REVISIÓN DE LA PRESCRIPCIÓN: la evidencia registrada antes de esa fecha deja de ser comparable (PRESCRIPTION_CHANGED). Por eso se evalúa su efecto ANTES:
//    `updatedAtImpact` cuenta, con la bitácora real, cuántas exposiciones por PID existente seguirían siendo comparables con cada política (`now` | `created`). Nunca se actualiza en masa a ciegas.
const crypto = require('node:crypto');

const rawArr = (v) => (v && v.arrayValue && v.arrayValue.values) || [];
const rawMap = (v) => (v && v.mapValue && v.mapValue.fields) || null;
const rawStr = (v) => (v && typeof v.stringValue === 'string' ? v.stringValue : null);
const isoMs = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const genPid = () => crypto.randomUUID();

// Exercises of a raw plan document in order: [{ dayIndex (raw int or null), ex (raw map fields), pid }]
function listExercises(planDoc) {
  const out = [], f = (planDoc && planDoc.fields) || {};
  rawArr(f.days).forEach((d, di) => { const m = rawMap(d); if (!m) return; rawArr(m.exercises).forEach((e) => { const x = rawMap(e); if (!x) return; out.push({ di, fields: x, pid: rawStr(x.prescriptionExerciseId) }); }); });
  return out;
}

function assessPlan(planDoc) {
  const exs = listExercises(planDoc), seen = new Set(); let withPid = 0, duplicates = 0;
  exs.forEach((e) => { if (e.pid) { withPid++; if (seen.has(e.pid)) duplicates++; seen.add(e.pid); } });
  const f = (planDoc && planDoc.fields) || {}, ua = f.updatedAt, updatedAtOk = !!(ua && typeof ua.stringValue === 'string' && isoMs(ua.stringValue) !== null);
  const ca = f.createdAt, createdAtMs = ca && typeof ca.stringValue === 'string' ? isoMs(ca.stringValue) : null;
  return { exercises: exs.length, withPid, missingPid: exs.length - withPid, duplicatePids: duplicates, updatedAtOk, updatedAtKind: !ua ? 'ABSENT' : (typeof ua.stringValue === 'string' ? (updatedAtOk ? 'ISO_STRING' : 'INVALID_STRING') : 'NOT_A_STRING'),
    createdAtMs: createdAtMs, ready: exs.length > 0 && withPid === exs.length && duplicates === 0 && updatedAtOk };
}

// Mirrors the Coach `_stampPrescriptionIds`.
function stampRawDays(rawDays, gen) {
  gen = gen || genPid; const seen = new Set(); let minted = 0, repaired = 0;
  const days = rawArr(rawDays).map((day) => {
    const dfields = rawMap(day); if (!dfields || !dfields.exercises || !dfields.exercises.arrayValue) return day;
    const outEx = rawArr(dfields.exercises).map((ex) => {
      const f = rawMap(ex); if (!f) return ex;
      const id = rawStr(f.prescriptionExerciseId);
      if (id && !seen.has(id)) { seen.add(id); return ex; }
      let n = gen(); while (seen.has(n)) n = gen(); seen.add(n); if (id) repaired++; else minted++;
      return { mapValue: { fields: Object.assign({}, f, { prescriptionExerciseId: { stringValue: n } }) } };
    });
    return { mapValue: { fields: Object.assign({}, dfields, { exercises: { arrayValue: { values: outEx } } }) } };
  });
  return { rawDays: { arrayValue: { values: days } }, minted, repaired };
}

// Effect of the `updatedAt` policy on the REAL logbook: per existing PID, how many executed exposures would remain comparable (executed at/after updatedAt) under each policy.
// logsEntries: decoded entries map of logs/{uid} (or its mesos doc). Only exercises that ALREADY have a PID can have PID-bound history; exercises without a PID have no linkable history at all.
function updatedAtImpact(planDoc, logsEntries, nowIso) {
  const exs = listExercises(planDoc), a = assessPlan(planDoc), pids = new Set(exs.map((e) => e.pid).filter(Boolean)), policies = { now: isoMs(nowIso), created: a.createdAtMs };
  const perPid = {}; Object.keys(logsEntries || {}).forEach((k) => {
    const m = /^log_(\d+)_(\d+)_(\d+)_s\d+$/.exec(k), e = logsEntries[k];
    if (!m || !e || typeof e !== 'object' || !pids.has(e.prescriptionExerciseId) || e.done !== true) return;
    const g = m[1] + '_' + m[2], p = perPid[e.prescriptionExerciseId] || (perPid[e.prescriptionExerciseId] = {});
    const ts = typeof e.ts === 'number' ? e.ts : null, x = p[g] || (p[g] = { lastTs: null }); if (ts !== null && (x.lastTs === null || ts > x.lastTs)) x.lastTs = ts;
  });
  const res = { pidsWithHistory: Object.keys(perPid).length, exposures: 0, comparableIfNow: 0, comparableIfCreated: null };
  Object.keys(perPid).forEach((pid) => Object.keys(perPid[pid]).forEach((g) => {
    const ts = perPid[pid][g].lastTs; res.exposures++;
    if (policies.now !== null && ts !== null && ts >= policies.now) res.comparableIfNow++;
    if (policies.created !== null) { res.comparableIfCreated = (res.comparableIfCreated || 0) + (ts !== null && ts >= policies.created ? 1 : 0); }
  }));
  return res;
}

// Proposal for ONE plan or null when it is already ready. policy: 'now' (default, conservative) | 'created' (only for a plan whose first revision date is trusted).
function planPatch(planDoc, opts) {
  opts = opts || {}; const a = assessPlan(planDoc); if (a.ready) return null;
  if (!a.exercises) return { skip: 'PLAN_WITHOUT_EXERCISES', before: a };
  const policy = opts.policy === 'created' ? 'created' : 'now', f = planDoc.fields || {};
  let updatedAt = a.updatedAtOk ? f.updatedAt.stringValue : null;   // a valid existing date is NEVER moved
  if (!updatedAt) {
    if (policy === 'created') { const c = f.createdAt && rawStr(f.createdAt); if (!c || isoMs(c) === null) return { skip: 'CREATED_AT_UNUSABLE', before: a }; updatedAt = c; }
    else updatedAt = opts.nowIso;
  }
  const st = stampRawDays(f.days, opts.gen), patchFields = {};
  if (st.minted || st.repaired) patchFields.days = st.rawDays;
  if (!a.updatedAtOk) patchFields.updatedAt = { stringValue: updatedAt };
  return { mask: Object.keys(patchFields), fields: patchFields, minted: st.minted, repaired: st.repaired, updatedAt: a.updatedAtOk ? null : updatedAt, policy: a.updatedAtOk ? null : policy, updateTime: planDoc.updateTime || null, before: a };
}

// Verification AFTER an apply: every untouched value equal, PIDs preserved, none duplicated, readiness reached. before/after = raw plan documents.
function verifyAfter(beforeDoc, afterDoc) {
  const b = listExercises(beforeDoc), a = listExercises(afterDoc), problems = [];
  if (b.length !== a.length) problems.push('EXERCISE_COUNT_CHANGED');
  const firstSeen = new Set();
  b.forEach((x, i) => { const y = a[i]; if (!y) return;
    const strip = (f) => { const c = Object.assign({}, f); delete c.prescriptionExerciseId; return JSON.stringify(c); };
    if (strip(x.fields) !== strip(y.fields)) problems.push('EXERCISE_CONTENT_CHANGED@' + i);
    // the FIRST occurrence of a PID must survive byte for byte; a later duplicate of the same PID is legitimately re-minted (never two exercises with one identity)
    const dup = !!x.pid && firstSeen.has(x.pid); if (x.pid) firstSeen.add(x.pid);
    if (x.pid && !dup && x.pid !== y.pid) problems.push('EXISTING_PID_CHANGED@' + i);
    if (dup && x.pid === y.pid) problems.push('DUPLICATE_PID_KEPT@' + i); });
  const bf = (beforeDoc && beforeDoc.fields) || {}, af = (afterDoc && afterDoc.fields) || {};
  Object.keys(bf).forEach((k) => { if (k === 'days' || k === 'updatedAt') return; if (JSON.stringify(bf[k]) !== JSON.stringify(af[k])) problems.push('FIELD_CHANGED:' + k); });
  const as = assessPlan(afterDoc); if (!as.ready) problems.push('NOT_READY_AFTER');
  return { ok: problems.length === 0, problems, after: as };
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
module.exports = { listExercises, assessPlan, stampRawDays, updatedAtImpact, planPatch, verifyAfter, sha256 };
