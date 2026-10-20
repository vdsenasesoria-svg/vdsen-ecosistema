#!/usr/bin/env node
'use strict';
// T587 / FASE E1 · Verificación de preparación del piloto. SOLO LECTURA. El UID se recibe por argumento (nunca se guarda ni se imprime completo).
//   node scripts/pilot/pilot-readiness.cjs --uid <UID>
// Comprueba, con las credenciales de quien lo ejecuta (`gcloud auth print-access-token`): plan activo e integridad (PID, updatedAt), rangos y prioridades persistidos, bitácora,
// barreras reales (allowlist de la release + canario del Coach) y estados PENDING / APPLIED / CONSUMED del motor. Imprime solo booleanos y conteos.
const { spawnSync } = require('node:child_process');

const PROJECT = 'vdsen-ecosistema', UID_RE = /^[A-Za-z0-9]{20,40}$/;
const BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/';
function defaultToken() { const r = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }); if (r.status !== 0 || !r.stdout.trim()) throw new Error('No se pudo obtener el token (gcloud auth print-access-token).'); return r.stdout.trim(); }
async function http(p, token) { const r = await fetch(BASE + p, { headers: { authorization: 'Bearer ' + token } }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ } return { status: r.status, body: j }; }
const dec = (v) => v.stringValue !== undefined ? v.stringValue : v.integerValue !== undefined ? Number(v.integerValue) : v.doubleValue !== undefined ? v.doubleValue : v.booleanValue !== undefined ? v.booleanValue : v.nullValue !== undefined ? null : v.timestampValue !== undefined ? v.timestampValue
  : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : undefined;
const doc = (d) => (d && d.fields ? Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, dec(v)])) : null);

// Self-contained on purpose (no dependency on other PRs): a plan is READY for the progression with a unique PID per exercise and an ISO-string updatedAt.
function assessPlan(planDoc) {
  const f = (planDoc && planDoc.fields) || {}, seen = new Set(); let exercises = 0, withPid = 0, dup = 0;
  ((f.days && f.days.arrayValue && f.days.arrayValue.values) || []).forEach((d) => { const m = d.mapValue && d.mapValue.fields; ((m && m.exercises && m.exercises.arrayValue && m.exercises.arrayValue.values) || []).forEach((e) => {
    const x = e.mapValue && e.mapValue.fields; if (!x) return; exercises++; const id = x.prescriptionExerciseId && x.prescriptionExerciseId.stringValue; if (id) { withPid++; if (seen.has(id)) dup++; seen.add(id); } }); });
  const ua = f.updatedAt, ok = !!(ua && typeof ua.stringValue === 'string' && Number.isFinite(Date.parse(ua.stringValue)));
  return { exercises, withPid, updatedAtOk: ok, updatedAtKind: !ua ? 'ausente' : (typeof ua.stringValue === 'string' ? (ok ? 'ISO' : 'inválido') : 'no es texto'), ready: exercises > 0 && withPid === exercises && dup === 0 && ok };
}

async function main(argv, deps) {
  deps = deps || {}; const out = deps.log || console.log, get = deps.http || http, token = (deps.token || defaultToken)();
  const i = argv.indexOf('--uid'), uid = i >= 0 ? argv[i + 1] : undefined; if (!UID_RE.test(uid || '')) throw new Error('--uid requerido (UID de Firebase, 20-40 caracteres alfanuméricos).');
  const R = { checks: {}, counts: {} }, ok = (k, v, extra) => { R.checks[k] = v; out((v ? 'OK     ' : 'FALLA  ') + k + (extra ? ' · ' + extra : '')); };
  const client = await get('clients/' + uid, token); if (client.status !== 200) { ok('cliente_existe', false, 'HTTP ' + client.status); return R; }
  const c = doc(client.body); ok('cliente_existe', true); ok('plan_activo_definido', !!c.activePlanId && !!c.coachId);
  const planDoc = c.activePlanId ? await get('plans/' + c.activePlanId, token) : { status: 404 }; ok('plan_activo_existe', planDoc.status === 200); if (planDoc.status !== 200) return R;
  const a = assessPlan(planDoc.body), plan = doc(planDoc.body); R.counts.ejercicios = a.exercises; R.counts.conPID = a.withPid;
  ok('plan_listo_para_progresion', a.ready, 'ejercicios=' + a.exercises + ' conPID=' + a.withPid + ' updatedAt=' + a.updatedAtKind);
  const exs = (plan.days || []).flatMap((d) => d.exercises || []);
  R.counts.conRepsRange = exs.filter((e) => e.repsRange).length; R.counts.conMuscleGroup = exs.filter((e) => e.muscleGroup).length; R.counts.conExerciseId = exs.filter((e) => e.exerciseId).length;
  const mp = plan.musclePriorities; const hasPrio = !!(mp && ((mp.PRIORITARIO || []).length || (mp.NO_PRIORITARIO || []).length));
  ok('prioridades_musculares_persistidas', hasPrio, hasPrio ? 'PRIORITARIO=' + (mp.PRIORITARIO || []).length + ' NO_PRIORITARIO=' + (mp.NO_PRIORITARIO || []).length : 'el plan no las declara (el motor funciona sin diferenciar por prioridad)');
  ok('rangos_de_repeticiones_disponibles', R.counts.conRepsRange > 0, 'ejercicios con repsRange=' + R.counts.conRepsRange);
  ok('rirByWeek_en_el_plan', !!plan.rirByWeek);
  const root = await get('logs/' + uid, token), rootDoc = root.status === 200 ? doc(root.body) : null, entries = (rootDoc && rootDoc.entries) || {}; const keys = Object.keys(entries);
  R.counts.seriesRegistradas = keys.filter((k) => /^log_\d+_\d+_\d+_s\d+$/.test(k) && entries[k] && entries[k].done === true).length; R.counts.sesionesCerradas = keys.filter((k) => /^done_\d+_\d+$/.test(k)).length;
  ok('bitacora_con_registro', R.counts.seriesRegistradas > 0, 'series=' + R.counts.seriesRegistradas + ' sesionesCerradas=' + R.counts.sesionesCerradas);
  const rel = await get('releaseControl/autonomousProgression', token), r = rel.status === 200 ? doc(rel.body) : null;
  ok('barrera_release_abierta_para_el_atleta', !!(r && r.schema === 'vdsen-autonomous-release-v1' && r.enabled === true && Array.isArray(r.clientIds) && r.clientIds.indexOf(uid) >= 0 && r.clientIds.length <= 10), r ? 'enabled=' + r.enabled + ' clientes=' + (r.clientIds || []).length : '(ausente)');
  ok('allowlist_solo_el_piloto', !!(r && Array.isArray(r.clientIds) && r.clientIds.length === 1 && r.clientIds[0] === uid));
  const coach = c.coachId ? await get('coaches/' + c.coachId, token) : { status: 404 }, cd = coach.status === 200 ? doc(coach.body) : null, can = cd && cd.autoApplyCanary;
  ok('barrera_canario_abierta_para_el_atleta', !!(can && can.enabled === true && Array.isArray(can.clientIds) && can.clientIds.indexOf(uid) >= 0), can ? 'enabled=' + can.enabled + ' clientes=' + (can.clientIds || []).length : '(ausente)');
  const mesos = await get('logs/' + uid + '/mesos?pageSize=20', token), docs = (mesos.body && mesos.body.documents) || [];
  const states = { PENDING: 0, APPLIED: 0, CONSUMED: 0, REJECTED: 0, STALE: 0 }, dims = {};
  docs.map(doc).filter((m) => m && m.planId === c.activePlanId).forEach((m) => { Object.values(m.progressionApplications || {}).forEach((x) => { if (x && states[x.state] !== undefined) states[x.state]++; }); Object.values(m.nextExposureOverlays || {}).forEach((o) => { dims[o.dimension] = (dims[o.dimension] || 0) + 1; }); });
  R.counts.estados = states; R.counts.overlaysPorDimension = dims; out('       estados del motor para el plan activo: ' + JSON.stringify(states) + ' · overlays por dimensión: ' + JSON.stringify(dims));
  out('Nota: las variables AUTONOMOUS_PROGRESSION_* de Vercel no son legibles desde Firestore; se verifican en el panel de Vercel o por el comportamiento del endpoint.');
  return R;
}

module.exports = { main };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
