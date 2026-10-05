/* VDSEN client export — ORCHESTRATION: authorize/collect -> normalize -> derive -> media -> serialize -> secret scan -> ZIP.
 * Local/download-only: returns bytes to the caller; performs no upload and no write of any kind. One export at a time (duplicate clicks are refused). */
(function(root, factory) {
  var isNode = typeof require === 'function' && typeof module === 'object';
  var api = factory(
    isNode ? require('./util.js') : root.VDSEN_CE_UTIL, isNode ? require('./security.js') : root.VDSEN_CE_SECURITY,
    isNode ? require('./collect.js') : root.VDSEN_CE_COLLECT, isNode ? require('./normalize.js') : root.VDSEN_CE_NORMALIZE,
    isNode ? require('./derive.js') : root.VDSEN_CE_DERIVE, isNode ? require('./media.js') : root.VDSEN_CE_MEDIA,
    isNode ? require('./serialize.js') : root.VDSEN_CE_SERIALIZE, isNode ? require('./zip.js') : root.VDSEN_CE_ZIP);
  if (isNode) module.exports = api;
  if (root) root.VDSEN_CLIENT_EXPORT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(U, S, C, N, D, M, Z, ZIP) {
  'use strict';

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function archiveName(displayName, now) { return 'VDSEN_' + U.safeName(displayName, 'cliente') + '_' + U.localDate(now) + '_export.zip'; }

  // Last fail-closed gate: nothing foreign may survive into the archive, whatever the adapter returned.
  function assertOwnedModel(model, clientId, coachId) {
    var bad = function(where) { throw S.ExportError('OWNERSHIP_DENIED', where); };
    if (model.client.client_id !== clientId || model.client.coach_id !== coachId) bad('client');
    model.training.plans.concat(model.training.plans_backup).forEach(function(p) {
      if (p.data.coachId !== coachId) bad('plan-coach');
      if (p.data.clientId !== undefined && p.data.clientId !== null && p.data.clientId !== clientId) bad('plan-client');
    });
    model.ficha_360.public_forms.forEach(function(f) { if (f.document.coachId !== coachId || f.document.clientUid !== clientId) bad('public-form'); });
    if (model.ficha_360.onboarding && model.ficha_360.onboarding.id !== clientId) bad('ficha');
    if (model.ficha_360.renewal && model.ficha_360.renewal.id !== clientId) bad('renewal');
  }

  // Pure: raw collection -> { filename, bytes, manifest, files }.
  function buildArchive(raw, opts) {
    var now = opts && opts.now instanceof Date ? opts.now : new Date();
    var model = N.normalize(raw, { now: now });
    assertOwnedModel(model, raw.client_id, raw.coach_id);
    delete model._internal;
    var derived = D.derive(model);
    var complete = Object.keys(raw.sections).every(function(k) { return raw.sections[k].status === 'ok'; });

    // Media extraction works on a private clone so the model/derived objects stay untouched.
    var meta = { exported_at: now.toISOString(), client_id: raw.client_id, coach_id: raw.coach_id, complete: complete };
    var working = { model: clone(model), derived: clone(derived) };
    var media = M.extract(working);
    var m2 = working.model, d2 = working.derived;
    if (media.status === 'REFERENCES_ONLY' || media.status === 'PARTIAL') m2.warnings.push({ code: 'MEDIA_REFERENCE_ONLY', section: 'media', detail: media.reference_only_count + ' media reference(s) preserved as URL only; NOT bundled in this archive' });
    if (!complete) m2.warnings.push({ code: 'EXPORT_INCOMPLETE', section: 'all', detail: 'one or more optional sections could not be read; see SECTION_READ_FAILED warnings' });

    var canon = Z.canonical(m2, d2, media, meta);
    var jsonFiles = [['vdsen-client-export-v1.json', canon]].concat(Z.sectionFiles(canon, m2, d2));
    // Secret scan over every JSON document; a hit blocks the whole export (fail closed).
    jsonFiles.forEach(function(f) { if (S.scanForSecrets(f[1]).length) throw S.ExportError('SECRET_SCAN_FAILED', f[0]); });

    var files = jsonFiles.map(function(f) { return { path: f[0], content: Z.toJson(f[1]) }; })
      .concat(Z.csvFiles(m2, d2).map(function(f) { return { path: f[0], content: f[1] }; }))
      .concat(media.files.map(function(f) { return { path: f.path, content: f.bytes }; }));
    files.forEach(function(f) { f.bytes = typeof f.content === 'string' ? ZIP.utf8(f.content).length : f.content.length; f.crc32 = ZIP.crc32(typeof f.content === 'string' ? ZIP.utf8(f.content) : f.content); });

    var counts = { plans: m2.training.plans.length, plans_backup: m2.training.plans_backup.length, mesocycles: m2.training.mesocycles.length, sessions: m2.training.sessions.length,
      exercise_logs: m2.training.exercise_logs.length, body_metrics: m2.body_metrics.length, recovery: m2.recovery.length, notes: m2.notes.length,
      nutrition_daily_logs: m2.nutrition.client_daily_logs.length, public_forms: m2.ficha_360.public_forms.length, media: media.index.length, warnings: m2.warnings.length };
    var has = {
      'cliente.json': true, 'ficha360.json': !!(m2.ficha_360.onboarding || m2.ficha_360.renewal || m2.ficha_360.public_forms.length), 'biomecanica.json': m2.biomechanics.available,
      'metricas_corporales.json': m2.body_metrics.length > 0, 'entrenamiento.json': m2.training.plans.length > 0, 'mesociclos.json': m2.training.mesocycles.length > 0,
      'sesiones.json': m2.training.sessions.length > 0, 'rendimiento.json': m2.training.exercise_logs.length > 0, 'adherencia.json': d2.adherence.overall.status === 'OK',
      'recuperacion.json': m2.recovery.length > 0, 'notas.json': m2.notes.length > 0, 'nutricion.json': m2.nutrition.present, 'suplementos.json': m2.supplements.present, 'media.json': media.index.length > 0
    };
    var manifest = {
      schema: Z.SCHEMA, schema_version: 1, exported_at: meta.exported_at, client_id: raw.client_id, coach_id: raw.coach_id,
      client_display_name: m2.client.display_name, complete: complete,
      included_sections: Object.keys(has).filter(function(k) { return has[k]; }), empty_sections: Object.keys(has).filter(function(k) { return !has[k]; }),
      record_counts: counts, data_range: Z.dataRange(m2), mesocycle_count: counts.mesocycles, session_count: counts.sessions,
      media_status: { status: media.status, bundled_count: media.bundled_count, reference_only_count: media.reference_only_count },
      warnings: m2.warnings,
      files: files.map(function(f) { return { path: f.path, bytes: f.bytes, crc32: ('00000000' + f.crc32.toString(16)).slice(-8) }; })
    };
    if (S.scanForSecrets(manifest).length) throw S.ExportError('SECRET_SCAN_FAILED', 'manifest.json');
    var all = [{ path: 'manifest.json', content: Z.toJson(manifest) }].concat(files.map(function(f) { return { path: f.path, content: f.content }; }));
    var bytes = ZIP.build(all, now);
    return { filename: archiveName(m2.client.display_name, now), bytes: bytes, manifest: manifest, entries: all };
  }

  function createExporter(cfg) {
    var state = { busy: false };
    return {
      get busy() { return state.busy; },
      // Resolves { ok:true, filename, bytes, manifest } or { ok:false, code, message } (never throws raw technical errors to the UI).
      run: async function(req) {
        if (state.busy) return { ok: false, code: 'EXPORT_IN_PROGRESS', message: S.MESSAGES.EXPORT_IN_PROGRESS };
        state.busy = true;
        try {
          var raw = await C.collect(cfg.io, { clientId: req && req.clientId, coachUid: cfg.coachUid });
          var out = buildArchive(raw, { now: cfg.now ? cfg.now() : new Date() });
          return { ok: true, filename: out.filename, bytes: out.bytes, manifest: out.manifest };
        } catch (e) {
          var code = e && e.isExportError ? e.code : 'EXPORT_FAILED';
          return { ok: false, code: code, message: (e && e.isExportError ? e.userMessage : S.MESSAGES.EXPORT_FAILED) };
        } finally { state.busy = false; }
      }
    };
  }

  return { createExporter: createExporter, buildArchive: buildArchive, archiveName: archiveName };
});
