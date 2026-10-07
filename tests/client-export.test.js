'use strict';
// Coach "Exportar cliente" (vdsen-client-export-v1): ownership, completeness, derived analytics, CSV, ZIP, secrets, media, UI trigger.
// Pure Node: the export modules are injected with a rules-emulating read adapter over synthetic fixtures (no Firebase, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('./helpers/client-export-fixture.js');
const SEC = require('../assets/client-export/security.js');
const NORM = require('../assets/client-export/normalize.js');
const DER = require('../assets/client-export/derive.js');
const SER = require('../assets/client-export/serialize.js');
const COL = require('../assets/client-export/collect.js');
const RUN = require('../assets/client-export/runner.js');
const UI = require('../assets/client-export/ui.js');
const NOW = new Date('2026-04-01T12:00:00Z');

async function doExport(db, uid, clientId, ioOpts) {
  const io = fx.makeIo(db, uid, ioOpts);
  const ex = RUN.createExporter({ io, coachUid: uid, now: () => NOW });
  const res = await ex.run({ clientId });
  if (res.ok) { res.files = fx.readZip(res.bytes); res.text = Object.keys(res.files).filter(n => !n.startsWith('media/')).map(n => res.files[n].toString('utf8')).join('\n'); res.json = n => JSON.parse(res.files[n].toString('utf8')); }
  res.io = io;
  return res;
}
const ok = async (db, uid, id, o) => { const r = await doExport(db, uid, id, o); assert.equal(r.ok, true, r.message); return r; };

test('CE.0 archive layout: manifest + every required section, valid JSON, CRC-checked ZIP, canonical schema', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1);
  assert.equal(r.filename, 'VDSEN_Ana-Perez_2026-04-01_export.zip');
  for (const n of ['manifest.json', 'cliente.json', 'ficha360.json', 'biomecanica.json', 'metricas_corporales.json', 'entrenamiento.json', 'mesociclos.json', 'sesiones.json', 'rendimiento.json',
    'adherencia.json', 'recuperacion.json', 'notas.json', 'nutricion.json', 'suplementos.json', 'rendimiento_sesiones.csv', 'adherencia.csv', 'metricas_corporales.csv', 'vdsen-client-export-v1.json']) {
    assert.ok(r.files[n], 'missing ' + n); if (n.endsWith('.json')) JSON.parse(r.files[n].toString('utf8'));
  }
  const m = r.json('manifest.json'), c = r.json('vdsen-client-export-v1.json');
  assert.equal(m.schema, 'vdsen-client-export-v1'); assert.equal(m.schema_version, 1); assert.equal(m.client_id, fx.A1); assert.equal(m.coach_id, fx.COACH_A);
  assert.equal(m.client_display_name, 'Ana Pérez'); assert.equal(m.exported_at, NOW.toISOString());
  for (const k of ['included_sections', 'record_counts', 'warnings', 'media_status', 'data_range', 'mesocycle_count', 'session_count']) assert.ok(k in m, k);
  assert.equal(c.schema, 'vdsen-client-export-v1'); assert.equal(c.export_metadata.client_id, fx.A1); assert.equal(c.export_metadata.source, 'VDSEN Coach');
  for (const k of ['client', 'ficha_360', 'biomechanics', 'body_metrics', 'training', 'performance', 'adherence', 'recovery', 'notes', 'nutrition', 'supplements', 'media', 'additional_client_data', 'warnings']) assert.ok(k in c, k);
  for (const f of m.files) assert.equal(r.files[f.path].length, f.bytes, f.path);
});

test('CE.1/CE.23 Client A export never contains Client B (other coach) records', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1);
  for (const needle of ['NOTA-DE-B1-SECRETA', 'clientB1', 'coachB', 'Plan de B1', '"PB"', 'FPB']) assert.ok(!r.text.includes(needle), 'leaked ' + needle);
  const c = r.json('vdsen-client-export-v1.json');
  for (const p of c.training.plans.concat(c.training.plans_backup)) { assert.equal(p.data.clientId, fx.A1); assert.equal(p.data.coachId, fx.COACH_A); }
});

test('CE.2 clientId is authoritative; a display name is never an identity', async () => {
  const db = fx.build();
  const a2 = await ok(db, fx.COACH_A, fx.A2);
  assert.equal(a2.json('manifest.json').client_id, fx.A2);
  assert.deepEqual(a2.json('mesociclos.json').mesocycles.map(m => m.plan_id), ['P9']);
  const byName = await doExport(db, fx.COACH_A, 'Ana Pérez');                 // rules emulation: a non-existent doc is unreadable -> denied
  assert.equal(byName.ok, false); assert.equal(byName.code, 'PERMISSION_DENIED'); assert.equal(byName.bytes, undefined);
  const open = { getDoc: async (c, id) => (db[c] && db[c][id] ? { id, data: db[c][id] } : null), query: async () => [], listSub: async () => [] };
  assert.equal((await RUN.createExporter({ io: open, coachUid: fx.COACH_A }).run({ clientId: 'Ana Pérez' })).code, 'CLIENT_NOT_FOUND');
  for (const bad of ['', null, undefined, 'a/b', ' x', 42]) { const r = await doExport(db, fx.COACH_A, bad); assert.equal(r.ok, false); assert.equal(r.code, 'INVALID_INPUT'); }
});

test('CE.3 same-name clients (same and different coach) stay isolated', async () => {
  const db = fx.build();
  const a1 = await ok(db, fx.COACH_A, fx.A1), a2 = await ok(db, fx.COACH_A, fx.A2);
  for (const needle of ['NOTA-DE-A2-NO-FILTRAR', 'NOTA-SECRETA-A2', 'FP-DE-A2', 'Plan de A2', 'clientA2', 'ana2@example.test']) assert.ok(!a1.text.includes(needle), 'A1 leaked ' + needle);
  for (const needle of ['Revisar rodilla', 'ana1@example.test', 'Meso activo', 'Tendinopatía', 'clientA1']) assert.ok(!a2.text.includes(needle), 'A2 leaked ' + needle);
  assert.ok(a2.text.includes('NOTA-DE-A2-NO-FILTRAR'));
});

test('CE.4/CE.22 coach ownership enforced and permission failures fail closed (no archive)', async () => {
  const db = fx.build();
  const other = await doExport(db, fx.COACH_B, fx.A1);                       // rules: coach B cannot read clients/A1
  assert.equal(other.ok, false); assert.equal(other.code, 'PERMISSION_DENIED'); assert.equal(other.bytes, undefined);
  // Permissive adapter (rules bypassed by a buggy adapter): ownership gate still denies.
  const open = { getDoc: async (c, id) => ({ id, data: JSON.parse(JSON.stringify(db[c][id])) }), query: async () => [], listSub: async () => [] };
  const r = await RUN.createExporter({ io: open, coachUid: fx.COACH_B, now: () => NOW }).run({ clientId: fx.A1 });
  assert.equal(r.ok, false); assert.equal(r.code, 'OWNERSHIP_DENIED');
  db.clients.noCoach = { displayName: 'Sin coach' }; db.clients.emptyCoach = { coachId: '', displayName: 'x' }; db.clients.numCoach = { coachId: 5 };
  for (const id of ['noCoach', 'emptyCoach', 'numCoach']) { const x = await RUN.createExporter({ io: open, coachUid: fx.COACH_A, now: () => NOW }).run({ clientId: id }); assert.equal(x.code, 'OWNERSHIP_DENIED', id); }
  const wrongId = { getDoc: async (c, id) => ({ id: 'someoneElse', data: { coachId: fx.COACH_A } }), query: async () => [], listSub: async () => [] };
  assert.equal((await RUN.createExporter({ io: wrongId, coachUid: fx.COACH_A, now: () => NOW }).run({ clientId: fx.A1 })).code, 'OWNERSHIP_DENIED');
  for (const section of ['plans', 'plans_backup', 'logs', 'logs_mesos', 'fichas_onboarding', 'fichas_renovacion', 'fichas_publicas']) {
    const res = await doExport(db, fx.COACH_A, fx.A1, { denySection: section });
    assert.equal(res.ok, false, section); assert.equal(res.code, 'PERMISSION_DENIED', section); assert.equal(res.bytes, undefined);
  }
});

test('CE.5/CE.6 all historical + active mesocycles export; active plan prefers the authoritative root log over a stale snapshot', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1);
  const ms = r.json('mesociclos.json').mesocycles;
  assert.deepEqual(ms.map(m => [m.plan_id, m.order, m.is_active, m.entries_source]), [['P1', 1, false, 'mesos_snapshot'], ['P2', 2, true, 'logs_root']]);
  assert.equal(ms[1].alternate_snapshot_present, true); assert.equal(ms[0].name, 'Meso previo'); assert.equal(ms[1].weeks, 6); assert.equal(ms[1].current_week, 2);
  const logs = r.json('sesiones.json').exercise_logs;
  assert.equal(logs.find(l => l.entry_key === 'log_1_0_0_s0' && l.plan_id === 'P2').load, 60);          // not the stale snapshot's 1
  assert.ok(logs.some(l => l.plan_id === 'P1'));
  const ent = r.json('entrenamiento.json');
  assert.deepEqual(ent.plans.map(p => p.id), ['P1', 'P2']); assert.deepEqual(ent.plans_backup.map(p => p.id), ['BK1']);
  assert.ok(!r.text.includes('Legacy sin clientId'));
});

test('CE.7/CE.8/CE.15 session-by-session history: ordering, sets/reps/load/RIR, substitution, express, statuses', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1);
  const s = r.json('sesiones.json');
  assert.deepEqual(s.sessions.map(x => x.session_id), ['P1:w1:d0', 'P1:w1:d1', 'P1:w2:d0', 'P2:w1:d0', 'P2:w1:d1', 'P2:w2:d0', 'P2:w2:d1']);
  assert.deepEqual(s.sessions.map(x => x.completion.status), ['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'PARTIAL', 'AUTO_CLOSED_NO_DATA', 'PARTIAL']);
  const d0 = s.sessions[3];
  assert.equal(d0.day_label, 'Empuje'); assert.equal(d0.mesocycle_name, 'Meso activo'); assert.equal(d0.week, 1); assert.equal(d0.day_index, 0);
  assert.equal(d0.post_session.eimd, 2); assert.equal(d0.planned_exercises.length, 2); assert.equal(d0.planned_exercises[0].planned_sets, 2); assert.equal(d0.first_logged_at, '2026-02-02T10:00:00.000Z');
  assert.equal(d0.progression.recommendations[0].action, 'UP');
  const rec = s.exercise_logs.find(l => l.entry_key === 'log_1_0_0_s1' && l.plan_id === 'P2');
  assert.deepEqual([rec.load, rec.reps, rec.unit, rec.rir_prescribed, rec.rir_observed, rec.ics, rec.pump, rec.done, rec.timestamp, rec.prescription_exercise_id, rec.set_index],
    [60, 7, 'kg', 2, 0, 8, 2, true, '2026-02-02T10:05:00.000Z', 'P2-pid0', 1]);
  assert.equal(rec.raw.rir_real, 0);                                                                            // raw preserved
  const sub = s.exercise_logs.find(l => l.entry_key === 'log_1_1_0_s0' && l.plan_id === 'P2');
  assert.equal(sub.planned_exercise_name, 'Remo'); assert.equal(sub.performed_exercise_name, 'Remo con mancuerna'); assert.equal(sub.substituted, true);
  assert.equal(s.sessions[4].performed_exercises[0].substitution.nombre, 'Remo con mancuerna');
  assert.equal(s.exercise_logs.find(l => l.entry_key === 'log_2_1_0_s0').synthetic_express, true);
  assert.equal(s.exercise_logs.find(l => l.entry_key === 'log_2_1_0_s1').express_final, true);
  assert.equal(s.sessions[6].performed_exercises[0].skipped.reason, 'dolor');
  const order = id => s.sessions.findIndex(x => x.session_id === id);
  const seq = s.exercise_logs.map(l => [order(l.session_id), l.exercise_index, l.set_index]);
  assert.deepEqual(seq, seq.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]));   // logs follow session order, then exercise, then set
});

test('CE.9 notes keep type, source, timestamp, entity, mesocycle/session association; text with the word "token" is preserved', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1);
  const notes = r.json('notas.json').notes, by = t => notes.filter(n => n.type === t);
  const coach = by('coach_note')[0]; assert.equal(coach.source, 'clients.coachNote'); assert.equal(coach.timestamp, '2026-03-05T12:00:00.000Z'); assert.equal(coach.entity_id, fx.A1);
  assert.ok(coach.text.includes('"token" de acceso'));
  const pid = by('client_exercise_note')[0];
  assert.deepEqual([pid.plan_id, pid.mesocycle_id, pid.week, pid.day_index, pid.exercise_index, pid.prescription_exercise_id, pid.session_id, pid.exercise_name_snapshot, pid.source],
    ['P2', 'P2', 1, 0, 0, 'P2-pid0', 'P2:w1:d0', 'Press banca', 'logs.entries.exnotepid_1_P2-pid0']);
  assert.equal(by('client_exercise_note_mirror')[0].session_id, 'P2:w1:d0'); assert.equal(by('client_exercise_note_legacy')[0].week, null);
  assert.equal(by('session_feedback')[0].session_id, 'P2:w1:d0'); assert.ok(by('session_feedback')[0].text.includes('\n')); assert.equal(by('checkin_note')[0].week, 1);
  assert.equal(by('plan_note')[0].text, 'Calentar hombro'); assert.equal(by('coach_message_to_client')[0].text, 'Buen trabajo');
  assert.ok(new Set(notes.map(n => n.note_id)).size === notes.length);
  assert.ok(notes.length >= 8 && notes.every(n => typeof n.text === 'string'));    // individual records, not one collapsed string
});

test('CE.10 recovery history chronological with raw entries preserved; trends are separate and derived', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1);
  const rec = r.json('recuperacion.json');
  assert.deepEqual(rec.records.map(x => [x.type, x.week]), [['post_session', 1], ['weekly_checkin', 1], ['weekly_checkin', 2]]);
  assert.equal(rec.records[0].values.sleep, 7); assert.equal(rec.records[1].values.who5, 60);
  assert.equal(rec.derived_trends.who5.delta, 4); assert.equal(rec.derived_trends.who5.direction, 'UP');
  const c = r.json('vdsen-client-export-v1.json'); assert.equal(c.trends.derived, true); assert.equal(c.trends.bodyweight.first, 63);
  assert.equal(c.body_metrics.filter(b => b.type === 'inbody').length, 2);
});

test('CE.11 biomechanics exports stored fields verbatim (no inference, no nutrition restrictions)', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1);
  const b = r.json('biomecanica.json').biomechanics, keys = b.items.map(i => i.key);
  for (const k of ['lesiones', 'limitaciones', 'dolor_actual', 'ejercicios_evitar', 'ejercicios_favoritos', 'postura', 'movilidad']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('alimentos_evitar') && !keys.includes('restricciones_suplementos'));
  assert.equal(b.items.find(i => i.key === 'lesiones').value, 'Tendinopatía rotuliana izquierda'); assert.equal(b.items.find(i => i.key === 'lesiones').source, 'fichas_onboarding');
  assert.equal(b.available, true);
});

test('CE.12 ficha 360 exports onboarding, renewal and its own public form, including unknown future fields', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1);
  const f = r.json('ficha360.json').ficha_360;
  assert.equal(f.onboarding.document.data.campo_futuro, 'x'); assert.equal(f.onboarding.document.schemaVersion, '1.1'); assert.equal(f.onboarding.document.data.fotometria.circunferencias.cintura, 70); assert.equal(f.renewal.document.data.movilidad, 'Tobillo limitado');
  assert.deepEqual(f.public_forms.map(x => x.id), ['FP1']);
  const bm = r.json('metricas_corporales.json').records;
  assert.ok(bm.some(x => x.type === 'anthropometry') && bm.some(x => x.type === 'ficha_baseline'));
});

test('CE.13/CE.14 missing optional sections and an empty client still yield a valid archive with structured empties', async () => {
  const db = fx.build(); delete db.logs[fx.A1]; delete db.fichas_onboarding[fx.A1]; delete db.fichas_renovacion[fx.A1]; db['logs/' + fx.A1 + '/mesos'] = {};
  const r = await ok(db, fx.COACH_A, fx.A1);
  assert.equal(r.json('manifest.json').complete, true); assert.ok(r.json('manifest.json').empty_sections.includes('sesiones.json'));
  assert.ok(r.json('manifest.json').warnings.some(w => w.code === 'SECTION_EMPTY' && w.section === 'training.sessions'));
  const empty = fx.build(); empty.clients.fresh = { coachId: fx.COACH_A, displayName: 'Nuevo Cliente' };
  const e = await ok(empty, fx.COACH_A, 'fresh');
  const c = e.json('vdsen-client-export-v1.json');
  assert.deepEqual([c.training.sessions, c.training.mesocycles, c.training.exercise_logs, c.recovery, c.notes, c.body_metrics, c.media], [[], [], [], [], [], [], []]);
  assert.equal(c.adherence.overall.status, 'ADHERENCE_INSUFFICIENT_DATA'); assert.equal(c.nutrition.present, false); assert.equal(c.supplements.present, false);
  assert.equal(e.json('manifest.json').media_status.status, 'NOT_PRESENT');
  for (const n of Object.keys(e.files)) if (n.endsWith('.json')) JSON.parse(e.files[n].toString('utf8'));
  assert.equal(e.files['rendimiento_sesiones.csv'].toString('utf8').split('\r\n').filter(Boolean).length, 1);   // header only
});

test('CE.15b export is deterministic regardless of document/key insertion order', async () => {
  const a = fx.build(), b = fx.build();
  const rev = o => { const out = {}; Object.keys(o).reverse().forEach(k => { out[k] = o[k]; }); return out; };
  b.logs[fx.A1].entries = rev(b.logs[fx.A1].entries); b.plans = rev(b.plans); b.fichas_publicas = rev(b.fichas_publicas); b['logs/' + fx.A1 + '/mesos'] = rev(b['logs/' + fx.A1 + '/mesos']);
  const x = await ok(a, fx.COACH_A, fx.A1), y = await ok(b, fx.COACH_A, fx.A1);
  assert.deepEqual(Buffer.from(x.bytes), Buffer.from(y.bytes));
});

test('CE.16 derived analytics never mutate the normalized (raw) model', async () => {
  const raw = await COL.collect(fx.makeIo(fx.build(), fx.COACH_A), { clientId: fx.A1, coachUid: fx.COACH_A });
  const model = NORM.normalize(raw, {}); delete model._internal;
  const before = JSON.stringify(model);
  (function deepFreeze(o) { Object.freeze(o); Object.values(o).forEach(v => { if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); }); })(model);
  const d = DER.derive(model);                                  // 'use strict' + frozen input: any write throws
  assert.equal(JSON.stringify(model), before);
  assert.equal(d.adherence.derived, true); assert.equal(d.performance.derived, true);
  const p2 = d.adherence.by_mesocycle.find(m => m.plan_id === 'P2');
  assert.deepEqual([p2.planned_sessions_through_last_activity_week, p2.completed, p2.partial, p2.auto_closed_no_data, p2.missed_through_last_activity_week, p2.completion_rate_through_last_activity_week, p2.planned_sessions_full_plan], [4, 1, 2, 1, 1, 0.25, 12]);
  assert.equal(d.adherence.overall.planned, 8); assert.equal(d.adherence.overall.completed, 4); assert.equal(d.adherence.overall.completion_rate, 0.5);
  assert.deepEqual(p2.by_training_day.map(x => [x.day_index, x.day_label, x.completed, x.partial]), [[0, 'Empuje', 1, 0], [1, 'Tracción', 0, 2]]);
  const t = d.performance.totals;
  assert.equal(t.synthetic_express_sets_excluded, 1); assert.equal(t.undone_sets_excluded, 1); assert.equal(t.observed_sets, 9);
  const press = d.performance.exercises.find(e => e.exercise_name === 'Press banca').mesocycles.find(m => m.plan_id === 'P2');
  assert.equal(press.load_change_by_unit.kg.delta, 2.5); assert.equal(press.weeks[0].volume_load, 60 * 8 + 60 * 7);
  assert.equal(d.performance.session_summaries.find(s => s.session_id === 'P2:w1:d0').session_rpe, 8);
});

test('CE.16b adherence is never guessed: unknown plan structure / no evidence -> ADHERENCE_INSUFFICIENT_DATA', async () => {
  const db = fx.build(); delete db.plans.P1; delete db.plans_backup.BK1;               // P1 snapshot remains but its plan doc is gone
  const r = await ok(db, fx.COACH_A, fx.A1);
  const a = r.json('adherencia.json');
  const p1 = a.by_mesocycle.find(m => m.plan_id === 'P1');
  assert.equal(p1.status, 'ADHERENCE_INSUFFICIENT_DATA'); assert.equal(p1.reason, 'PLAN_STRUCTURE_UNKNOWN');
  assert.deepEqual(a.overall.excluded_mesocycles, [{ mesocycle_id: 'P1', reason: 'PLAN_STRUCTURE_UNKNOWN' }]);
  assert.ok(r.json('manifest.json').warnings.some(w => w.code === 'REFERENCED_PLAN_UNREADABLE' && w.id === 'P1'));   // real rules answer a missing plan with permission-denied
  assert.equal(r.json('manifest.json').complete, true);
  assert.ok(r.files['adherencia.csv'].toString('utf8').includes('ADHERENCE_INSUFFICIENT_DATA'));
});

test('CE.17/18/19/20 CSV: commas, quotes, newlines, Unicode, BOM/CRLF and formula guarding round-trip', async () => {
  const cells = ['a,b', 'say "hi"', 'línea1\nlínea2', 'cr\r\nlf', 'Ñandú — ½ 日本 😀', '', null, 12.5, true, '=1+1', '@x', '-abc', '-5'];
  const csv = SER.toCsv(['c' + 0, 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12'], [{ c0: cells[0], c1: cells[1], c2: cells[2], c3: cells[3], c4: cells[4], c5: cells[5], c6: cells[6], c7: cells[7], c8: cells[8], c9: cells[9], c10: cells[10], c11: cells[11], c12: cells[12] }]);
  assert.ok(csv.startsWith('﻿')); assert.ok(csv.includes('\r\n'));
  const rows = fx.parseCsv(csv); assert.equal(rows.length, 2); assert.equal(rows[1].length, 13);
  assert.deepEqual(rows[1], ['a,b', 'say "hi"', 'línea1\nlínea2', 'cr\r\nlf', 'Ñandú — ½ 日本 😀', '', '', '12.5', 'true', "'=1+1", "'@x", "'-abc", '-5']);
  const db = fx.build(); db.plans.P2.days[0].exercises[0].exerciseName = 'Press "inclinado", 30°\nmancuerna ñ';
  const r = await ok(db, fx.COACH_A, fx.A1);
  const table = fx.parseCsv(r.files['rendimiento_sesiones.csv'].toString('utf8')), hdr = table[0], row = table.find(x => x[hdr.indexOf('planned_exercise_name')].startsWith('Press "inclinado"'));
  assert.equal(row[hdr.indexOf('planned_exercise_name')], 'Press "inclinado", 30°\nmancuerna ñ'); assert.ok(table.every(x => x.length === hdr.length));
});

test('CE.20b Spanish/Unicode text survives inside the JSON and the ZIP as UTF-8', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1);
  const c = r.json('vdsen-client-export-v1.json');
  assert.equal(c.client.display_name, 'Ana Pérez'); assert.ok(c.notes.some(n => n.text === 'Hombro molesta, ñ')); assert.ok(r.text.includes('Tracción') && r.text.includes('ñandú'));
  assert.ok(!r.text.includes('\\u00'));        // written as real characters, not escapes
  assert.equal(c.client.profile.campoFuturoDesconocido.a[2].b, 'ñandú');
});

test('CE.21 duplicate clicks cannot launch duplicate export jobs', async () => {
  const io = fx.makeIo(fx.build(), fx.COACH_A), ex = RUN.createExporter({ io, coachUid: fx.COACH_A, now: () => NOW });
  const [a, b, c] = await Promise.all([ex.run({ clientId: fx.A1 }), ex.run({ clientId: fx.A1 }), ex.run({ clientId: fx.A2 })]);
  assert.deepEqual([a.ok, b.ok, c.ok], [true, false, false]); assert.equal(b.code, 'EXPORT_IN_PROGRESS'); assert.equal(c.code, 'EXPORT_IN_PROGRESS');
  assert.equal(io.calls.getDoc > 0 && io.calls.query, 3);                       // exactly ONE collection pass (plans, plans_backup, fichas_publicas)
  assert.equal(ex.busy, false);
  assert.equal((await ex.run({ clientId: fx.A2 })).ok, true);                  // usable again after completion
  const failing = RUN.createExporter({ io: fx.makeIo(fx.build(), fx.COACH_B), coachUid: fx.COACH_B });
  await failing.run({ clientId: fx.A1 }); assert.equal(failing.busy, false);     // released after a failure too
});

test('CE.22b non-permission read failures in optional sections degrade to warnings and mark the export incomplete', async () => {
  const db = fx.build(), io = fx.makeIo(db, fx.COACH_A), orig = io.getDoc;
  io.getDoc = async (c, id) => { if (c === 'fichas_renovacion') { const e = new Error('boom'); e.code = 'unavailable'; throw e; } return orig(c, id); };
  const res = await RUN.createExporter({ io, coachUid: fx.COACH_A, now: () => NOW }).run({ clientId: fx.A1 });
  assert.equal(res.ok, true); assert.equal(res.manifest.complete, false);
  assert.ok(res.manifest.warnings.some(w => w.code === 'SECTION_READ_FAILED' && w.section === 'fichas_renovacion')); assert.ok(res.manifest.warnings.some(w => w.code === 'EXPORT_INCOMPLETE'));
});

test('CE.23b adapter that ignores query filters still cannot leak foreign records (per-record ownership gate)', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1, { leak: true });
  for (const needle of ['NOTA-DE-B1-SECRETA', 'Plan de B1', 'Plan de A2', 'FP-DE-A2', 'FPB', 'BK9']) assert.ok(!r.text.includes(needle), needle);
  assert.ok(r.json('manifest.json').warnings.filter(w => w.code === 'FOREIGN_RECORD_DROPPED').length >= 3);
  assert.deepEqual(r.json('entrenamiento.json').plans.map(p => p.id), ['P1', 'P2']);
});

test('CE.24 secret protection: denylist targets keys/PEM values (not note text); final scan blocks leaks', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1);
  for (const s of ['SECRET-FCM', 'SECRET-API', 'SECRET-AT', 'BEGIN PRIVATE KEY', 'SIGNEDSECRET']) assert.ok(!r.text.includes(s) && !Buffer.concat(Object.values(r.files)).toString('latin1').includes(s), s);
  const c = r.json('vdsen-client-export-v1.json');
  assert.equal(c.client.profile.fcmToken, undefined); assert.equal(c.client.profile.nested.keep, 'ok'); assert.deepEqual(SEC.scanForSecrets(c), []);
  assert.ok(r.json('manifest.json').warnings.find(w => w.code === 'SECRET_FIELDS_REDACTED').paths.includes('nested.privateKey'));
  for (const k of ['privateKey', 'private_key', 'token', 'accessToken', 'refreshToken', 'authorization', 'cookie', 'secret', 'serviceAccount', 'clientSecret', 'apiKey', 'API_KEY', 'Access-Token', 'fcmToken', 'password']) assert.equal(SEC.isSecretKey(k), true, k);
  for (const k of ['coachNote', 'notas', 'tokenizer_notes_x', 'secretaria', 'displayName', 'exnote_1_0_0', 'log_1_0_0_s0', 'tokens_usados_dia']) assert.equal(SEC.isSecretKey(k), false, k);
  assert.deepEqual(SEC.scanForSecrets({ config: { serviceAccount: { private_key: 'x' } }, list: [{ apiKey: 'a' }], pem: '-----BEGIN RSA PRIVATE KEY-----' }).sort(), ['config.serviceAccount', 'list[0].apiKey', 'pem']);
  assert.deepEqual(SEC.scanForSecrets({ nota: 'te envío el token y la contraseña por WhatsApp' }), []);
  // Defense in depth: a secret that survives normalization (here via a warning record) aborts the whole export.
  const raw = await COL.collect(fx.makeIo(fx.build(), fx.COACH_A), { clientId: fx.A1, coachUid: fx.COACH_A });
  raw.warnings.push({ code: 'X', section: 'x', detail: 'y', apiKey: 'leaky' });
  assert.throws(() => RUN.buildArchive(raw, { now: NOW }), e => e.code === 'SECRET_SCAN_FAILED');
});

test('CE.25 media: inline images are bundled; URLs are REFERENCE ONLY (never fetched, signed query stripped); none -> NOT_PRESENT', async () => {
  const r = await ok(fx.build(), fx.COACH_A, fx.A1);
  const m = r.json('manifest.json');
  assert.deepEqual(m.media_status, { status: 'PARTIAL', bundled_count: 1, reference_only_count: 1 });
  assert.ok(m.warnings.some(w => w.code === 'MEDIA_REFERENCE_ONLY'));
  assert.deepEqual([...r.files['media/media-001.png'].slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const media = r.json('media.json').media, ref = media.find(x => x.kind === 'url_reference'), inl = media.find(x => x.kind === 'inline_data_uri');
  assert.equal(ref.bundled, false); assert.equal(ref.url, 'https://img.example.test/a1/front.jpg'); assert.equal(ref.signed_query_stripped, true);
  assert.equal(inl.bundled, true); assert.equal(inl.bundled_as, 'media/media-001.png'); assert.ok(!r.text.includes('iVBORw0KGgo'));
  const db = fx.build(); delete db.clients[fx.A1].foto_inline;
  const refOnly = await ok(db, fx.COACH_A, fx.A1);
  assert.equal(refOnly.json('manifest.json').media_status.status, 'REFERENCES_ONLY'); assert.ok(!Object.keys(refOnly.files).some(n => n.startsWith('media/')));
  delete db.clients[fx.A1].foto_frente;
  assert.equal((await ok(db, fx.COACH_A, fx.A1)).json('manifest.json').media_status.status, 'NOT_PRESENT');
});

test('CE.26 legacy / malformed / unknown client-domain data never crashes the export and unknown data is preserved', async () => {
  const db = fx.build();
  Object.assign(db.logs[fx.A1].entries, { log_3_0_0_s0: 'garbage', log_3_0_0_s1: null, done_3_0: 'yes', postsession_3_0: 'x', ci_sem_3: 5, exnotepid_3_zz: 7, exsub_3_0_0: 'str', exskip_3_0_0: null,
    log_3_9_9_s9: { carga: 'abc', reps: {}, ts: 'not a date', rir_real: 'x', done: 'true' }, 'weird key': { a: 1 }, nutrilog_bad: 1 });
  db.plans.P2.days.push(null); db.plans.P2.days[0].exercises.push({ sets: 'nope' }, null); db.plans.P2.createdAt = { seconds: 1767225600, nanoseconds: 0 };
  db.clients[fx.A1].inbodyResults.push('bad', null, { ts: 'nope' }); db.clients[fx.A1].coachNote = 12345; db.clients[fx.A1].nested = [new Date(0), undefined, NaN];
  db.clients[fx.A1].foto = { url: 'ftp://nope', data: 'data:text/plain;base64,AAAA' };
  const r = await ok(db, fx.COACH_A, fx.A1);
  const c = r.json('vdsen-client-export-v1.json');
  assert.ok(c.training.sessions.some(s => s.session_id === 'P2:w3:d0')); assert.equal(c.additional_client_data.unclassified_log_entries[0].entries['weird key'].a, 1);
  assert.equal(c.additional_client_data.unclassified_log_entries[0].entries.clave_rara_futura.z, 1);
  assert.equal(c.training.mesocycles.find(m => m.plan_id === 'P2').created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(c.client.profile.campoFuturoDesconocido.a[2].b, 'ñandú');
  for (const n of Object.keys(r.files)) if (n.endsWith('.json')) JSON.parse(r.files[n].toString('utf8'));
  // Unbound legacy root log (no planId): kept, flagged, never attributed to a plan.
  const legacy = fx.build(); delete legacy.logs[fx.A1].planId; delete legacy['logs/' + fx.A1 + '/mesos'].P2;
  const l = await ok(legacy, fx.COACH_A, fx.A1), lm = l.json('mesociclos.json').mesocycles;
  assert.ok(lm.some(m => m.plan_id === null && m.entries_source === 'logs_root_unbound')); assert.ok(l.json('manifest.json').warnings.some(w => w.code === 'LEGACY_LOG_UNBOUND'));
  assert.equal(l.json('adherencia.json').by_mesocycle.find(m => m.plan_id === null).reason, 'PLAN_STRUCTURE_UNKNOWN');
});

test('CE.27 nutrition and supplements are exported as stored (display + raw + client daily logs); PED data kept apart', async () => {
  const db = fx.build(); db.clients[fx.A1].pharmacoPlan = { protocolo: 'P1' };
  const r = await ok(db, fx.COACH_A, fx.A1);
  const n = r.json('nutricion.json').nutrition, s = r.json('suplementos.json').supplements;
  assert.equal(n.display.calorias, 2100); assert.equal(n.display.texto, 'Plan\nmuy,bueno "ok"'); assert.equal(n.raw.comidas[0].nombre, 'Desayuno'); assert.equal(n.client_daily_logs[0].date, '2026-02-03');
  assert.equal(s.raw.tiers[0].items[0].dosis, '5g');
  assert.equal(r.json('additional_client_data.json').additional_client_data.pharmacology.protocolo, 'P1');
  assert.deepEqual(r.json('cliente.json').client.fields_moved_to_other_sections.nutritionPlan, 'nutricion.json');
  const a2 = await ok(db, fx.COACH_A, fx.A2); assert.equal(a2.json('nutricion.json').nutrition.present, false);
});

test('CE.27b manifest.sensitive_sections lists pharmacology only when it is actually included', async () => {
  const db = fx.build();
  const withPed = await ok(db, fx.COACH_A, fx.A1);
  assert.deepEqual(withPed.json('manifest.json').sensitive_sections, ['pharmacology']);
  assert.equal(withPed.json('additional_client_data.json').additional_client_data.pharmacology.protocolo, 'P-SINTETICO');   // not redacted
  const without = await ok(db, fx.COACH_A, fx.A2);
  assert.deepEqual(without.json('manifest.json').sensitive_sections, []);
  db.clients[fx.A2].pharmacoPlan = {};
  assert.deepEqual((await ok(db, fx.COACH_A, fx.A2)).json('manifest.json').sensitive_sections, []);
});

test('CE.28 export is read-only/local: no write, network, Admin or upload primitives in the export modules', () => {
  const dir = path.join(__dirname, '..', 'assets', 'client-export');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const bad of [/setDoc\(/, /updateDoc\(/, /addDoc\(/, /deleteDoc\(/, /runTransaction\(/, /\bfetch\(/, /XMLHttpRequest/, /sendBeacon/, /firebase-admin/, /serviceAccount\s*[:=]/, /localStorage/, /\.upload\(/]) assert.ok(!bad.test(src), f + ' contains ' + bad);
  }
});

test('CE.29 UI trigger: confirmation copy, progress text, success/failure messages, no stack traces, duplicate guard', async () => {
  const mk = () => {
    const els = [];
    const el = tag => { const e = { tag, children: [], style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; }, remove() { this.removed = true; }, textContent: '', disabled: false }; els.push(e); return e; };
    const doc = { createElement: el, getElementById: () => null, body: { appendChild(c) { return c; } } };
    return { doc, els };
  };
  const toasts = [], downloads = [];
  let release; const gate = new Promise(r => { release = r; });
  const exporter = { busy: false, run: async () => { exporter.busy = true; await gate; exporter.busy = false; return { ok: true, filename: 'f.zip', bytes: new Uint8Array([1]) }; } };
  const w = mk();
  const dlg = UI.open({ clientId: fx.A1, clientName: 'Ana <b>Pérez</b>' }, { document: w.doc, exporter, toast: (m, e) => toasts.push([m, !!e]), download: (n, b) => downloads.push([n, b.length]) });
  const texts = w.els.map(e => e.textContent);
  assert.ok(texts.includes('Exportar cliente') && texts.includes('Cancelar') && texts.includes('Exportar') && texts.includes('Ana <b>Pérez</b>'));     // name as text, never HTML
  assert.ok(texts.includes('Se generará una copia completa de la información de este cliente. El archivo puede incluir datos sensibles como historial, métricas corporales, notas, recuperación y farmacología.'));
  const p = dlg.confirmButton.onclick(); await Promise.resolve();
  assert.equal(dlg.statusEl.textContent, 'Preparando exportación...'); assert.equal(dlg.confirmButton.disabled, true); assert.equal(dlg.cancelButton.disabled, true);
  dlg.confirmButton.onclick(); dlg.cancelButton.onclick(); assert.ok(!dlg.overlay.removed, 'cancel is inert while running');
  assert.equal(UI.open({ clientId: 'x' }, { document: mk().doc, exporter, toast: (m, e) => toasts.push([m, !!e]), download() {} }), null);   // second open while busy refused
  release(); await p;
  assert.deepEqual(downloads, [['f.zip', 1]]); assert.deepEqual(toasts[toasts.length - 1], ['Cliente exportado correctamente', false]); assert.ok(dlg.overlay.removed);
  // failure: raw error text never shown
  const bad = { busy: false, run: async () => { throw new Error('TypeError: x is not a function at Object.<anonymous> (/srv/app.js:1:1)'); } };
  const w2 = mk(), t2 = [];
  const d2 = UI.open({ clientId: 'c', clientName: 'N' }, { document: w2.doc, exporter: bad, toast: (m, e) => t2.push([m, !!e]), download() {} });
  await d2.confirmButton.onclick();
  assert.equal(d2.statusEl.textContent, 'La exportación no pudo completarse.'); assert.deepEqual(t2[t2.length - 1], ['La exportación no pudo completarse', true]);
  assert.equal(d2.confirmButton.disabled, false); assert.ok(!/TypeError|\.js/.test(d2.statusEl.textContent));
  const denied = { busy: false, run: async () => ({ ok: false, code: 'PERMISSION_DENIED', message: SEC.MESSAGES.PERMISSION_DENIED }) };
  const d3 = UI.open({ clientId: 'c', clientName: 'N' }, { document: mk().doc, exporter: denied, toast() {}, download() {} });
  await d3.confirmButton.onclick(); assert.ok(d3.statusEl.textContent.startsWith('La exportación no pudo completarse. No tienes permiso'));
});

test('CE.30 Coach wiring: button in the selected-client modal bound to that clientId; scripts loaded; nothing else in the app changed behaviourally', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
  assert.ok(html.includes('id="modalExportClientBtn"') && html.includes('Exportar cliente'));
  assert.ok(html.includes("_expBtn.onclick = () => _vdsenOpenClientExport(clientId, c.displayName || c.email || clientId)"));
  const order = ['util', 'security', 'collect', 'normalize', 'derive', 'media', 'serialize', 'zip', 'firestore-io', 'runner', 'ui'].map(n => html.indexOf('assets/client-export/' + n + '.js'));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), 'scripts present and in dependency order');
  const glue = html.slice(html.indexOf('function _vdsenClientExportIo'), html.indexOf('window._vdsenOpenClientExport'));
  for (const bad of ['setDoc', 'updateDoc', 'addDoc', 'deleteDoc', 'fetch(']) assert.ok(!glue.includes(bad), 'glue must be read-only: ' + bad);
  assert.ok(glue.includes('coachUid: currentCoach.uid') && glue.includes('exporter: _clientExporter'));
  assert.ok(!/NUMERIC_APPLY_ENABLED\s*=\s*true/.test(html));
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'assets', 'client-export'))) assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'client-export', f)));
});

function fakeDom() {
  const els = [];
  const el = tag => { const e = { tag, children: [], style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; }, remove() { this.removed = true; }, textContent: '', disabled: false }; els.push(e); return e; };
  return { doc: { createElement: el, getElementById: () => null, body: { appendChild(c) { return c; } } }, els };
}

test('CE.32 cancelling the confirmation performs no export; a double-click on Exportar starts exactly one job', async () => {
  let runs = 0, release; const gate = new Promise(r => { release = r; });
  const exporter = { busy: false, run: async () => { runs++; exporter.busy = true; await gate; exporter.busy = false; return { ok: true, filename: 'f.zip', bytes: new Uint8Array(1) }; } };
  const d = fakeDom(), toasts = [], dl = [];
  const env = { document: d.doc, exporter, toast: (m, e) => toasts.push([m, !!e]), download: (n) => dl.push(n) };
  const c = UI.open({ clientId: fx.A1, clientName: 'Ana' }, env);
  c.cancelButton.onclick();
  assert.equal(runs, 0); assert.ok(c.overlay.removed); assert.deepEqual(dl, []); assert.deepEqual(toasts, []);
  const c2 = UI.open({ clientId: fx.A1, clientName: 'Ana' }, env);
  const p1 = c2.confirmButton.onclick(), p2 = c2.confirmButton.onclick(), p3 = c2.confirmButton.onclick();
  release(); await Promise.all([p1, p2, p3]);
  assert.equal(runs, 1); assert.deepEqual(dl, ['f.zip']);
});

test('CE.33 export request carries exactly the dialog\'s clientId; failure states show friendly text only', async () => {
  const seen = [];
  const exporter = { busy: false, run: async req => { seen.push(req); return { ok: false, code: 'OWNERSHIP_DENIED', message: SEC.MESSAGES.OWNERSHIP_DENIED }; } };
  const d = fakeDom(), toasts = [];
  const c = UI.open({ clientId: 'client-xyz', clientName: 'Zoe' }, { document: d.doc, exporter, toast: (m, e) => toasts.push([m, !!e]), download() { throw new Error('must not download'); } });
  await c.confirmButton.onclick();
  assert.deepEqual(seen, [{ clientId: 'client-xyz' }]);
  assert.equal(c.statusEl.textContent, 'La exportación no pudo completarse. Este cliente no pertenece a tu cuenta de coach.');
  assert.ok(!/Error|at |\.js|stack/i.test(c.statusEl.textContent)); assert.equal(toasts[toasts.length - 1][1], true);
  assert.equal(c.confirmButton.disabled, false);
});

test('CE.34 button exists only in the selected-client modal: hidden by default, shown/bound only after that client loads, rebinding on navigation', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
  assert.equal((html.match(/id="modalExportClientBtn"/g) || []).length, 1);
  const tag = html.slice(html.indexOf('<button id="modalExportClientBtn"'), html.indexOf('</button>', html.indexOf('<button id="modalExportClientBtn"')));
  assert.ok(tag.includes('display:none'));
  const modalStart = html.indexOf('<div id="clientModal"'), modalEnd = html.indexOf('<div class="bottom-nav-mobile"');
  assert.ok(html.indexOf('id="modalExportClientBtn"') > modalStart && html.indexOf('id="modalExportClientBtn"') < modalEnd, 'inside the client modal only');
  assert.equal((html.match(/_vdsenOpenClientExport\(/g) || []).length, 2);          // definition + the single binding
  const fn = html.slice(html.indexOf('async function showClientDetail('), html.indexOf('async function showClientDetail(') + 6000);
  assert.ok(fn.indexOf('_detailClientId !== clientId') < fn.indexOf("const _expBtn = document.getElementById('modalExportClientBtn')"), 'bound after the stale-context guard');
  assert.ok(fn.includes("_expBtn.onclick = () => _vdsenOpenClientExport(clientId,"));
  assert.ok(fn.indexOf("_expReset.onclick = null") > 0 && fn.indexOf("_expReset.onclick = null") < fn.indexOf('_detailClientId !== clientId'), 'previous client binding is cleared before loading');
  const nav = html.slice(html.indexOf('function navClient('), html.indexOf('function navClient(') + 800);
  assert.ok(/showClientDetail\(/.test(nav), 'navigating to another client re-runs showClientDetail, rebinding the button to that client');
  const glue = html.slice(html.indexOf('function _vdsenOpenClientExport('), html.indexOf('window._vdsenOpenClientExport'));
  assert.ok(glue.includes('_clientExporterUid !== currentCoach.uid'), 'exporter is recreated when the signed-in coach changes');
});
