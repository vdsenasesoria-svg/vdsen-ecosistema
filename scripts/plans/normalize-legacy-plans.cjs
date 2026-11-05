#!/usr/bin/env node
'use strict';
// T587 / FASE A3 · Procedimiento reutilizable para preparar planes heredados. SOLO LECTURA por defecto; escribir exige respaldo verificado + --confirm + --authorized-by-owner.
//   node scripts/plans/normalize-legacy-plans.cjs preview  [--uid <uid>] [--policy now|created]            (solo lectura: agregado o por plan; sin identificadores salvo --detail)
//   node scripts/plans/normalize-legacy-plans.cjs backup   --uids <a,b,..> --out <archivo.json>            (lee producción; escribe SOLO el archivo local de respaldo)
//   node scripts/plans/normalize-legacy-plans.cjs apply    --uids <a,b,..> --backup <archivo.json> [--policy ..] [--max N] --confirm --authorized-by-owner "<texto>"
//   node scripts/plans/normalize-legacy-plans.cjs verify   --backup <archivo.json> [--log <apply-log.json>]   (solo lectura: comprueba el estado actual frente al respaldo)
//   node scripts/plans/normalize-legacy-plans.cjs rollback --backup <archivo.json> --log <apply-log.json> --confirm --authorized-by-owner "<texto>"
// PARADA: si existe un archivo `STOP` junto al respaldo (o en el directorio actual: `.stop-plan-normalization`), el proceso se detiene entre planes y deja el registro de lo hecho.
// Alcance de escritura: SOLO plans/{activePlanId} de los UID indicados, SOLO los campos `days` (cuando faltan/duplican PID) y `updatedAt` (cuando falta o es inválido), con updateMask y precondición de `updateTime`.
// No toca clientes, bitácoras, coach, reglas, variables, IAM ni credenciales. Credenciales: `gcloud auth print-access-token` de quien lo ejecuta (nunca se imprime).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./plan-normalization-lib.cjs');

const PROJECT = 'vdsen-ecosistema', MAX_PER_RUN = 50;
const UID_RE = /^[A-Za-z0-9]{20,40}$/;
const BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/';

function validateUids(raw) {
  if (typeof raw !== 'string' || !raw) throw new Error('--uids requerido (lista separada por comas de UID de Firebase).');
  const uids = raw.split(','); if (uids.length > MAX_PER_RUN) throw new Error('Máximo ' + MAX_PER_RUN + ' clientes por ejecución.');
  uids.forEach((u) => { if (!UID_RE.test(u)) throw new Error('UID inválido (20-40 caracteres alfanuméricos; sin comodines ni rutas).'); });
  if (new Set(uids).size !== uids.length) throw new Error('UID repetido en la lista.'); return uids;
}
const short = (s) => (typeof s === 'string' && s.length > 6 ? s.slice(0, 6) + '…' : s);
const strField = (d, k) => (d && d.fields && d.fields[k] && typeof d.fields[k].stringValue === 'string' ? d.fields[k].stringValue : null);

function defaultToken() { const r = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }); if (r.status !== 0 || !r.stdout.trim()) throw new Error('No se pudo obtener el token (gcloud auth print-access-token).'); return r.stdout.trim(); }
async function http(method, p, token, body, mask, updateTime) {
  const q = []; (mask || []).forEach((f) => q.push('updateMask.fieldPaths=' + encodeURIComponent(f))); if (updateTime) q.push('currentDocument.updateTime=' + encodeURIComponent(updateTime));
  const r = await fetch(BASE + p + (q.length ? '?' + q.join('&') : ''), { method, headers: Object.assign({ authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ } return { status: r.status, body: j };
}
async function listClients(request, token, list) {
  const out = []; let tkn = '';
  do { const r = await (list || ((t, pt) => fetch(BASE + 'clients?pageSize=300&mask.fieldPaths=activePlanId&mask.fieldPaths=coachId' + (pt ? '&pageToken=' + encodeURIComponent(pt) : ''), { headers: { authorization: 'Bearer ' + t } }).then((x) => x.json())))(token, tkn);
    (r.documents || []).forEach((d) => out.push({ uid: d.name.split('/').pop(), planId: strField(d, 'activePlanId'), coachId: strField(d, 'coachId') })); tkn = r.nextPageToken || ''; } while (tkn);
  return out;
}
async function logsEntries(request, token, uid) {
  const r = await request('GET', 'logs/' + uid, token); if (r.status !== 200) return {};
  const dec = (v) => v.stringValue !== undefined ? v.stringValue : v.integerValue !== undefined ? Number(v.integerValue) : v.doubleValue !== undefined ? v.doubleValue : v.booleanValue !== undefined ? v.booleanValue : v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : null;
  const e = r.body.fields && r.body.fields.entries; return e ? dec(e) : {};
}
const stopRequested = (dir) => fs.existsSync(path.join(dir || '.', 'STOP')) || fs.existsSync('.stop-plan-normalization');

async function main(argv, deps) {
  deps = deps || {}; const out = deps.log || console.log, request = deps.http || http, token = (deps.token || defaultToken)(), now = (deps.now || (() => new Date().toISOString()))(), fsx = deps.fs || fs;
  const arg = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; }, flag = (n) => argv.includes('--' + n), mode = argv[0];
  const policy = arg('policy') === 'created' ? 'created' : 'now';

  if (mode === 'preview') {
    const only = arg('uid'), clients = (await listClients(request, token, deps.list)).filter((c) => c.planId && (!only || c.uid === only));
    const A = { clientes: 0, planesListos: 0, planesPorPreparar: 0, sinUpdatedAt: 0, pidFaltantes: 0, pidDuplicados: 0, ejercicios: 0, ejerciciosSinPid: 0, planesSinEjercicios: 0, planesPlanMissing: 0,
      impacto: { exposicionesConPid: 0, comparablesSiNow: 0, comparablesSiCreated: 0 } }, rows = [];
    for (const c of clients) {
      const p = await request('GET', 'plans/' + c.planId, token); A.clientes++; if (p.status !== 200) { A.planesPlanMissing++; continue; }
      const a = lib.assessPlan(p.body); A.ejercicios += a.exercises; A.ejerciciosSinPid += a.missingPid; A.pidFaltantes += a.missingPid; A.pidDuplicados += a.duplicatePids; if (!a.updatedAtOk) A.sinUpdatedAt++;
      if (!a.exercises) A.planesSinEjercicios++; else if (a.ready) A.planesListos++; else A.planesPorPreparar++;
      const imp = lib.updatedAtImpact(p.body, await logsEntries(request, token, c.uid), now);
      if (!a.ready) { A.impacto.exposicionesConPid += imp.exposures; A.impacto.comparablesSiNow += imp.comparableIfNow; A.impacto.comparablesSiCreated += imp.comparableIfCreated || 0; }   // only plans that would actually be written
      const patch = lib.planPatch(p.body, { policy, nowIso: now, gen: () => 'preview-' + Math.random().toString(36).slice(2) }); rows.push({ who: flag('detail') ? short(c.uid) : '#' + rows.length, ready: a.ready, exercises: a.exercises, missingPid: a.missingPid, updatedAt: a.updatedAtKind, impact: imp, wouldWrite: patch && !patch.skip ? patch.mask : (patch && patch.skip) || [] });
    }
    out('VISTA PREVIA (solo lectura) ' + JSON.stringify(A)); if (only || flag('detail')) rows.forEach((r) => out('  ' + JSON.stringify(r)));
    return { mode, summary: A, rows, wrote: 0 };
  }

  if (mode === 'backup') {
    const uids = validateUids(arg('uids')), outFile = arg('out'); if (!outFile) throw new Error('--out requerido.');
    const docs = [];
    for (const uid of uids) {
      const c = await request('GET', 'clients/' + uid, token); if (c.status !== 200) throw new Error('No existe clients/<uid> (HTTP ' + c.status + '): no se respalda nada.');
      const planId = strField(c.body, 'activePlanId'); if (!planId) { out('OMITIDO ' + short(uid) + ': sin plan activo.'); continue; }
      const p = await request('GET', 'plans/' + planId, token); if (p.status !== 200) throw new Error('El plan activo de ' + short(uid) + ' no existe (HTTP ' + p.status + ').');
      docs.push({ uid, planId, updateTime: p.body.updateTime || null, sha256: lib.sha256(JSON.stringify(p.body.fields)), doc: p.body });
    }
    const manifest = { schema: 'vdsen-plan-backup-v1', createdAt: now, project: PROJECT, count: docs.length, docs }; manifest.manifestSha256 = lib.sha256(JSON.stringify(docs.map((d) => [d.uid, d.planId, d.sha256])));
    fsx.writeFileSync(outFile, JSON.stringify(manifest)); out('Respaldo escrito: ' + outFile + ' · ' + docs.length + ' planes · sha ' + manifest.manifestSha256.slice(0, 12)); return { mode, count: docs.length, manifestSha256: manifest.manifestSha256, wrote: 0 };
  }

  const loadBackup = (f) => { if (!f || !fsx.existsSync(f)) throw new Error('--backup requerido y debe existir.'); const m = JSON.parse(fsx.readFileSync(f, 'utf8'));
    if (m.schema !== 'vdsen-plan-backup-v1' || m.manifestSha256 !== lib.sha256(JSON.stringify(m.docs.map((d) => [d.uid, d.planId, d.sha256]))) || m.docs.some((d) => d.sha256 !== lib.sha256(JSON.stringify(d.doc.fields)))) throw new Error('Respaldo inválido o alterado: no se continúa.'); return m; };

  if (mode === 'apply') {
    const uids = validateUids(arg('uids')), bk = loadBackup(arg('backup')), maxN = Number(arg('max') || uids.length);
    if (!flag('confirm') || !arg('authorized-by-owner')) { out('SIMULACIÓN: falta --confirm y/o --authorized-by-owner "<texto>". No se escribe nada.'); }
    const dry = !(flag('confirm') && arg('authorized-by-owner')), log = { schema: 'vdsen-plan-apply-log-v1', at: now, policy, authorizedBy: dry ? null : arg('authorized-by-owner'), backupSha: bk.manifestSha256, done: [], stopped: false }; let wrote = 0;
    const logFile = arg('log') || path.join(path.dirname(arg('backup')), 'apply-log-' + now.replace(/[:.]/g, '-') + '.json');
    for (const uid of uids) {
      if (stopRequested(path.dirname(arg('backup')))) { log.stopped = true; out('PARADA solicitada: se detiene antes de ' + short(uid) + '.'); break; }
      if (wrote >= maxN) { out('Máximo por ejecución alcanzado (' + maxN + ').'); break; }
      const b = bk.docs.find((d) => d.uid === uid); if (!b) { out('OMITIDO ' + short(uid) + ': no está en el respaldo (primero respalda).'); continue; }
      const cur = await request('GET', 'plans/' + b.planId, token); if (cur.status !== 200) { out('OMITIDO ' + short(uid) + ': el plan no existe.'); continue; }
      if (cur.body.updateTime !== b.updateTime) { out('OMITIDO ' + short(uid) + ': el plan cambió después del respaldo (repite el respaldo).'); log.done.push({ uid, skip: 'CHANGED_SINCE_BACKUP' }); continue; }
      const patch = lib.planPatch(cur.body, { policy, nowIso: now });
      if (!patch) { out('LISTO ' + short(uid) + ': ya cumple (no se escribe).'); log.done.push({ uid, skip: 'ALREADY_READY' }); continue; }
      if (patch.skip) { out('OMITIDO ' + short(uid) + ': ' + patch.skip); log.done.push({ uid, skip: patch.skip }); continue; }
      out((dry ? 'SIMULACIÓN ' : 'ESCRIBE ') + short(uid) + ' campos=' + patch.mask.join(',') + ' · PID nuevos=' + patch.minted + ' · duplicados=' + patch.repaired + (patch.updatedAt ? ' · updatedAt(' + patch.policy + ')=' + patch.updatedAt : ''));
      if (dry) { log.done.push({ uid, planId: b.planId, simulated: true, mask: patch.mask }); continue; }
      const r = await request('PATCH', 'plans/' + b.planId, token, { fields: patch.fields }, patch.mask, cur.body.updateTime);
      if (r.status !== 200) { out('FALLO ' + short(uid) + ' (HTTP ' + r.status + '): el plan cambió durante la operación o se rechazó; se detiene.'); log.done.push({ uid, error: 'HTTP_' + r.status }); log.stopped = true; break; }
      const after = await request('GET', 'plans/' + b.planId, token), v = lib.verifyAfter(b.doc, after.body);
      log.done.push({ uid, planId: b.planId, mask: patch.mask, minted: patch.minted, repaired: patch.repaired, afterUpdateTime: after.body.updateTime, afterSha256: lib.sha256(JSON.stringify(after.body.fields)), verified: v.ok, problems: v.problems });
      wrote++; if (!v.ok) { out('VERIFICACIÓN FALLÓ ' + short(uid) + ': ' + v.problems.join(',') + ' → se detiene (usa rollback con el respaldo).'); log.stopped = true; break; }
    }
    if (!dry) fsx.writeFileSync(logFile, JSON.stringify(log)); out((dry ? 'Simulación' : 'Escritura') + ' terminada: ' + wrote + ' planes' + (dry ? ' (nada escrito)' : '; registro ' + logFile)); return { mode, wrote, log, dry };
  }

  if (mode === 'verify') {
    const bk = loadBackup(arg('backup')), res = [];
    for (const d of bk.docs) { const cur = await request('GET', 'plans/' + d.planId, token); const v = cur.status === 200 ? lib.verifyAfter(d.doc, cur.body) : { ok: false, problems: ['PLAN_MISSING'] }; res.push({ uid: short(d.uid), ok: v.ok, problems: v.problems }); }
    out('VERIFICACIÓN (solo lectura): ' + res.filter((r) => r.ok).length + '/' + res.length + ' correctos'); res.filter((r) => !r.ok).forEach((r) => out('  ' + JSON.stringify(r))); return { mode, results: res, wrote: 0 };
  }

  if (mode === 'rollback') {
    const bk = loadBackup(arg('backup')); if (!arg('log') || !fsx.existsSync(arg('log'))) throw new Error('--log requerido (el registro de la aplicación).'); const log = JSON.parse(fsx.readFileSync(arg('log'), 'utf8'));
    if (log.backupSha !== bk.manifestSha256) throw new Error('El registro no corresponde a este respaldo.');
    const dry = !(flag('confirm') && arg('authorized-by-owner')); let wrote = 0;
    for (const e of log.done.filter((x) => x.mask && !x.simulated)) {
      const b = bk.docs.find((d) => d.uid === e.uid), cur = await request('GET', 'plans/' + e.planId, token);
      if (cur.status !== 200 || cur.body.updateTime !== e.afterUpdateTime) { out('OMITIDO ' + short(e.uid) + ': el plan cambió después de la aplicación (el Coach lo editó): no se revierte.'); continue; }
      const fields = {}; e.mask.forEach((k) => { if (b.doc.fields[k]) fields[k] = b.doc.fields[k]; });   // a field that was ABSENT is deleted (in the mask, not in the body)
      out((dry ? 'SIMULACIÓN ' : 'REVIERTE ') + short(e.uid) + ' campos=' + e.mask.join(','));
      if (!dry) { const r = await request('PATCH', 'plans/' + e.planId, token, { fields }, e.mask, cur.body.updateTime); if (r.status !== 200) { out('FALLO al revertir ' + short(e.uid) + ' (HTTP ' + r.status + ')'); break; } wrote++; }
    }
    out(dry ? 'Simulación de reversión: no se escribió nada.' : 'Reversión terminada: ' + wrote + ' planes.'); return { mode, wrote, dry };
  }
  throw new Error('modo desconocido (preview | backup | apply | verify | rollback).');
}

module.exports = { main, validateUids, MAX_PER_RUN, PROJECT };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
