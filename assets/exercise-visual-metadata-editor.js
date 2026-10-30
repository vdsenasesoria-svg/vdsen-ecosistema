(function (root) {
  'use strict';
  var MAX = 4000;
  // Canonical managed Storage object path produced by assets/coach-image-upload/paths.js.
  var STORAGE_REF_RE = /^exercise-media\/[A-Za-z0-9]{1,128}\/[A-Za-z0-9_-]{1,128}\/image-[a-f0-9]{16}$/;
  // Legacy local asset reference kept working unchanged.
  var ASSET_RE = /^assets\/[A-Za-z0-9_./-]+\.(svg|png|jpe?g|webp)$/i;

  function trim(value) { return String(value == null ? '' : value).trim(); }

  // A canonical managed Storage path. Exposed so callers can tell "this object is ours and may be
  // replaced/deleted" from "this is a legacy reference we must leave alone".
  function isStorageRef(value) {
    var v = trim(value);
    return !!v && v.indexOf('..') === -1 && STORAGE_REF_RE.test(v);
  }

  // HTTPS reference, used for imageUrl. Deliberately strict and unchanged in intent.
  function mediaUrl(value) {
    var v = trim(value);
    if (!v) return '';
    if (/^https:\/\//i.test(v)) return v;
    var asset = ASSET_RE.test(v) && v.indexOf('..') === -1;
    if (asset) return v;
    throw new Error('La imagen debe ser una URL HTTPS o un asset local válido.');
  }

  /* assetRef(value) - the canonical object reference.
   *
   * Previously assetRef was routed through mediaUrl(), which does NOT accept `exercise-media/...`.
   * That meant saving an uploaded image threw, so uploads could never be persisted at all. This
   * accepts exactly three shapes and nothing else:
   *   ''                         no image
   *   exercise-media/{u}/{ex}/image-<16 hex>   managed, replaceable, deletable
   *   assets/...                 legacy local asset, never Storage-deleted
   * It does NOT broaden into arbitrary paths: no other prefix, no traversal, no free-form string.
   */
  function assetRef(value) {
    var v = trim(value);
    if (!v) return '';
    if (v.indexOf('..') !== -1) throw new Error('La referencia de imagen no es válida.');
    if (isStorageRef(v)) return v;
    if (ASSET_RE.test(v)) return v;
    throw new Error('La referencia de imagen debe ser un objeto gestionado o un asset local válido.');
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
    return {
      gym: text(source.gym, 'La sede'),
      equipment: text(source.equipment, 'El equipo'),
      // assetRef uses its own validator; imageUrl keeps the strict HTTPS/asset rule.
      assetRef: assetRef(source.assetRef),
      imageUrl: mediaUrl(source.imageUrl),
      instructions: text(source.instructions, 'Las instrucciones'),
      setup: text(source.setup, 'La preparación'),
      execution: text(source.execution, 'La ejecución'),
      technicalObjective: text(source.technicalObjective, 'El objetivo técnico'),
      commonErrors: list(source.commonErrors, 'Los errores comunes'),
      variants: variants(source.variants)
    };
  }
  root.VDSEN_VISUAL_METADATA_EDITOR = {
    buildPatch: buildPatch, mediaUrl: mediaUrl, assetRef: assetRef, isStorageRef: isStorageRef,
  };
  if (typeof module === 'object' && module.exports) module.exports = root.VDSEN_VISUAL_METADATA_EDITOR;
})(typeof window !== 'undefined' ? window : globalThis);
