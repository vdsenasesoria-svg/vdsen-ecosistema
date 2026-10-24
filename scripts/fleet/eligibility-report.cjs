#!/usr/bin/env node
'use strict';
// T587 / FASE F1 · Elegibilidad automática de clientes para la progresión autónoma. SOLO LECTURA. No habilita a nadie, no escribe nada, no depende de listas manuales de ejercicios ni de máquinas.
//   node scripts/fleet/eligibility-report.cjs                 (agregado, sin identificadores)
//   node scripts/fleet/eligibility-report.cjs --detail        (por cliente con prefijo corto del UID, para elegir cohorte)
// Clasificación técnica por cliente (en este orden):
//   NO_ACTIVE_PLAN      sin plan activo
//   NEEDS_PLAN_PREP     el plan no tiene un PID único por ejercicio y/o updatedAt ISO (el motor falla cerrado)  → procedimiento de preparación (docs/T587_LEGACY_PLAN_NORMALIZATION.md)
//   SAFETY_HOLD         dolor articular reportado en cualquiera de las dos últimas sesiones con registro (el motor suspendería todo cambio)
//   NEEDS_EVIDENCE      plan listo, pero ningún ejercicio tiene aún 2 exposiciones comparables (misma identidad, posteriores a la última revisión del plan)
//   ELIGIBLE            plan listo, sin dolor reciente y al menos un ejercicio con 2 exposiciones comparables
// Es un diagnóstico TÉCNICO: elegible NO significa activado (la activación es una decisión del propietario, por cohortes de ≤ 10, con observación previa).
const { spawnSync } = require('node:child_process');

const PROJECT = 'vdsen-ecosistema', BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/';
function defaultToken() { const r = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }); if (r.status !== 0 || !r.stdout.trim()) throw new Error('No se pudo obtener el token (gcloud auth print-access-token).'); return r.stdout.trim(); }
async function get(p, token) { const r = await fetch(BASE + p, { headers: { authorization: 'Bearer ' + token } }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ } return { status: r.status, body: j }; }
async function listClients(token, list) {
  const out = []; let tkn = '';
  do { const r = await (list || ((t, pt) => fetch(BASE + 'clients?pageSize=300&mask.fieldPaths=activePlanId&mask.fieldPaths=coachId' + (pt ? '&pageToken=' + encodeURIComponent(pt) : ''), { headers: { authorization: 'Bearer ' + t } }).then((x) => x.json())))(token, tkn);
    (r.documents || []).forEach((d) => out.push({ uid: d.name.split('/').pop(), planId: d.fields && d.fields.activePlanId && d.fields.activePlanId.stringValue || null })); tkn = r.nextPageToken || ''; } while (tkn);
  return out;
}
const dec = (v) => v.stringValue !== undefined ? v.stringValue : v.integerValue !== undefined ? Number(v.integerValue) : v.doubleValue !== undefined ? v.doubleValue : v.booleanValue !== undefined ? v.booleanValue : v.nullValue !== undefined ? null
  : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : undefined;
const doc = (d) => (d && d.fields ? Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, dec(v)])) : null);

// Pure classification. plan = decoded plan doc; entries = decoded logbook entries.
function classify(plan, entries) {
  if (!plan) return { state: 'NO_ACTIVE_PLAN' };
  const exs = (plan.days || []).flatMap((d) => d.exercises || []), pids = exs.map((e) => e.prescriptionExerciseId).filter((x) => typeof x === 'string' && x);
  const updatedMs = typeof plan.updatedAt === 'string' ? Date.parse(plan.updatedAt) : NaN;
  const planReady = exs.length > 0 && pids.length === exs.length && new Set(pids).size === pids.length && Number.isFinite(updatedMs);
  const base = { exercises: exs.length, withPid: pids.length, planReady: planReady, priorities: !!(plan.musclePriorities && ((plan.musclePriorities.PRIORITARIO || []).length || (plan.musclePriorities.NO_PRIORITARIO || []).length)), ranges: exs.filter((e) => e.repsRange).length };
  if (!planReady) return Object.assign(base, { state: 'NEEDS_PLAN_PREP' });
  entries = entries || {};
  const sessions = Object.keys(entries).map((k) => { const m = /^postsession_(\d+)_(\d+)$/.exec(k); return m ? { w: +m[1], d: +m[2], p: entries[k] } : null; }).filter(Boolean).sort((a, b) => a.w - b.w || a.d - b.d).slice(-2);
  const pain = sessions.some((s) => s.p && ((s.p.articularPain && s.p.articularPain.present) || s.p.articular === 'si'));
  const perPid = {}; Object.keys(entries).forEach((k) => {
    const m = /^log_(\d+)_(\d+)_(\d+)_s\d+$/.exec(k), e = entries[k]; if (!m || !e || e.done !== true || e.autoFilled === true || e.express === true || e.expressFinal === true || pids.indexOf(e.prescriptionExerciseId) < 0) return;
    if (typeof e.ts === 'number' && e.ts < updatedMs) return;   // evidence before the last plan revision is not comparable
    (perPid[e.prescriptionExerciseId] = perPid[e.prescriptionExerciseId] || new Set()).add(m[1] + '_' + m[2]);
  });
  const comparable = Object.values(perPid).filter((s) => s.size >= 2).length;
  Object.assign(base, { exercisesWithTwoExposures: comparable, recentPain: pain });
  return Object.assign(base, { state: pain ? 'SAFETY_HOLD' : (comparable > 0 ? 'ELIGIBLE' : 'NEEDS_EVIDENCE') });
}

async function main(argv, deps) {
  deps = deps || {}; const out = deps.log || console.log, request = deps.http || get, token = (deps.token || defaultToken)();
  const detail = argv.includes('--detail'), clients = await listClients(token, deps.list), counts = { clientes: 0, NO_ACTIVE_PLAN: 0, NEEDS_PLAN_PREP: 0, SAFETY_HOLD: 0, NEEDS_EVIDENCE: 0, ELIGIBLE: 0 }, rows = [];
  for (const c of clients) {
    counts.clientes++; let r;
    if (!c.planId) r = { state: 'NO_ACTIVE_PLAN' };
    else { const p = await request('plans/' + c.planId, token); const root = p.status === 200 ? await request('logs/' + c.uid, token) : null; const rd = root && root.status === 200 ? doc(root.body) : null; r = p.status === 200 ? classify(doc(p.body), rd && rd.entries) : { state: 'NO_ACTIVE_PLAN' }; }
    counts[r.state]++; rows.push(Object.assign({ who: detail ? String(c.uid).slice(0, 6) + '…' : '#' + rows.length }, r));
  }
  out('ELEGIBILIDAD TÉCNICA (solo lectura; elegible ≠ activado) ' + JSON.stringify(counts)); if (detail) rows.forEach((r) => out('  ' + JSON.stringify(r)));
  return { counts, rows };
}

module.exports = { classify, main };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
