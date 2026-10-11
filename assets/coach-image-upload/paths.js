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
  // Firebase Auth uids are alphanumeric. Restricting them means a uid can never introduce a separator,
  // whitespace, a traversal sequence or a percent-encoded one into the object path.
  var COACH_RE = /^[A-Za-z0-9]{1,128}$/;

  function reject(code, message) { var e = new Error(message); e.code = code; return e; }

  // CSPRNG ONLY. There is deliberately NO Math.random fallback: a predictable object name would let an
  // attacker guess a path, and the whole replacement design leans on names being unguessable and unique.
  // With no crypto available the operation must FAIL CLOSED rather than degrade to weak randomness.
  // The crypto source is a parameter with a default so the fail-closed path is testable. Production
  // callers pass nothing and get the platform RNG exactly as before.
  function defaultCrypto() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') return globalThis.crypto;
    if (typeof require === 'function') {
      try { var wc = require('node:crypto').webcrypto; if (wc && typeof wc.getRandomValues === 'function') return wc; } catch (e) {}
    }
    return null;
  }

  function randomHex16(source) {
    var c = (source === undefined) ? defaultCrypto() : source;
    if (!c || typeof c.getRandomValues !== 'function') throw reject('NO_CRYPTO', 'crypto.getRandomValues no está disponible');
    var bytes = new Uint8Array(8);
    c.getRandomValues(bytes);
    var s = '';
    for (var j = 0; j < bytes.length; j++) s += ('0' + bytes[j].toString(16)).slice(-2);
    return s;   // 8 bytes -> exactly 16 lowercase hex characters
  }

  function isValidExerciseId(id) { return typeof id === 'string' && EXERCISE_RE.test(id); }
  function isValidCoachUid(id) { return typeof id === 'string' && COACH_RE.test(id); }

  // exercise-media/{coachUid}/{exerciseId}/image-<16 hex>
  //
  // Only the coach's own uid is ever used as the first segment, and the caller must pass the uid from
  // the live session - never anything read from the DOM or from a request body. Storage rules verify
  // both that this uid equals request.auth.uid AND that the exercise belongs to it.
  function buildPath(coachUid, exerciseId, hex) {
    if (!isValidCoachUid(coachUid)) throw reject('BAD_COACH_UID', 'coachUid inválido');
    if (!isValidExerciseId(exerciseId)) throw reject('BAD_EXERCISE_ID', 'exerciseId inválido');
    var name = hex ? String(hex) : randomHex16();
    if (!NAME_RE.test('image-' + name)) throw reject('BAD_NAME', 'nombre de objeto inválido');
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
    if (!isValidCoachUid(parts[1]) || !isValidExerciseId(parts[2])) return null;
    if (!NAME_RE.test(parts[3])) return null;
    return { coachUid: parts[1], exerciseId: parts[2], fileName: parts[3] };
  }

  function isManagedPathFor(p, coachUid, exerciseId) {
    var parsed = parsePath(p);
    return !!(parsed && parsed.coachUid === coachUid && parsed.exerciseId === exerciseId);
  }

  return {
    ROOT: ROOT, NAME_RE: NAME_RE, COACH_RE: COACH_RE,
    randomHex16: randomHex16, isValidExerciseId: isValidExerciseId, isValidCoachUid: isValidCoachUid,
    buildPath: buildPath, newPath: newPath, parsePath: parsePath, isManagedPathFor: isManagedPathFor,
  };
});
