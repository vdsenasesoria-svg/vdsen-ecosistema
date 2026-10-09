/* VDSEN coach exercise image — validation.
 *
 * CLIENT-SIDE VALIDATION IS UX ONLY. storage.rules remain the authority: it independently enforces the
 * MIME set, the 512 KiB ceiling, the filename shape and the create-once contract. Nothing here may be
 * treated as a security boundary.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_IMG_VALIDATE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_BYTES = 512 * 1024;
  var ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
  // Explicitly named so the rejection message can be specific instead of a generic "unsupported".
  var REJECTED_NAMED = {
    'image/svg+xml': 'SVG',
    'text/html': 'HTML',
    'application/xhtml+xml': 'XHTML',
    'image/gif': 'GIF',
  };

  var MESSAGES = {
    EMPTY: 'El archivo está vacío.',
    TOO_BIG: 'La imagen supera el máximo de 512 KB.',
    SVG: 'Los archivos SVG no están permitidos.',
    HTML: 'Los archivos HTML no están permitidos.',
    XHTML: 'Los archivos XHTML no están permitidos.',
    GIF: 'Los archivos GIF no están permitidos.',
    UNSUPPORTED: 'Formato no admitido. Usá JPEG, PNG o WebP.',
  };

  // Validates the declared MIME type and the byte size.
  //
  // The declared type is what the browser reports and what the Storage rules will check as
  // request.resource.contentType, so the two agree by construction. The file EXTENSION is deliberately
  // not consulted: it is attacker-controlled and carries no authority.
  function validate(file) {
    if (!file) return { ok: false, code: 'EMPTY', message: MESSAGES.EMPTY };
    var type = String(file.type || '').toLowerCase();
    var size = Number(file.size);

    if (!(size > 0)) return { ok: false, code: 'EMPTY', message: MESSAGES.EMPTY };
    if (REJECTED_NAMED[type]) return { ok: false, code: 'REJECTED_TYPE', message: MESSAGES[REJECTED_NAMED[type]] };
    if (ACCEPTED.indexOf(type) === -1) return { ok: false, code: 'UNSUPPORTED', message: MESSAGES.UNSUPPORTED };
    if (size > MAX_BYTES) return { ok: false, code: 'TOO_BIG', message: MESSAGES.TOO_BIG };
    return { ok: true, code: 'OK', message: '', contentType: type, bytes: size };
  }

  return { validate: validate, MAX_BYTES: MAX_BYTES, ACCEPTED: ACCEPTED, MESSAGES: MESSAGES };
});
