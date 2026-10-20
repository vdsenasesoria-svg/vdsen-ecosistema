/* VDSEN Coach — expediente legible de la ficha (PDF local, solo lectura).
 * Complementa el ZIP vdsen-client-export-v1; NO exporta bitácoras ni pretende sustituir el archivo completo.
 * Las lecturas y la autorización las realiza Coach con la sesión Firebase existente.
 * El PDF únicamente utiliza datos proporcionados y saneados; no hay escrituras ni endpoints.
 */
(function(root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./security.js') : root.VDSEN_CE_SECURITY);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_CE_EXPEDIENTE_PDF = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Security) {
  'use strict';

  var LABELS = {
    displayName: 'Nombre', email: 'Correo electronico', phone: 'Telefono',
    nombre: 'Nombre', apellido: 'Apellido', fecha_nacimiento: 'Fecha de nacimiento',
    updatedAt: 'Fecha de actualizacion', createdAt: 'Fecha de registro'
  };
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function obj(o) { return o && typeof o === 'object' && !Array.isArray(o); }
  function readable(v) {
    if (v === null || v === undefined || v === '') return '';
    if (v === true) return 'Si';
    if (v === false) return 'No';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    if (typeof v === 'string') {
      if (/^data:(image|application)\//i.test(v)) return '[Archivo adjunto: consulte la ficha original]';
      return v;
    }
    return String(v);
  }
  function label(k) {
    return LABELS[k] || String(k).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, function(c) { return c.toUpperCase(); });
  }
  function rowsOf(source) {
    var result = [];
    function walk(v, prefix, depth) {
      if (v === null || v === undefined || v === '') return;
      if (depth > 12) { result.push({ label: prefix, value: '[Anidamiento excesivo: consultar ficha original]' }); return; }
      if (Array.isArray(v)) {
        if (!v.length) return;
        if (v.every(function(x) { return !Array.isArray(x) && !obj(x); })) {
          result.push({ label: prefix, value: v.map(readable).filter(Boolean).join(' · ') });
        } else {
          v.forEach(function(x, i) { walk(x, prefix + ' / ' + (i + 1), depth + 1); });
        }
        return;
      }
      if (obj(v)) {
        Object.keys(v).sort().forEach(function(k) {
          walk(v[k], prefix ? prefix + ' / ' + label(k) : label(k), depth + 1);
        });
        return;
      }
      var s = readable(v);
      if (s) result.push({ label: prefix, value: s });
    }
    walk(Security.sanitize(source), '', 0);
    return result;
  }

  function safeName(name) {
    var s = String(name || 'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 55);
    return s || 'cliente';
  }
  function formData(doc) { return doc && obj(doc.data) ? doc.data : null; }
  function publicPayload(doc) {
    var d = doc && doc.data;
    if (!obj(d)) return null;
    if (obj(d.data)) return d.data;
    if (obj(d.fichaData)) return d.fichaData;
    if (obj(d.respuestas)) return d.respuestas;
    // Public intake formats differ; omit ownership/status metadata, never include an unrelated document.
    var out = {};
    Object.keys(d).forEach(function(k) {
      if (!/^(coachId|clientUid|clientId|uid|status|createdAt|updatedAt|convertedAt)$/i.test(k)) out[k] = d[k];
    });
    return out;
  }
  function buildModel(input) {
    input = input || {};
    var c = input.client || {};
    var ficha = formData(input.onboarding) || formData(c.intake);
    var renovation = formData(input.renewal);
    var forms = (Array.isArray(input.publicForms) ? input.publicForms : []).map(publicPayload)
      .filter(function(v) { return v && Object.keys(v).length; });
    var sections = [];
    if (ficha && Object.keys(ficha).length) sections.push({ title: 'Ficha inicial / evaluacion', rows: rowsOf(ficha) });
    if (renovation && Object.keys(renovation).length) sections.push({ title: 'Ficha de renovacion', rows: rowsOf(renovation) });
    forms.forEach(function(f, i) { sections.push({ title: 'Ficha publica vinculada ' + (i + 1), rows: rowsOf(f) }); });
    var person = Security.sanitize({
      displayName: c.displayName || c.name || '',
      email: c.email || '',
      phone: c.phone || ''
    });
    return { name: person.displayName || 'Cliente', general: rowsOf(person), sections: sections };
  }
  function latin(s) {
    return String(s).replace(/[\u0000-\u0008\u000b\u000e-\u001f]/g, ' ')
      .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-')
      .replace(/\u2022/g, '-').replace(/\u2026/g, '...')
      .replace(/[^\u0009\u000a\u000d\u0020-\u00ff]/g, '?');
  }
  function renderPdf(model, PdfCtor, now) {
    if (!model || !Array.isArray(model.sections) || !model.sections.length) throw new Error('NO_FICHA');
    if (typeof PdfCtor !== 'function') throw new Error('PDF_UNAVAILABLE');
    var pdf = new PdfCtor({ unit: 'mm', format: 'a4' });
    var date = now instanceof Date ? now : new Date();
    var margin = 15, width = 180, y = 15, page = 0, bottom = 278;
    function pageHeader() {
      page++;
      pdf.setFillColor(10, 10, 10);
      pdf.rect(0, 0, 210, 35, 'F');
      pdf.setTextColor(183, 244, 0);
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(17);
      pdf.text('VDSEN  /  EXPEDIENTE', margin, 17);
      pdf.setTextColor(244, 244, 240);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
      pdf.text('Ficha de evaluacion - uso confidencial del Coach', margin, 25);
      y = 43;
    }
    function nextPage() { pdf.addPage(); pageHeader(); }
    function check(h) { if (y + h > bottom) nextPage(); }
    function wrap(value, fontSize) {
      pdf.setFontSize(fontSize);
      var s = latin(value);
      return pdf.splitTextToSize ? pdf.splitTextToSize(s, width) : [s];
    }
    function writeText(value, size, bold, ink, step) {
      pdf.setFont('helvetica', bold ? 'bold' : 'normal');
      pdf.setTextColor.apply(pdf, ink);
      var lines = wrap(value, size);
      for (var i = 0; i < lines.length; i++) {
        check(step); pdf.text(String(lines[i]), margin, y); y += step;
      }
    }
    function section(title, items) {
      check(18); y += 3;
      pdf.setFillColor(238, 242, 235); pdf.rect(margin, y - 5, width, 9, 'F');
      pdf.setTextColor(24, 31, 21); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
      pdf.text(latin(title), margin + 3, y + 1); y += 12;
      if (!items.length) { writeText('Sin datos registrados', 9, false, [95, 95, 95], 4.5); return; }
      items.forEach(function(row) {
        check(12);
        writeText(row.label + ':', 8.5, true, [55, 60, 55], 4.3);
        writeText(row.value, 9, false, [20, 22, 20], 4.8);
        y += 2.2;
      });
    }
    pageHeader();
    writeText(model.name, 14, true, [20, 22, 20], 6.2);
    writeText('Generado el ' + date.toLocaleDateString('es-MX') + '. Contiene datos registrados en la ficha; no sustituye el ZIP completo.', 8, false, [90, 90, 90], 4.5);
    section('Identificacion del cliente', model.general);
    model.sections.forEach(function(s) { section(s.title, s.rows); });
    var total = pdf.getNumberOfPages ? pdf.getNumberOfPages() : page;
    for (var p = 1; p <= total; p++) {
      pdf.setPage(p); pdf.setTextColor(110, 110, 110); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
      pdf.text('VDSEN - CONFIDENCIAL     |     ' + p + ' / ' + total, margin, 288);
    }
    return pdf;
  }
  function download(model, PdfCtor, date) {
    var when = date instanceof Date ? date : new Date();
    var pdf = renderPdf(model, PdfCtor, when);
    var stamp = when.toISOString().slice(0, 10);
    var filename = 'VDSEN_Expediente_' + safeName(model.name) + '_' + stamp + '.pdf';
    pdf.save(filename);
    return filename;
  }
  return { rowsOf: rowsOf, safeName: safeName, publicPayload: publicPayload, buildModel: buildModel, renderPdf: renderPdf, download: download };
});
