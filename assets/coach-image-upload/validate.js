/* VDSEN coach exercise image — validation.
 *
 * TWO DIFFERENT CEILINGS, deliberately:
 *   SOURCE    a photo from a phone can legitimately be 5-15 MiB, so the SOURCE cap is generous.
 *   PROCESSED the object that reaches Storage is re-encoded and must stay small.
 * Conflating them is what made the previous version reject every real phone photo.
 *
 *   SOURCE_MAX_BYTES    = 15 MiB   user-selected file
 *   PROCESSED_TARGET    = 350 KiB  what the pipeline aims for
 *   PROCESSED_HARD_CAP  = 480 KiB  pipeline refuses to upload above this
 *   STORAGE_SERVER_CAP  = 512 KiB  enforced independently by storage.rules
 *
 * CLIENT VALIDATION IS UX AND DEFENCE IN DEPTH ONLY. storage.rules remains the authorization and
 * security authority: it re-checks contentType, size, filename shape and create-once. Nothing here may
 * be treated as a security boundary.
 */
(function (root, factory) {
  var sniff = (typeof require === 'function') ? require('./sniff.js') : (root && root.VDSEN_IMG_SNIFF);
  var api = factory(sniff);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_IMG_VALIDATE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SNIFF) {
  'use strict';

  var SOURCE_MAX_BYTES = 15 * 1024 * 1024;
  var PROCESSED_TARGET_BYTES = 350 * 1024;
  var PROCESSED_HARD_CAP_BYTES = 480 * 1024;
  var STORAGE_SERVER_CAP_BYTES = 512 * 1024;
  var ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

  var MESSAGES = {
    EMPTY: 'El archivo está vacío.',
    TOO_BIG_SOURCE: 'La imagen original supera los 15 MB. Elegí una más liviana.',
    TOO_BIG_PROCESSED: 'No se pudo reducir la imagen lo suficiente. Probá con otra foto.',
    SVG: 'Los archivos SVG no están permitidos.',
    HTML: 'Los archivos HTML no están permitidos.',
    GIF: 'Los archivos GIF no están permitidos.',
    UNSUPPORTED: 'Formato no admitido. Usá JPEG, PNG o WebP.',
    NOT_IMAGE: 'El archivo no es una imagen válida.',
    MISMATCH: 'El archivo no coincide con su tipo declarado.',
    MALFORMED: 'La imagen está dañada o incompleta.',
  };

  // --- Stage 1: cheap checks before reading any bytes -------------------------
  // Size and declared type first, so a 40 MB file or an obvious SVG is rejected without reading it.
  function validateSourceFile(file) {
    if (!file) return { ok: false, code: 'EMPTY', message: MESSAGES.EMPTY };
    var size = Number(file.size);
    if (!(size > 0)) return { ok: false, code: 'EMPTY', message: MESSAGES.EMPTY };
    if (size > SOURCE_MAX_BYTES) return { ok: false, code: 'TOO_BIG_SOURCE', message: MESSAGES.TOO_BIG_SOURCE };
    // An empty declared type is NOT auto-rejected here: some browsers omit it for camera captures, and
    // the byte sniff below is the real decision. The sniff enforces the match when a type IS declared.
    return { ok: true, code: 'OK', message: '', declaredType: String(file.type || '').toLowerCase(), bytes: size };
  }

  // --- Stage 2: the byte-level decision ---------------------------------------
  function readBytes(file) {
    if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return Promise.reject(new Error('no-bytes'));
  }

  /* validateBytes(bytes, declaredType) -> { ok, code, message, type }
   *
   * The MIME returned here is the one that gets uploaded, so a mismatch between the name, the declared
   * type and the real content can never reach Storage.
   */
  function validateBytes(bytes, declaredType) {
    var s = SNIFF.sniff(bytes, declaredType);
    if (s.ok) return { ok: true, code: 'OK', message: '', type: s.type };
    var map = {
      MARKUP: MESSAGES.SVG, GIF: MESSAGES.GIF, PDF: MESSAGES.NOT_IMAGE,
      UNKNOWN: MESSAGES.UNSUPPORTED, MALFORMED: MESSAGES.MALFORMED,
      MISMATCH: MESSAGES.MISMATCH, EMPTY: MESSAGES.EMPTY,
    };
    // A markup document may be SVG or HTML; the sniff reason is more specific than a generic message.
    var msg = map[s.code] || s.reason || MESSAGES.NOT_IMAGE;
    if (s.code === 'MARKUP' && /html|doctype|script|body/i.test(s.reason || '')) msg = MESSAGES.HTML;
    return { ok: false, code: s.code, message: msg };
  }

  // Convenience: cheap checks plus the byte decision in one call.
  function validateSource(file) {
    var cheap = validateSourceFile(file);
    if (!cheap.ok) return Promise.resolve(cheap);
    return readBytes(file).then(function (bytes) {
      if (bytes.length === 0) return { ok: false, code: 'EMPTY', message: MESSAGES.EMPTY };
      if (bytes.length > SOURCE_MAX_BYTES) return { ok: false, code: 'TOO_BIG_SOURCE', message: MESSAGES.TOO_BIG_SOURCE };
      return validateBytes(bytes, cheap.declaredType);
    }, function () { return { ok: false, code: 'UNREADABLE', message: MESSAGES.NOT_IMAGE }; });
  }

  // --- Stage 3: the processed blob --------------------------------------------
  // The re-encode decides the real size, so this checks the actual output and refuses to upload anything
  // above the hard cap. The pipeline is expected to land under the target, not merely under the cap.
  function validateProcessedBlob(blob, declaredType) {
    if (!blob) return { ok: false, code: 'EMPTY', message: MESSAGES.EMPTY };
    var size = Number(blob.size);
    if (!(size > 0)) return { ok: false, code: 'EMPTY', message: MESSAGES.EMPTY };
    if (size > PROCESSED_HARD_CAP_BYTES) return { ok: false, code: 'TOO_BIG_PROCESSED', message: MESSAGES.TOO_BIG_PROCESSED, bytes: size };
    var type = String(declaredType || blob.type || '').toLowerCase();
    if (ACCEPTED.indexOf(type) === -1) return { ok: false, code: 'UNSUPPORTED', message: MESSAGES.UNSUPPORTED };
    return { ok: true, code: 'OK', message: '', type: type, bytes: size };
  }

  return {
    validateSourceFile: validateSourceFile,
    validateSource: validateSource,
    validateBytes: validateBytes,
    validateProcessedBlob: validateProcessedBlob,
    readBytes: readBytes,
    SOURCE_MAX_BYTES: SOURCE_MAX_BYTES,
    PROCESSED_TARGET_BYTES: PROCESSED_TARGET_BYTES,
    PROCESSED_HARD_CAP_BYTES: PROCESSED_HARD_CAP_BYTES,
    STORAGE_SERVER_CAP_BYTES: STORAGE_SERVER_CAP_BYTES,
    ACCEPTED: ACCEPTED,
    MESSAGES: MESSAGES,
  };
});
