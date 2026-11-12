/* VDSEN client export — SERIALIZATION. Model + derived analytics -> JSON text and RFC 4180 CSV text. No I/O. */
(function(root, factory) {
  var api = factory(typeof require === 'function' && typeof module === 'object' ? require('./util.js') : root.VDSEN_CE_UTIL);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_CE_SERIALIZE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(U) {
  'use strict';

  var SCHEMA = 'vdsen-client-export-v1';

  function toJson(obj) { return JSON.stringify(obj, null, 2) + '\n'; }

  // RFC 4180: quote when the cell has , " CR or LF; double embedded quotes. Text cells that a spreadsheet would execute as a formula
  // (= + @ TAB CR, or - followed by a non-digit) get a leading apostrophe. Numbers/booleans/null are never altered.
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    var s = typeof v === 'string' ? v : JSON.stringify(v);
    if (/^[=+@\t\r]/.test(s) || /^-(?!\d)/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // UTF-8 BOM so spreadsheet tools keep Spanish accents; CRLF record separators per RFC 4180.
  function toCsv(columns, rows) {
    var lines = [columns.join(',')];
    rows.forEach(function(r) { lines.push(columns.map(function(c) { return csvCell(r[c]); }).join(',')); });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  var SET_COLUMNS = ['session_id', 'plan_id', 'week', 'day_index', 'day_label', 'exercise_index', 'prescription_exercise_id', 'planned_exercise_name', 'performed_exercise_name',
    'substituted', 'set_index', 'load', 'unit', 'reps', 'rir_prescribed', 'rir_observed', 'ics', 'pump', 'done', 'synthetic_express', 'express_final', 'timestamp'];
  function setRows(model) {
    var label = {};
    model.training.sessions.forEach(function(s) { label[s.session_id] = s.day_label; });
    return model.training.exercise_logs.map(function(r) { var o = {}; SET_COLUMNS.forEach(function(c) { o[c] = c === 'day_label' ? label[r.session_id] : r[c]; }); return o; });
  }
  var ADH_COLUMNS = ['mesocycle_id', 'week', 'planned', 'completed', 'partial', 'missed', 'completion_rate'];
  function adherenceRows(adh) {
    var rows = [];
    adh.by_mesocycle.forEach(function(m) {
      if (m.status !== 'OK') { rows.push({ mesocycle_id: m.mesocycle_id, week: 'ADHERENCE_INSUFFICIENT_DATA', planned: null, completed: null, partial: null, missed: null, completion_rate: null }); return; }
      m.by_week.forEach(function(w) { rows.push({ mesocycle_id: m.mesocycle_id, week: w.week, planned: w.planned, completed: w.completed, partial: w.partial, missed: w.missed, completion_rate: w.completion_rate }); });
    });
    return rows;
  }
  var BODY_COLUMNS = ['timestamp', 'type', 'source', 'plan_id', 'week', 'peso', 'hrv', 'who5', 'values_json'];
  function bodyRows(model) {
    return model.body_metrics.map(function(b) {
      var v = U.isObj(b.values) ? b.values : {};
      return { timestamp: b.timestamp, type: b.type, source: b.source, plan_id: b.plan_id, week: b.week, peso: v.peso === undefined ? null : v.peso, hrv: v.hrv === undefined ? null : v.hrv, who5: v.who5 === undefined ? null : v.who5, values_json: b.values };
    });
  }

  function dataRange(model) {
    var ts = [];
    model.training.exercise_logs.forEach(function(r) { if (r.timestamp) ts.push(r.timestamp); });
    model.recovery.forEach(function(r) { if (r.timestamp) ts.push(r.timestamp); });
    model.notes.forEach(function(r) { if (r.timestamp) ts.push(r.timestamp); });
    model.body_metrics.forEach(function(r) { if (r.timestamp) ts.push(r.timestamp); });
    ts.sort();
    return { from: ts.length ? ts[0] : null, to: ts.length ? ts[ts.length - 1] : null, basis: 'earliest/latest ISO timestamp among sets, recovery, notes and body metrics' };
  }

  // Canonical single-document export (vdsen-client-export-v1) + per-section files. `media` = { tree-extracted index }.
  function canonical(model, derived, media, meta) {
    return {
      schema: SCHEMA,
      export_metadata: { schema_version: 1, exported_at: meta.exported_at, client_id: meta.client_id, coach_id: meta.coach_id, source: 'VDSEN Coach', complete: meta.complete },
      client: model.client, ficha_360: model.ficha_360, biomechanics: model.biomechanics, body_metrics: model.body_metrics,
      training: model.training, performance: derived.performance, adherence: derived.adherence, trends: derived.trends,
      recovery: model.recovery, notes: model.notes, nutrition: model.nutrition, supplements: model.supplements,
      media: media.index, additional_client_data: model.additional_client_data, warnings: model.warnings
    };
  }
  function sectionFiles(c, model, derived) {
    function wrap(name, body) { var o = { schema: SCHEMA, section: name }; Object.keys(body).forEach(function(k) { o[k] = body[k]; }); return o; }
    return [
      ['cliente.json', wrap('cliente', { client: c.client })],
      ['ficha360.json', wrap('ficha_360', { ficha_360: c.ficha_360 })],
      ['biomecanica.json', wrap('biomechanics', { biomechanics: c.biomechanics })],
      ['metricas_corporales.json', wrap('body_metrics', { records: c.body_metrics, derived_bodyweight_trend: derived.trends.bodyweight })],
      ['entrenamiento.json', wrap('training', { current_week: c.training.current_week, plans: c.training.plans, plans_backup: c.training.plans_backup })],
      ['mesociclos.json', wrap('mesocycles', { mesocycles: c.training.mesocycles })],
      ['sesiones.json', wrap('sessions', { ordering: 'mesocycle order, week, day_index', sessions: c.training.sessions, exercise_logs: c.training.exercise_logs })],
      ['rendimiento.json', wrap('performance', c.performance)],
      ['adherencia.json', wrap('adherence', c.adherence)],
      ['recuperacion.json', wrap('recovery', { records: c.recovery, derived_trends: derived.trends.recovery })],
      ['notas.json', wrap('notes', { notes: c.notes })],
      ['nutricion.json', wrap('nutrition', { nutrition: c.nutrition })],
      ['suplementos.json', wrap('supplements', { supplements: c.supplements })],
      ['media.json', wrap('media', { media: c.media })],
      ['additional_client_data.json', wrap('additional_client_data', { additional_client_data: c.additional_client_data })]
    ];
  }
  function csvFiles(model, derived) {
    return [
      ['rendimiento_sesiones.csv', toCsv(SET_COLUMNS, setRows(model))],
      ['adherencia.csv', toCsv(ADH_COLUMNS, adherenceRows(derived.adherence))],
      ['metricas_corporales.csv', toCsv(BODY_COLUMNS, bodyRows(model))]
    ];
  }

  return { SCHEMA: SCHEMA, toJson: toJson, csvCell: csvCell, toCsv: toCsv, canonical: canonical, sectionFiles: sectionFiles, csvFiles: csvFiles, dataRange: dataRange,
    SET_COLUMNS: SET_COLUMNS, ADH_COLUMNS: ADH_COLUMNS, BODY_COLUMNS: BODY_COLUMNS };
});
