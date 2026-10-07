'use strict';
// Client export vs the REAL Firestore Emulator + the repository's firestore.rules (run via scripts/client-export-emulator.cjs).
// Seeding uses the Admin SDK (test harness only). The exporter itself runs exactly as in the Coach app: Firestore WEB SDK reads as an authenticated
// user (mockUserToken), through assets/client-export/firestore-io.js. Synthetic data only.
// CE_RULES_ENFORCED=1 is set by the official runner (real emulator). Without it (e.g. a rules-less stand-in server) rules-dependent assertions are skipped
// and REPORTED as skipped -- they never count as passes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, collection, query, where } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
const fx = require('./helpers/client-export-fixture.js');
const IO = require('../assets/client-export/firestore-io.js');
const RUN = require('../assets/client-export/runner.js');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const RULES = process.env.CE_RULES_ENFORCED === '1';
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-export';
assert.match(projectId, /^demo-/, 'only demo projects');
const NOW = new Date('2026-04-01T12:00:00Z');
const rulesOnly = { skip: RULES ? false : 'requires the real emulator with firestore.rules (CE_RULES_ENFORCED=1)' };

const adminApp = initAdmin({ projectId }, 'ce-admin');
const adminDb = getAdminFirestore(adminApp);
const apps = [];
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });

function as(uid) {
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 'ce-' + apps.length);
  apps.push(app);
  const db = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(db, host, Number(port), { mockUserToken: { sub: uid } });
  return db;
}
// io = the production adapter over the web SDK; every call is recorded so the real query shapes can be asserted.
function ioFor(uid) {
  const db = as(uid), log = [];
  const sdk = {
    db, doc: (d, c, id) => { log.push({ op: 'doc', path: c + '/' + id }); return doc(d, c, id); }, getDoc, getDocs,
    collection: (d, ...p) => { log.push({ op: 'collection', path: p.join('/') }); return collection(d, ...p); },
    query, where: (f, o, v) => { log.push({ op: 'where', field: f, cmp: o, value: v }); return where(f, o, v); }
  };
  const io = IO.create(sdk); io.log = log; io.db = db;
  return io;
}
async function exportAs(uid, clientId) {
  await ready;
  const io = ioFor(uid), res = await RUN.createExporter({ io, coachUid: uid, now: () => NOW }).run({ clientId });
  if (res.ok) { res.files = fx.readZip(res.bytes); res.json = n => JSON.parse(res.files[n].toString('utf8')); }
  res.io = io; return res;
}
const everything = r => Buffer.concat([Buffer.from(r.filename), Buffer.from(JSON.stringify(r.manifest)), ...Object.keys(r.files).map(n => Buffer.concat([Buffer.from(n + '\n'), r.files[n]])), Buffer.from(r.bytes)]).toString('latin1');
const utf8All = r => Object.keys(r.files).filter(n => !n.startsWith('media/')).map(n => r.files[n].toString('utf8')).join('\n') + r.filename;

async function seed() {
  const db = fx.build(), seeded = [];
  // The A1 export also needs a stale root-doc reference and an athlete identity; keep the fixture otherwise identical to the unit suite.
  db.clients.noCoach = { displayName: 'Sin coach', role: 'client' }; db.clients.wrongCoach = { displayName: 'Otro', role: 'client', coachId: 'coachGhost' };
  db.clients.staleRef = { coachId: fx.COACH_A, displayName: 'Ref obsoleta', role: 'client', activePlanId: 'PDELETED' };
  db.logs.staleRef = { planId: 'PDELETED', currentWeek: 1, updatedAt: 1700000000000, entries: { log_1_0_0_s0: { carga: 10, reps: 5, unit: 'kg', done: true, ts: '2026-02-01T10:00:00.000Z' } } };
  for (const col of Object.keys(db)) {
    for (const id of Object.keys(db[col])) { await adminDb.doc(col + '/' + id).set(db[col][id]); seeded.push(col + '/' + id); }
  }
  assert.ok(seeded.includes('coaches/coachA') && seeded.includes('logs/clientA1/mesos/P1'));
}
const ready = seed();      // every test awaits it (no top-level hooks: node:test would swallow the file when a hook is used here)

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
test('EM.1 coachA exports clientA with the real SDK + rules: complete, valid, correct ids and counts', async () => {
  const r = await exportAs(fx.COACH_A, fx.A1);
  assert.equal(r.ok, true, r.message);
  const m = r.json('manifest.json'), c = r.json('vdsen-client-export-v1.json');
  assert.deepEqual([m.client_id, m.coach_id, m.complete, m.schema], [fx.A1, fx.COACH_A, true, 'vdsen-client-export-v1']);
  for (const n of ['manifest.json', 'vdsen-client-export-v1.json', 'cliente.json', 'ficha360.json', 'biomecanica.json', 'metricas_corporales.json', 'entrenamiento.json', 'mesociclos.json',
    'sesiones.json', 'rendimiento.json', 'adherencia.json', 'recuperacion.json', 'notas.json', 'nutricion.json', 'suplementos.json', 'rendimiento_sesiones.csv', 'adherencia.csv', 'metricas_corporales.csv']) {
    assert.ok(r.files[n], n); if (n.endsWith('.json')) JSON.parse(r.files[n].toString('utf8'));
  }
  assert.deepEqual(m.record_counts, Object.assign({}, m.record_counts, { plans: 2, plans_backup: 1, mesocycles: 2, sessions: 7, exercise_logs: 11, recovery: 3, public_forms: 1 }));
  assert.deepEqual(c.training.mesocycles.map(x => [x.plan_id, x.is_active]), [['P1', false], ['P2', true]]);
  assert.deepEqual(c.training.sessions.map(s => s.session_id), ['P1:w1:d0', 'P1:w1:d1', 'P1:w2:d0', 'P2:w1:d0', 'P2:w1:d1', 'P2:w2:d0', 'P2:w2:d1']);
  assert.equal(c.client.display_name, 'Ana Pérez'); assert.equal(c.adherence.overall.completion_rate, 0.5);
  assert.ok(c.biomechanics.items.some(i => i.key === 'lesiones')); assert.ok(c.recovery.length === 3 && c.notes.length >= 8);
  assert.equal(c.nutrition.display.calorias, 2100); assert.equal(c.supplements.raw.tiers[0].items[0].nombre, 'Creatina');
  assert.ok(c.notes.some(n => n.type === 'coach_note') && c.notes.some(n => n.type === 'coach_message_to_client') && c.notes.some(n => n.type === 'client_exercise_note'));
  assert.ok(c.training.exercise_logs.some(l => l.substituted) && c.training.sessions.some(s => s.performed_exercises.some(e => e.skipped)));
  assert.ok(/Tracción|ñandú/.test(utf8All(r)));
  const csv = fx.parseCsv(r.files['rendimiento_sesiones.csv'].toString('utf8')); assert.equal(csv.length, 12); assert.ok(csv.every(x => x.length === csv[0].length));
  assert.deepEqual(m.sensitive_sections, ['pharmacology']); assert.equal(c.additional_client_data.pharmacology.protocolo, 'P-SINTETICO');
});

test('EM.2 coachA -> clientB (owned by coachB) is DENIED by the real rules; nothing is produced', rulesOnly, async () => {
  for (const id of [fx.B1, fx.B2]) { const r = await exportAs(fx.COACH_A, id); assert.equal(r.ok, false, id); assert.equal(r.code, 'PERMISSION_DENIED'); assert.equal(r.bytes, undefined); }
});

test('EM.3 coachB -> clientA is DENIED; coachB still exports its own clients', rulesOnly, async () => {
  const r = await exportAs(fx.COACH_B, fx.A1); assert.equal(r.ok, false); assert.equal(r.code, 'PERMISSION_DENIED'); assert.equal(r.bytes, undefined);
  const own = await exportAs(fx.COACH_B, fx.B1); assert.equal(own.ok, true, own.message); assert.equal(own.json('manifest.json').client_id, fx.B1);
});

test('EM.4 missing / incorrect ownership and non-coach identities fail closed', rulesOnly, async () => {
  for (const id of ['noCoach', 'wrongCoach', 'doesNotExist']) { const r = await exportAs(fx.COACH_A, id); assert.equal(r.ok, false, id); assert.ok(['PERMISSION_DENIED', 'OWNERSHIP_DENIED'].includes(r.code), id + ' ' + r.code); }
  // The athlete can read their own client doc, but is not the owner coach: ownership gate (and the plan queries) refuse.
  const athlete = await exportAs(fx.A1, fx.A1); assert.equal(athlete.ok, false); assert.ok(['OWNERSHIP_DENIED', 'PERMISSION_DENIED'].includes(athlete.code), athlete.code);
  const stranger = await exportAs('uidWithoutAnything', fx.A1); assert.equal(stranger.ok, false); assert.equal(stranger.code, 'PERMISSION_DENIED');
});

test('EM.5 same display name: no cross-client leakage in any direction (sentinels), clientId is authoritative', async () => {
  const a1 = await exportAs(fx.COACH_A, fx.A1), a2 = await exportAs(fx.COACH_A, fx.A2);
  assert.equal(a1.ok && a2.ok, true);
  const A = everything(a1), A2t = everything(a2);
  assert.ok(utf8All(a1).includes('CLIENT_A_ONLY_SECRET_TEXT'), 'A sentinel present where expected');
  for (const s of ['CLIENT_B_ONLY_SECRET_TEXT', 'NOTA-DE-B1-SECRETA', 'clientB1', 'clientSameNameB', 'coachB', 'FPB', 'Plan de B1']) assert.ok(!A.includes(s), 'A export leaked ' + s);
  for (const s of ['CLIENT_A_ONLY_SECRET_TEXT', 'CLIENT_B_ONLY_SECRET_TEXT', 'NOTA-SECRETA-A2-X', 'Meso activo', 'ana1@example.test', 'Tendinopatía']) assert.ok(!A2t.includes(s), 'A2 export leaked ' + s);
  for (const s of ['NOTA-DE-A2-NO-FILTRAR', 'NOTA-SECRETA-A2', 'FP-DE-A2', 'Plan de A2', 'clientA2']) assert.ok(!A.includes(s), 'A1 export leaked sibling same-name client ' + s);
  assert.equal(a2.json('manifest.json').client_id, fx.A2);
  if (RULES) {
    const b1 = await exportAs(fx.COACH_B, fx.B1), b2 = await exportAs(fx.COACH_B, fx.B2);
    assert.equal(b1.ok && b2.ok, true);
    const B = everything(b1), B2t = everything(b2);
    assert.ok(utf8All(b1).includes('CLIENT_B_ONLY_SECRET_TEXT'));
    for (const s of ['CLIENT_A_ONLY_SECRET_TEXT', 'clientA1', 'clientA2', 'coachA', 'ana1@example.test']) { assert.ok(!B.includes(s), 'B1 leaked ' + s); assert.ok(!B2t.includes(s), 'B2 leaked ' + s); }
    assert.ok(!B2t.includes('Plan de B1') && !B2t.includes('FPB'));
  }
});

test('EM.6 real query shapes: only getDoc/getDocs, equality filters on coachId + clientId/clientUid, never a name; permitted by the real rules', async () => {
  const r = await exportAs(fx.COACH_A, fx.A1); assert.equal(r.ok, true, r.message);
  const log = r.io.log, wheres = log.filter(x => x.op === 'where');
  assert.ok(wheres.every(w => w.cmp === '==' && ['coachId', 'clientId', 'clientUid'].includes(w.field)), JSON.stringify(wheres));
  assert.ok(wheres.every(w => [fx.COACH_A, fx.A1].includes(w.value)));                         // values are ids only
  assert.ok(!JSON.stringify(log).includes('displayName') && !JSON.stringify(log).includes('Ana'));
  const shape = {};
  let cur = null; for (const x of log) { if (x.op === 'collection') { cur = x.path; shape[cur] = shape[cur] || []; } else if (x.op === 'where' && cur) shape[cur].push(x.field + x.cmp + (x.value === fx.COACH_A ? 'coachUid' : 'clientId')); }
  assert.deepEqual(shape.plans, ['coachId==coachUid', 'clientId==clientId']); assert.deepEqual(shape.plans_backup, ['coachId==coachUid', 'clientId==clientId']);
  assert.deepEqual(shape.fichas_publicas, ['coachId==coachUid', 'clientUid==clientId']); assert.deepEqual(shape['logs/clientA1/mesos'], []);
  const docs = log.filter(x => x.op === 'doc').map(x => x.path);
  for (const p of ['clients/clientA1', 'logs/clientA1', 'fichas_onboarding/clientA1', 'fichas_renovacion/clientA1']) assert.ok(docs.includes(p), p);
  assert.ok(docs.every(p => /^(clients|logs|fichas_onboarding|fichas_renovacion|plans)\//.test(p)));
  // Equality-only filters: Firestore serves them from the automatic single-field indexes; no composite index and no orderBy is used.
  assert.ok(!log.some(x => x.op === 'orderBy'));
});

test('EM.7 the coachId filter is REQUIRED by the real rules (a clientId-only query is rejected) -- why the exporter always sends it', rulesOnly, async () => {
  await ready;
  const db = as(fx.COACH_A);
  for (const col of ['plans', 'plans_backup']) {
    await assert.rejects(getDocs(query(collection(db, col), where('clientId', '==', fx.A1))), e => /permission/i.test(String(e.code || e.message)), col);
    const ok = await getDocs(query(collection(db, col), where('coachId', '==', fx.COACH_A), where('clientId', '==', fx.A1))); assert.ok(ok.size >= 1, col);
    // another coach's client, even with the coachId filter set to ourselves, returns nothing (never their documents)
    const none = await getDocs(query(collection(db, col), where('coachId', '==', fx.COACH_A), where('clientId', '==', fx.B1))); assert.equal(none.size, 0, col);
    await assert.rejects(getDocs(query(collection(db, col), where('coachId', '==', fx.COACH_B), where('clientId', '==', fx.B1))), e => /permission/i.test(String(e.code || e.message)), col);
  }
  await assert.rejects(getDocs(query(collection(db, 'fichas_publicas'), where('clientUid', '==', fx.A1))), e => /permission/i.test(String(e.code || e.message)));
  await assert.rejects(getDocs(collection(db, 'logs', fx.B1, 'mesos')), e => /permission/i.test(String(e.code || e.message)));
  await assert.rejects(getDoc(doc(db, 'logs', fx.B1)), e => /permission/i.test(String(e.code || e.message)));
  await assert.rejects(getDoc(doc(db, 'fichas_onboarding', fx.B1)), e => /permission/i.test(String(e.code || e.message)));
});

test('EM.8 stale activePlanId / orphan references (rules deny reads of missing plans) do not break or leak the export', async () => {
  const r = await exportAs(fx.COACH_A, 'staleRef');
  assert.equal(r.ok, true, r.message);
  const m = r.json('manifest.json');
  assert.equal(m.complete, true);
  if (RULES) assert.ok(m.warnings.some(w => w.code === 'REFERENCED_PLAN_UNREADABLE' && w.id === 'PDELETED'));
  const c = r.json('vdsen-client-export-v1.json');
  assert.deepEqual(c.training.mesocycles.map(x => x.plan_id), ['PDELETED']); assert.equal(c.training.sessions.length, 1);
  assert.equal(c.adherence.by_mesocycle[0].status, 'ADHERENCE_INSUFFICIENT_DATA');
});

test('EM.9 media: inline image bundled, URL kept as reference only (signed query stripped), manifest accurate; no remote fetch', async () => {
  const realFetch = globalThis.fetch; let fetched = 0; globalThis.fetch = (...a) => { fetched++; return realFetch(...a); };
  try {
    const r = await exportAs(fx.COACH_A, fx.A1);
    const m = r.json('manifest.json');
    assert.deepEqual(m.media_status, { status: 'PARTIAL', bundled_count: 1, reference_only_count: 1 });
    assert.deepEqual([...r.files['media/media-001.png'].slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const media = r.json('media.json').media;
    assert.equal(media.find(x => x.kind === 'url_reference').url, 'https://img.example.test/a1/front.jpg');
    assert.ok(m.warnings.some(w => w.code === 'MEDIA_REFERENCE_ONLY')); assert.ok(!everything(r).includes('SIGNEDSECRET'));
    assert.equal(fetched, 0, 'the export performs no HTTP fetch of its own (Firestore SDK traffic goes to the emulator over gRPC/REST on localhost only)');
    const a2 = await exportAs(fx.COACH_A, fx.A2); assert.equal(a2.json('manifest.json').media_status.status, 'NOT_PRESENT');
  } finally { globalThis.fetch = realFetch; }
});

test('EM.10 secrets seeded in client docs never reach the archive; legitimate note text with "token" is preserved', async () => {
  const r = await exportAs(fx.COACH_A, fx.A1), all = everything(r);
  for (const s of ['SECRET-FCM', 'SECRET-API', 'SECRET-AT', 'BEGIN PRIVATE KEY']) assert.ok(!all.includes(s), s);
  assert.ok(r.json('vdsen-client-export-v1.json').notes.find(n => n.type === 'coach_note').text.includes('"token" de acceso'));
});

test('EM.11 no privileged bypass: export path uses only the Web SDK adapter (no Admin SDK / credentials in the exporter or the Coach glue)', () => {
  const dir = path.join(__dirname, '..', 'assets', 'client-export');
  for (const f of fs.readdirSync(dir)) { const src = fs.readFileSync(path.join(dir, f), 'utf8'); assert.ok(!/firebase-admin|GoogleAuth|service_account|GOOGLE_APPLICATION_CREDENTIALS|initializeApp\(/.test(src), f); }
  const html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
  const glue = html.slice(html.indexOf('function _vdsenClientExportIo'), html.indexOf('window._vdsenOpenClientExport'));
  assert.ok(glue.includes('VDSEN_CE_FIRESTORE_IO.create({ db, doc, getDoc, getDocs, collection, query, where })'));
});
