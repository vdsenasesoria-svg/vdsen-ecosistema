/* VDSEN Coach · expediente de UN cliente, UN TXT. Solo lectura.
 * Reutiliza collect.js (aislamiento), normalize.js (proveniencia) y derive.js (rendimiento).
 * No contiene secretos, mediciones inferidas, PDFs, ZIPs, farmacología ni otros clientes.
 */
(function(root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(isNode ? require('./security.js') : root.VDSEN_CE_SECURITY,
    isNode ? require('./normalize.js') : root.VDSEN_CE_NORMALIZE,
    isNode ? require('./derive.js') : root.VDSEN_CE_DERIVE);
  if (isNode) module.exports = api;
  if (root) root.VDSEN_CE_EXPEDIENTE_TXT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(S, N, D) {
  'use strict';
  var SCHEMA = 'vdsen-expediente-4-secciones-v1';
  var OMIT_OPERATIONAL = /^(coachId|clientId|clientUid|uid|id|status|createdAt|updatedAt|updatedBy|convertedAt|schemaVersion)$/;
  function isObj(o) { return o && typeof o === 'object' && !Array.isArray(o); }
  function safeName(value) {
    var s = String(value || 'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
    return s || 'cliente';
  }
  function dataFromDocument(wrapped) {
    if (!wrapped || !isObj(wrapped.document)) return null;
    var d = wrapped.document;
    // Documento íntegro de datos de formulario (no solo los campos que conoce el Coach).
    // Solo se retira metadata operacional; todo campo capturado queda sin recortar.
    var out = {};
    Object.keys(d).forEach(function(k) {
      if (OMIT_OPERATIONAL.test(k)) return;
      out[k] = d[k];
    });
    return Object.keys(out).length ? out : null;
  }
  function makeFicha(model, raw) {
    var f = model.ficha_360;
    var source = {
      ficha_inicial: dataFromDocument(f.onboarding),
      ficha_renovacion: dataFromDocument(f.renewal),
      fichas_publicas_vinculadas: f.public_forms.map(dataFromDocument).filter(Boolean)
    };
    // Legacy fallback if the only intake is stored on clients/{uid}.intake.
    if (!source.ficha_inicial && raw.client && raw.client.data &&
        isObj(raw.client.data.intake) && isObj(raw.client.data.intake.data))
      source.ficha_inicial = S.sanitize(raw.client.data.intake.data);
    return source;
  }
  function activeMesocycle(model, planId) {
    if (!planId) return null;
    return model.training.mesocycles.find(function(m) { return m.plan_id === planId; }) || null;
  }
  function performanceFor(model, derived, planId) {
    var active = activeMesocycle(model, planId);
    if (!active) return { estado: 'SIN_MESOCICLO_ACTIVO_LEGIBLE', mesociclo: null, sesiones: [], resumen_de_sesiones: [], series_ejecutadas_y_registradas: [], rendimiento_por_ejercicio: [], notas_del_mesociclo: [] };
    var byExercise = derived.performance.exercises.map(function(e) {
      var meso = e.mesocycles.filter(function(m) { return m.plan_id === planId; });
      return meso.length ? { ejercicio: e.exercise_name, progreso: meso } : null;
    }).filter(Boolean);
    return {
      estado: 'DATOS_REALES_DEL_MESOCICLO_ACTIVO',
      mesociclo: active,
      sesiones: model.training.sessions.filter(function(s) { return s.plan_id === planId; }),
      resumen_de_sesiones: derived.performance.session_summaries.filter(function(s) { return s.plan_id === planId; }),
      series_ejecutadas_y_registradas: model.training.exercise_logs.filter(function(e) { return e.plan_id === planId; }),
      rendimiento_por_ejercicio: byExercise,
      notas_del_mesociclo: model.notes.filter(function(n) { return n.plan_id === planId; })
    };
  }
  function relevantReadFailure(raw) {
    var required = { logs: 1, logs_mesos: 1, plans: 1, plans_by_reference: 1,
      fichas_onboarding: 1, fichas_renovacion: 1, fichas_publicas: 1 };
    return Object.keys(raw.sections || {}).filter(function(s) { return required[s] && raw.sections[s].status !== 'ok'; });
  }
  function build(raw, opts) {
    opts = opts || {};
    S.validateIds(raw && raw.client_id, raw && raw.coach_id);
    S.authorizeClient(raw.client, raw.client_id, raw.coach_id);
    var failures = relevantReadFailure(raw);
    if (failures.length) throw S.ExportError('EXPORT_FAILED', 'incomplete-read');
    var model = N.normalize(raw, { now: opts.now || new Date() });
    if (model.client.client_id !== raw.client_id || model.client.coach_id !== raw.coach_id)
      throw S.ExportError('OWNERSHIP_DENIED');
    // Secondary checks on any Firestore-adapter returned public data.
    model.ficha_360.public_forms.forEach(function(f) {
      if (!f.document || f.document.coachId !== raw.coach_id || f.document.clientUid !== raw.client_id)
        throw S.ExportError('OWNERSHIP_DENIED');
    });
    var derived = D.derive(model);
    var fields = {
      'FICHA 360 - RESPUESTAS REGISTRADAS': makeFicha(model, raw),
      'BIOMECÁNICA - DATOS REGISTRADOS': model.biomechanics.available ? model.biomechanics.items : null,
      'ANTROPOMETRÍA Y COMPOSICIÓN CORPORAL': model.body_metrics.length ? model.body_metrics : null,
      'RENDIMIENTO DEL MESOCICLO ACTIVO': performanceFor(model, derived, raw.active_plan_id)
    };
    var when = opts.now instanceof Date ? opts.now : new Date();
    // No se filtra el texto: se conservan todas las respuestas; los secretos fueron saneados en normalize.
    if (S.scanForSecrets(fields).length) throw S.ExportError('SECRET_SCAN_FAILED');
    var pieces = [
      'VDSEN | EXPEDIENTE DEL CLIENTE',
      'Formato: ' + SCHEMA,
      'Nombre: ' + String(model.client.display_name || 'Sin nombre registrado'),
      'Fecha de exportación: ' + when.toISOString(),
      'Mesociclo activo: ' + (raw.active_plan_id || 'No registrado'),
      'DATOS CONFIDENCIALES. Archivo único de solo lectura.',
      'Las ausencias se indican explícitamente. No se crean mediciones ni diagnósticos.'
    ];
    Object.keys(fields).forEach(function(key, i) {
      var value = fields[key];
      var missing = value === null || (i === 0 && !value.ficha_inicial && !value.ficha_renovacion && !value.fichas_publicas_vinculadas.length);
      pieces.push('', '='.repeat(70), String(i + 1) + '. ' + key, '='.repeat(70),
        missing ? 'SIN DATOS REGISTRADOS' : JSON.stringify(value, null, 2));
    });
    var text = pieces.join('\n') + '\n';
    return { text: text, filename: 'VDSEN_Expediente_' + safeName(model.client.display_name) + '_' + when.toISOString().slice(0, 10) + '.txt',
      sections: Object.keys(fields).length, schema: SCHEMA };
  }
  function download(doc, win, filename, value) {
    var blob = new win.Blob(['\uFEFF', value], { type: 'text/plain;charset=utf-8' });
    var url = win.URL.createObjectURL(blob), a = doc.createElement('a');
    try { a.href = url; a.download = filename; doc.body.appendChild(a); a.click(); doc.body.removeChild(a); }
    finally { win.setTimeout(function() { win.URL.revokeObjectURL(url); }, 4000); }
  }
  return { SCHEMA: SCHEMA, build: build, download: download, safeName: safeName, relevantReadFailure: relevantReadFailure };
});
