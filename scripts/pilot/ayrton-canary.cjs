#!/usr/bin/env node
'use strict';
// T584 · Piloto Ayrton: gestiona SOLO las dos barreras de Firestore de la progresión autónoma para UN atleta:
//   (1) releaseControl/autonomousProgression  (allowlist de la release; solo Admin)   (2) coaches/{coachId}.autoApplyCanary  (canario del Coach)
// No toca variables de Vercel, no habilita CRON, no toca planes ni bitácoras. Simulación por defecto: sin --confirm NO escribe nada.
//
//   node scripts/pilot/ayrton-canary.cjs --uid <UID> --mode status            (solo lectura)
//   node scripts/pilot/ayrton-canary.cjs --uid <UID> --mode enable            (simulación: muestra qué escribiría)
//   node scripts/pilot/ayrton-canary.cjs --uid <UID> --mode enable --confirm  (escribe)
//   node scripts/pilot/ayrton-canary.cjs --uid <UID> --mode stop   --confirm  (enabled:false en ambas barreras)
//
// El UID lo entrega el propietario; este script no lo busca ni lo deduce. Credenciales: `gcloud auth print-access-token` de quien lo ejecuta (nunca se imprime).
const { spawnSync } = require('node:child_process');

const PROJECT = 'vdsen-ecosistema';
const RELEASE_PATH = 'releaseControl/autonomousProgression', RELEASE_SCHEMA = 'vdsen-autonomous-release-v1';
const UID_RE = /^[A-Za-z0-9]{20,40}$/;

function validateUid(uid) {
  if (typeof uid !== 'string' || !UID_RE.test(uid)) throw new Error('UID inválido: debe ser un único UID de Firebase (20-40 caracteres alfanuméricos). Comodines, listas y rutas se rechazan.');
  return uid;
}
const releaseDoc = (uid, enabled) => ({ schema: RELEASE_SCHEMA, enabled: !!enabled, clientIds: [validateUid(uid)] });
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
  const foreign = (ids) => Array.isArray(ids) && ids.some((x) => x !== uid);
  const rel = state.release, canary = state.coach && state.coach.autoApplyCanary;
  if (enabled && !opts.replace && foreign(rel && rel.clientIds)) refusals.push('La allowlist de la release ya lista a otros clientes; usa --replace solo si quieres sustituirla por este único atleta.');
  if (enabled && !opts.replace && foreign(canary && canary.clientIds)) refusals.push('El canario del Coach ya lista a otros clientes; usa --replace solo si quieres sustituirlo por este único atleta.');
  if (refusals.length) return { writes: [], refusals };
  writes.push({ path: RELEASE_PATH, mask: ['schema', 'enabled', 'clientIds'], fields: releaseDoc(uid, enabled) });
  writes.push({ path: 'coaches/' + state.coachId, mask: ['autoApplyCanary'], fields: { autoApplyCanary: canaryField(uid, enabled) } });
  return { writes, refusals };
}

function defaultToken() { const r = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }); if (r.status !== 0 || !r.stdout.trim()) throw new Error('No se pudo obtener el token (gcloud auth print-access-token).'); return r.stdout.trim(); }
const BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/';
async function http(method, p, token, body, mask) {
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
  const coach = decDoc((await request('GET', 'coaches/' + cdoc.coachId, tk)).body) || {}, rel = decDoc((await request('GET', RELEASE_PATH, tk)).body);
  const plan = decDoc((await request('GET', 'plans/' + cdoc.activePlanId, tk)).body) || {};
  const exs = (plan.days || []).flatMap((d) => d.exercises || []);
  out('Atleta: coachId=' + cdoc.coachId.slice(0, 6) + '… activePlanId=' + cdoc.activePlanId.slice(0, 6) + '… ejercicios=' + exs.length + ' con prescriptionExerciseId=' + exs.filter((e) => e.prescriptionExerciseId).length);
  out('Allowlist release: ' + (rel ? 'enabled=' + rel.enabled + ' clientIds=' + (rel.clientIds || []).length + ' incluye_atleta=' + (rel.clientIds || []).includes(uid) : '(ausente)'));
  out('Canario del Coach: ' + (coach.autoApplyCanary ? 'enabled=' + coach.autoApplyCanary.enabled + ' clientIds=' + (coach.autoApplyCanary.clientIds || []).length + ' incluye_atleta=' + (coach.autoApplyCanary.clientIds || []).includes(uid) : '(ausente)'));
  if (mode === 'status') return { mode, wrote: 0 };
  const { writes, refusals } = planWrites(mode, uid, { release: rel, coach, coachId: cdoc.coachId }, { replace });
  if (refusals.length) { refusals.forEach((r) => out('RECHAZADO: ' + r)); return { mode, wrote: 0, refused: true }; }
  writes.forEach((w) => out((confirm ? 'ESCRIBE ' : 'SIMULACIÓN ') + w.path + ' campos=' + w.mask.join(',') + ' -> ' + JSON.stringify(w.fields)));
  if (!confirm) { out('Simulación: no se escribió nada. Repite con --confirm para aplicar.'); return { mode, wrote: 0 }; }
  for (const w of writes) {
    const body = { fields: Object.fromEntries(Object.entries(w.fields).map(([k, v]) => [k, enc(v)])) };
    const r = await request('PATCH', w.path, tk, body, w.mask); if (r.status !== 200) throw new Error('Fallo al escribir ' + w.path + ' (HTTP ' + r.status + ')');
  }
  out('Listo: ' + writes.length + ' documentos actualizados (' + mode + ').'); return { mode, wrote: writes.length };
}

module.exports = { validateUid, releaseDoc, canaryField, planWrites, main, RELEASE_PATH, RELEASE_SCHEMA, PROJECT };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
