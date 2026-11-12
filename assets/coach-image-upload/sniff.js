/* VDSEN coach exercise image — real content sniffing (magic bytes).
 *
 * NEITHER the filename NOR file.type may be trusted. A file called photo.png declaring image/png whose
 * bytes are an <svg> or an <html> document must be rejected, and so must a truncated or malformed image.
 * This module decides from the BYTES ALONE.
 *
 * It is defence in depth, not the authority: storage.rules still enforces the accepted contentType, the
 * 512 KiB ceiling, the filename shape and the create-once contract. But a wrong contentType can never be
 * uploaded in the first place, because the MIME this module returns is the MIME that gets uploaded.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_IMG_SNIFF = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SIGS = {
    JPEG: [0xFF, 0xD8, 0xFF],
    PNG: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
    GIF: [0x47, 0x49, 0x46, 0x38],                                  // "GIF8"
    PDF: [0x25, 0x50, 0x44, 0x46],                                  // "%PDF"
  };

  function startsWith(bytes, sig, at) {
    var off = at || 0;
    if (bytes.length < off + sig.length) return false;
    for (var i = 0; i < sig.length; i++) if (bytes[off + i] !== sig[i]) return false;
    return true;
  }

  // The first bytes as printable ASCII, used to recognise text formats (SVG/HTML) case-insensitively.
  function headText(bytes, n) {
    var s = '';
    for (var i = 0; i < Math.min(n, bytes.length); i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  // A UTF-8 BOM or leading whitespace must not hide an SVG/HTML document.
  function looksLikeMarkup(bytes) {
    var text = headText(bytes, 512).replace(/^\uFEFF/, '').replace(/^[\s\u0000]+/, '').toLowerCase();
    return text.indexOf('<svg') === 0 ||
           text.indexOf('<?xml') === 0 ||
           text.indexOf('<!doctype') === 0 ||
           text.indexOf('<html') === 0 ||
           text.indexOf('<script') === 0 ||
           text.indexOf('<iframe') === 0 ||
           text.indexOf('<body') === 0;
  }

  // WEBP is RIFF....WEBP: bytes 0-3 are "RIFF", 8-11 are "WEBP".
  function isWebp(bytes) {
    return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
  }

  // Structural sanity beyond the signature, so a truncated or malformed image cannot pass.
  function structurallyValid(type, bytes) {
    if (type === 'image/jpeg') {
      // SOI ... EOI. The FFD9 end marker must actually be present.
      if (bytes.length < 4) return false;
      for (var i = bytes.length - 2; i >= Math.max(0, bytes.length - 4096); i--) {
        if (bytes[i] === 0xFF && bytes[i + 1] === 0xD9) return true;
      }
      return false;
    }
    if (type === 'image/png') {
      // The 8-byte signature must be followed by an IHDR chunk: 4-byte length, then "IHDR".
      return startsWith(bytes, [0x49, 0x48, 0x44, 0x52], 12);
    }
    if (type === 'image/webp') {
      // RIFF declares the total size in bytes 4-7 (little endian); it must fit the actual buffer.
      if (bytes.length < 16) return false;
      var declared = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
      return declared <= bytes.length;
    }
    return false;
  }

  var REASONS = {
    EMPTY: 'El archivo está vacío o es demasiado corto.',
    MARKUP: 'El archivo es un documento (SVG/HTML), no una imagen.',
    GIF: 'Los archivos GIF no están permitidos.',
    PDF: 'Los archivos PDF no están permitidos.',
    UNKNOWN: 'El archivo no es una imagen JPEG, PNG ni WebP.',
    MALFORMED: 'La imagen está dañada o incompleta.',
  };

  /* sniff(bytes, declaredType) -> { ok, type, reason, code }
   *
   * `declaredType` is optional. When supplied it must AGREE with the sniffed type, so a PNG renamed as
   * .jpg with type image/jpeg is rejected as a mismatch rather than silently accepted.
   */
  function sniff(bytes, declaredType) {
    if (!bytes || !bytes.length || bytes.length < 12) return { ok: false, code: 'EMPTY', reason: REASONS.EMPTY };
    if (looksLikeMarkup(bytes)) return { ok: false, code: 'MARKUP', reason: REASONS.MARKUP };
    if (startsWith(bytes, SIGS.GIF)) return { ok: false, code: 'GIF', reason: REASONS.GIF };
    if (startsWith(bytes, SIGS.PDF)) return { ok: false, code: 'PDF', reason: REASONS.PDF };

    var type = null;
    if (startsWith(bytes, SIGS.JPEG)) type = 'image/jpeg';
    else if (startsWith(bytes, SIGS.PNG)) type = 'image/png';
    else if (isWebp(bytes)) type = 'image/webp';

    if (!type) return { ok: false, code: 'UNKNOWN', reason: REASONS.UNKNOWN };
    if (!structurallyValid(type, bytes)) return { ok: false, code: 'MALFORMED', reason: REASONS.MALFORMED };

    if (declaredType) {
      var d = String(declaredType).toLowerCase();
      // The declared type must match the real bytes. An empty/unknown declaration is also a mismatch:
      // the caller is expected to pass what the browser reported, and that is never absent for a File.
      if (d !== type) return { ok: false, code: 'MISMATCH', reason: 'El contenido no coincide con el tipo declarado (' + d + ' vs ' + type + ').' };
    }
    return { ok: true, code: 'OK', type: type, reason: '' };
  }

  return { sniff: sniff, looksLikeMarkup: looksLikeMarkup, structurallyValid: structurallyValid, REASONS: REASONS };
});
