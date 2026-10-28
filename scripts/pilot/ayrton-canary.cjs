#!/usr/bin/env node
'use strict';
// T584 · Piloto Ayrton: gestiona SOLO las dos barreras de Firestore de la progresión autónoma para UN atleta:
//   (1) releaseControl/autonomousProgression  (allowlist de la release; solo Admin)   (2) coaches/{coachId}.autoApplyCanary  (canario del Coach)
// No toca variables de Vercel, no habilita CRON, no toca planes ni bitácoras. Simulación por defecto: sin --confirm NO escribe nada.
//
//   node scripts/pilot/ayrton-canary.cjs --uid <UID> --mode status            (solo lectura)
//   node scripts/pilot/ayrton-canary.cjs --uid <UID> --mode enable            (simulación: muestra qué escribiría)
//   node scripts/pilot/ayrton-canary.cjs --uid <UID> --mode enable --confirm  (escribe, caduca a las 24 h; --ttl-hours 1..168)
//   node scripts/pilot/ayrton-canary.cjs --uid <UID> --mode stop   --confirm  (enabled:false en ambas barreras y la caducidad pasa a ahora)
//
// T657: las dos barreras se escriben en UN SOLO commit atómico de Firestore (documents:commit) con precondición sobre la versión leída
// (updateTime / exists:false): o se aplican las dos o ninguna, y si otro proceso las cambió entre la lectura y la escritura el commit falla.
// La barrera de la release lleva `expiresAt`; el ejecutor la comprueba dentro de cada transacción (sin CRON), así que un permiso vencido no aplica nada.
//
// El UID lo entrega el propietario; este script no lo busca ni lo deduce. Credenciales: `gcloud auth print-access-token` de quien lo ejecuta (nunca se imprime).
const { spawnSync } = require('node:child_process');

const PROJECT = 'vdsen-ecosistema';
const RELEASE_PATH = 'releaseControl/autonomousProgression', RELEASE_SCHEMA = 'vdsen-autonomous-release-v1';
const UID_RE = /^[A-Za-z0-9]{20,40}$/;
const DEFAULT_TTL_HOURS = 24, MAX_TTL_HOURS = 168;

function validateUid(uid) {
  if (typeof uid !== 'string' || !UID_RE.test(uid)) throw new Error('UID inválido: debe ser un único UID de Firebase (20-40 caracteres alfanuméricos). Comodines, listas y rutas se rechazan.');
  return uid;
}
function validateTtlHours(h) {
  if (h === undefined) return DEFAULT_TTL_HOURS;
  const n = typeof h === 'string' && /^\d+$/.test(h) ? Number(h) : h;
  if (!Number.isInteger(n) || n < 1 || n > MAX_TTL_HOURS) throw new Error('--ttl-hours inválido: entero entre 1 y ' + MAX_TTL_HOURS + '.');
  return n;
}
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const releaseDoc = (uid, enabled, expiresAt) => {
  if (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiresAt)) throw new Error('expiresAt obligatorio (ISO-8601 UTC).');
  return { schema: RELEASE_SCHEMA, enabled: !!enabled, clientIds: [validateUid(uid)], expiresAt };
};
const canaryField = (uid, enabled) => ({ enabled: !!enabled, clientIds: [validateUid(uid)], prescriptionExerciseIds: [] });

// Firestore REST codec (valores simples)
const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'string' ? { stringValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = (v) => v.stringValue !== undefined ? v.stringValue : v.integerValue !== undefined ? +v.integerValue : v.booleanValue !== undefined ? v.booleanValue : v.nullValue !== undefined ? null
  : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : undefined;
const decDoc = (d) => d && d.fields ? Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, dec(v)])) : null;

// Decide qué escribir. Nunca amplía el alcance: si otra barrera ya lista a OTRO atleta, se niega salvo --replace explícito.
function planWrites(mode, uid, state, opts) {
  validateUid(uid); opts = opts || {};
  if (mode !== 'enable' && mode !== 'stop') throw new Error('modo desconocido: ' + mode);
  const enabled = mode === 'enable', writes = [], refusals = [];
  const now = opts.now instanceof Date ? opts.now : new Date(), ttl = validateTtlHours(opts.ttlHours);
  const expiresAt = enabled ? iso(new Date(now.getTime() + ttl * 3600 * 1000)) : iso(now);
  const foreign = (ids) => Array.isArray(ids) && ids.some((x) => x !== uid);
  const rel = state.release, canary = state.coach && state.coach.autoApplyCanary;
  if (enabled && !opts.replace && foreign(rel && rel.clientIds)) refusals.push('La allowlist de la release ya lista a otros clientes; usa --replace solo si quieres sustituirla por este único atleta.');
  if (enabled && !opts.replace && foreign(canary && canary.clientIds)) refusals.push('El canario del Coach ya lista a otros clientes; usa --replace solo si quieres sustituirlo por este único atleta.');
  if (refusals.length) return { writes: [], refusals };
  writes.push({ path: RELEASE_PATH, mask: ['schema', 'enabled', 'clientIds', 'expiresAt'], fields: releaseDoc(uid, enabled, expiresAt) });
  writes.push({ path: 'coaches/' + state.coachId, mask: ['autoApplyCanary'], fields: { autoApplyCanary: canaryField(uid, enabled) } });
  return { writes, refusals };
}

function defaultToken() { const r = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }); if (r.status !== 0 || !r.stdout.trim()) throw new Error('No se pudo obtener el token (gcloud auth print-access-token).'); return r.stdout.trim(); }
const DB = 'projects/' + PROJECT + '/databases/(default)/documents/';
const BASE = 'https://firestore.googleapis.com/v1/' + DB;
async function http(method, p, token, body, mask) {
  if (method === 'COMMIT') {
    const r = await fetch(BASE.replace(/\/$/, '') + ':commit', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ }
    return { status: r.status, body: j };
  }
  const q = mask ? '?' + mask.map((f) => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&') : '';
  const r = await fetch(BASE + p + q, { method, headers: Object.assign({ authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, body: j };
}

async function main(argv, deps) {
  deps = deps || {}; const out = deps.log || console.log, request = deps.http || http, token = deps.token || defaultToken;
  const arg = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; }, flag = (n) => argv.includes('--' + n);
  const uid = validateUid(arg('uid')), mode = arg('mode') || 'status', confirm = flag('confirm'), replace = flag('replace');
  const tk = token();
  const client = await request('GET', 'clients/' + uid, tk); if (client.status !== 200) throw new Error('No existe clients/<uid> (HTTP ' + client.status + '): el UID no corresponde a una cuenta Cliente; no se escribe nada.');
  const cdoc = decDoc(client.body); if (!cdoc.coachId || !cdoc.activePlanId) throw new Error('El cliente no tiene coachId o activePlanId: no se puede activar.');
  const coachRes = await request('GET', 'coaches/' + cdoc.coachId, tk), relRes = await request('GET', RELEASE_PATH, tk);
  if (coachRes.status !== 200) throw new Error('No existe coaches/<coachId> (HTTP ' + coachRes.status + '): no se escribe nada.');
  if (relRes.status !== 200 && relRes.status !== 404) throw new Error('Lectura de la barrera de release inesperada (HTTP ' + relRes.status + '): no se escribe nada.');
  const coach = decDoc(coachRes.body) || {}, rel = decDoc(relRes.body);
  const plan = decDoc((await request('GET', 'plans/' + cdoc.activePlanId, tk)).body) || {};
  const exs = (plan.days || []).flatMap((d) => d.exercises || []);
  out('Atleta: coachId=' + cdoc.coachId.slice(0, 6) + '… activePlanId=' + cdoc.activePlanId.slice(0, 6) + '… ejercicios=' + exs.length + ' con prescriptionExerciseId=' + exs.filter((e) => e.prescriptionExerciseId).length);
  out('Allowlist release: ' + (rel ? 'enabled=' + rel.enabled + ' clientIds=' + (rel.clientIds || []).length + ' incluye_atleta=' + (rel.clientIds || []).includes(uid) + ' expiresAt=' + (rel.expiresAt || '(ausente)') : '(ausente)'));
  out('Canario del Coach: ' + (coach.autoApplyCanary ? 'enabled=' + coach.autoApplyCanary.enabled + ' clientIds=' + (coach.autoApplyCanary.clientIds || []).length + ' incluye_atleta=' + (coach.autoApplyCanary.clientIds || []).includes(uid) : '(ausente)'));
  if (mode === 'status') return { mode, wrote: 0 };
  const { writes, refusals } = planWrites(mode, uid, { release: rel, coach, coachId: cdoc.coachId }, { replace, ttlHours: arg('ttl-hours'), now: deps.now });
  if (refusals.length) { refusals.forEach((r) => out('RECHAZADO: ' + r)); return { mode, wrote: 0, refused: true }; }
  writes.forEach((w) => out((confirm ? 'ESCRIBE ' : 'SIMULACIÓN ') + w.path + ' campos=' + w.mask.join(',') + ' -> ' + JSON.stringify(w.fields)));
  if (!confirm) { out('Simulación: no se escribió nada. Repite con --confirm para aplicar.'); return { mode, wrote: 0 }; }
  // Un solo commit atómico con precondición de versión: ninguna activación parcial, y falla cerrado si las barreras cambiaron tras la lectura.
  const pre = (res) => res.status === 200 && res.body && res.body.updateTime ? { updateTime: res.body.updateTime } : { exists: false };
  const preconditions = { [RELEASE_PATH]: pre(relRes), ['coaches/' + cdoc.coachId]: pre(coachRes) };
  const body = { writes: writes.map((w) => ({ update: { name: DB + w.path, fields: Object.fromEntries(Object.entries(w.fields).map(([k, v]) => [k, enc(v)])) },
    updateMask: { fieldPaths: w.mask }, currentDocument: preconditions[w.path] })) };
  const r = await request('COMMIT', ':commit', tk, body); if (r.status !== 200) throw new Error('El commit atómico falló (HTTP ' + r.status + '): no se aplicó NINGUNA de las dos barreras.');
  out('Listo: ' + writes.length + ' documentos actualizados (' + mode + ').'); return { mode, wrote: writes.length };
}

module.exports = { validateUid, validateTtlHours, releaseDoc, canaryField, planWrites, main, RELEASE_PATH, RELEASE_SCHEMA, PROJECT };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
