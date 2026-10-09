/* VDSEN coach exercise image — versioned path + canonical reference helpers.
 *
 * The object path is IMMUTABLE: a path is written exactly once and a replacement is a NEW path. That is
 * what makes the replacement flow safe, and it is enforced independently by storage.rules via
 * `resource == null`.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_IMG_PATHS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ROOT = 'exercise-media';
  var NAME_RE = /^image-[a-f0-9]{16}$/;
  // exerciseId comes from a Firestore document id, never from a display name, and is restricted to a
  // conservative character set so it can never escape its segment.
  var EXERCISE_RE = /^[A-Za-z0-9_-]{1,128}$/;

  function randomHex16() {
    var bytes = new Uint8Array(8);
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto) ||
            (typeof require === 'function' ? (function () { try { return require('node:crypto').webcrypto; } catch (e) { return null; } })() : null);
    if (c && c.getRandomValues) c.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    var s = '';
    for (var j = 0; j < bytes.length; j++) s += ('0' + bytes[j].toString(16)).slice(-2);
    return s;   // 8 bytes -> exactly 16 lowercase hex characters
  }

  function isValidExerciseId(id) { return typeof id === 'string' && EXERCISE_RE.test(id); }

  // exercise-media/{coachUid}/{exerciseId}/image-<16 hex>
  //
  // Only the coach's own uid is ever used as the first segment, and the caller must pass the uid from
  // the live session - never anything read from the DOM or from a request body. Storage rules verify
  // both that this uid equals request.auth.uid AND that the exercise belongs to it.
  function buildPath(coachUid, exerciseId, hex) {
    if (!coachUid) throw new Error('coachUid requerido');
    if (!isValidExerciseId(exerciseId)) throw new Error('exerciseId inválido');
    var name = hex ? String(hex) : randomHex16();
    if (!NAME_RE.test('image-' + name)) throw new Error('nombre de objeto inválido');
    return ROOT + '/' + coachUid + '/' + exerciseId + '/image-' + name;
  }

  function newPath(coachUid, exerciseId) { return buildPath(coachUid, exerciseId, randomHex16()); }

  // A stored reference is only trusted when it is a canonical object path in THIS coach's and THIS
  // exercise's namespace. Anything else (a legacy external URL, an assets/ path, another coach) is not
  // treated as a managed object, so replacement never tries to delete something it does not own.
  function parsePath(p) {
    if (typeof p !== 'string') return null;
    var parts = p.split('/');
    if (parts.length !== 4) return null;
    if (parts[0] !== ROOT) return null;
    if (!parts[1] || !isValidExerciseId(parts[2])) return null;
    if (!NAME_RE.test(parts[3])) return null;
    return { coachUid: parts[1], exerciseId: parts[2], fileName: parts[3] };
  }

  function isManagedPathFor(p, coachUid, exerciseId) {
    var parsed = parsePath(p);
    return !!(parsed && parsed.coachUid === coachUid && parsed.exerciseId === exerciseId);
  }

  return {
    ROOT: ROOT, NAME_RE: NAME_RE,
    randomHex16: randomHex16, isValidExerciseId: isValidExerciseId,
    buildPath: buildPath, newPath: newPath, parsePath: parsePath, isManagedPathFor: isManagedPathFor,
  };
});
