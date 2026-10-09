(function (root) {
  'use strict';
  var MAX = 4000;
  function trim(value) { return String(value == null ? '' : value).trim(); }
  function mediaUrl(value) {
    var v = trim(value);
    if (!v) return '';
    if (/^https:\/\//i.test(v)) return v;
    if (/^assets\/[A-Za-z0-9_./-]+\.(svg|png|jpe?g|webp)$/i.test(v) && v.indexOf('..') === -1) return v;
    throw new Error('La imagen debe ser una URL HTTPS o un asset local válido.');
  }
  function text(value, label) {
    var v = trim(value);
    if (v.length > MAX) throw new Error(label + ' supera el límite permitido.');
    if (/[<>]/.test(v)) throw new Error(label + ' no admite HTML.');
    return v;
  }
  function list(value, label) {
    var items = String(value == null ? '' : value).split(/\r?\n/).map(function (x) { return text(x, label); }).filter(Boolean);
    if (items.length > 30) throw new Error(label + ' tiene demasiados elementos.');
    return items;
  }
  function variants(value) {
    var raw = trim(value);
    if (!raw) return [];
    var parsed;
    try { parsed = JSON.parse(raw); } catch (_) { throw new Error('Las variantes deben ser JSON válido.'); }
    if (!Array.isArray(parsed) || parsed.length > 30) throw new Error('Las variantes deben ser una lista válida.');
    return parsed.map(function (item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Cada variante debe ser un objeto.');
      var out = {};
      Object.keys(item).slice(0, 8).forEach(function (key) { out[text(key, 'La variante')] = text(item[key], 'La variante'); });
      return out;
    });
  }
  function buildPatch(input) {
    var source = input || {};
    var patch = {
      gym: text(source.gym, 'La sede'),
      equipment: text(source.equipment, 'El equipo'),
      assetRef: mediaUrl(source.assetRef),
      imageUrl: mediaUrl(source.imageUrl),
      instructions: text(source.instructions, 'Las instrucciones'),
      setup: text(source.setup, 'La preparación'),
      execution: text(source.execution, 'La ejecución'),
      technicalObjective: text(source.technicalObjective, 'El objetivo técnico'),
      commonErrors: list(source.commonErrors, 'Los errores comunes'),
      variants: variants(source.variants)
    };
    return patch;
  }
  root.VDSEN_VISUAL_METADATA_EDITOR = { buildPatch: buildPatch, mediaUrl: mediaUrl };
  if (typeof module === 'object' && module.exports) module.exports = root.VDSEN_VISUAL_METADATA_EDITOR;
})(typeof window !== 'undefined' ? window : globalThis);
