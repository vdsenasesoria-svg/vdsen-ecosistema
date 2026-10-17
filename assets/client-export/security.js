/* VDSEN client export — ownership contract + secret / internal-field protection.
 *
 * Ownership: the authoritative tenant link of a client is clients/{clientId}.coachId (same rule as firestore.rules `ownsClient`).
 * The export is keyed by clientId ONLY (never by display name) and FAILS CLOSED when ownership is missing, ambiguous or different.
 *
 * Secret protection targets KEY NAMES and credential-shaped VALUES (PEM private keys), never free text: a note that says
 * "te mando el token por WhatsApp" is user content and is preserved.
 */
(function(root, factory) {
  var api = factory(typeof require === 'function' && typeof module === 'object' ? require('./util.js') : root.VDSEN_CE_UTIL);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_CE_SECURITY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(U) {
  'use strict';

  var MESSAGES = {
    INVALID_INPUT: 'Solicitud de exportación inválida.',
    CLIENT_NOT_FOUND: 'El cliente no existe.',
    OWNERSHIP_DENIED: 'Este cliente no pertenece a tu cuenta de coach.',
    PERMISSION_DENIED: 'No tienes permiso para leer todos los datos de este cliente.',
    SECRET_SCAN_FAILED: 'La exportación fue bloqueada por seguridad.',
    EXPORT_IN_PROGRESS: 'Ya hay una exportación en curso.',
    EXPORT_FAILED: 'La exportación no pudo completarse.'
  };
  function ExportError(code, detail) {
    var e = new Error(code + (detail ? ': ' + detail : ''));
    e.name = 'ExportError'; e.code = code; e.userMessage = MESSAGES[code] || MESSAGES.EXPORT_FAILED; e.isExportError = true;
    return e;
  }

  var SECRET_EXACT = {
    privatekey: 1, privatekeyid: 1, token: 1, tokens: 1, accesstoken: 1, refreshtoken: 1, idtoken: 1, sessiontoken: 1, authtoken: 1,
    authorization: 1, cookie: 1, cookies: 1, secret: 1, secrets: 1, serviceaccount: 1, serviceaccountkey: 1, clientsecret: 1,
    apikey: 1, apisecret: 1, password: 1, passwd: 1, contrasena: 1, bearer: 1, credentials: 1, credential: 1
  };
  function normKey(k) { return String(k).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function isSecretKey(key) {
    var n = normKey(key);
    if (!n) return false;
    if (SECRET_EXACT[n]) return true;
    if (/(token|secret|apikey|password|privatekey|passwd)$/.test(n)) return true;
    return n.indexOf('serviceaccount') !== -1;
  }
  // Credential-shaped VALUES (PEM blocks). Deliberately narrow: ordinary text is never matched.
  var PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
  function isSecretValue(v) { return typeof v === 'string' && PEM_RE.test(v); }

  function sortedKeys(o) { return Object.keys(o).sort(); }

  // Deep, JSON-safe, key-sorted copy. Drops secret keys / PEM values, converts Timestamps/Dates to ISO strings,
  // NaN/Infinity -> null, functions/undefined dropped. `ctx.redactions` collects PATHS only (never values).
  function sanitize(value, ctx) {
    ctx = ctx || { redactions: [] };
    var seen = [];
    function walk(v, path, depth) {
      if (v === null || v === undefined) return v === undefined ? undefined : null;
      var t = typeof v;
      if (t === 'string') { if (isSecretValue(v)) { ctx.redactions.push(path); return '[REDACTED]'; } return v; }
      if (t === 'number') return isFinite(v) ? v : null;
      if (t === 'boolean') return v;
      if (t === 'function' || t === 'symbol') return undefined;
      if (t === 'bigint') return String(v);
      if (v instanceof Date) { var d = U.toIso(v); return d; }
      if (depth > 60) { ctx.redactions.push(path + '#depth'); return null; }
      if (seen.indexOf(v) !== -1) { ctx.redactions.push(path + '#cycle'); return null; }
      if (!Array.isArray(v) && (typeof v.toMillis === 'function' || (typeof v.seconds === 'number' && typeof v.nanoseconds === 'number'))) return U.toIso(v);
      seen.push(v);
      var out;
      if (Array.isArray(v)) {
        out = v.map(function(x, i) { var r = walk(x, path + '[' + i + ']', depth + 1); return r === undefined ? null : r; });
      } else {
        out = {};
        sortedKeys(v).forEach(function(k) {
          var p = path ? path + '.' + k : k;
          if (isSecretKey(k)) { ctx.redactions.push(p); return; }
          var r = walk(v[k], p, depth + 1);
          if (r !== undefined) out[k] = r;
        });
      }
      seen.pop();
      return out;
    }
    var res = walk(value, '', 0);
    return res === undefined ? null : res;
  }

  // Defense in depth: scan a JSON-able tree for forbidden key names / PEM values. Returns a list of offending paths.
  function scanForSecrets(value) {
    var hits = [];
    function walk(v, path) {
      if (v === null || v === undefined) return;
      if (typeof v === 'string') { if (isSecretValue(v)) hits.push(path || '(root)'); return; }
      if (typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(function(x, i) { walk(x, path + '[' + i + ']'); }); return; }
      Object.keys(v).forEach(function(k) {
        var p = path ? path + '.' + k : k;
        if (isSecretKey(k)) { hits.push(p); return; }
        walk(v[k], p);
      });
    }
    walk(value, '');
    return hits;
  }

  function validateIds(clientId, coachUid) {
    var ok = function(s) { return typeof s === 'string' && s.length > 0 && s.length <= 256 && s.indexOf('/') === -1 && s.trim() === s; };
    if (!ok(clientId) || !ok(coachUid)) throw ExportError('INVALID_INPUT', 'ids');
  }
  // clients/{clientId}: must exist, be the requested document and carry coachId === the signed-in coach. Anything else => deny.
  function authorizeClient(clientDoc, clientId, coachUid) {
    validateIds(clientId, coachUid);
    if (!clientDoc) throw ExportError('CLIENT_NOT_FOUND');
    if (clientDoc.id !== clientId) throw ExportError('OWNERSHIP_DENIED', 'id-mismatch');
    var data = clientDoc.data;
    if (!U.isObj(data)) throw ExportError('OWNERSHIP_DENIED', 'no-data');
    if (typeof data.coachId !== 'string' || data.coachId === '' || data.coachId !== coachUid) throw ExportError('OWNERSHIP_DENIED', 'coach-mismatch');
    return true;
  }
  // Per-record check for anything fetched through a client/coach-scoped query: both ids must match exactly when present.
  // `allowMissingClientId` is only used for records reached THROUGH this client's own subtree (activePlanId / mesos ids).
  function recordOwnership(data, clientId, coachUid, opts) {
    if (!U.isObj(data)) return 'MALFORMED';
    if (data.coachId !== coachUid) return 'FOREIGN_COACH';
    if (data.clientId !== undefined && data.clientId !== null) { if (data.clientId !== clientId) return 'FOREIGN_CLIENT'; return 'OK'; }
    return opts && opts.allowMissingClientId ? 'LEGACY_NO_CLIENT_ID' : 'FOREIGN_CLIENT';
  }
  function isPermissionError(e) {
    var c = e && (e.code || e.status);
    return c === 'permission-denied' || c === 'PERMISSION_DENIED' || c === 403 || c === 'unauthenticated';
  }

  return { ExportError: ExportError, MESSAGES: MESSAGES, isSecretKey: isSecretKey, isSecretValue: isSecretValue, sanitize: sanitize, scanForSecrets: scanForSecrets,
    validateIds: validateIds, authorizeClient: authorizeClient, recordOwnership: recordOwnership, isPermissionError: isPermissionError };
});
