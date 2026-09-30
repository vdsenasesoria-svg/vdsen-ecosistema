'use strict';

/**
 * VDSEN Auth — server-side Firebase ID token verification for API routes.
 *
 * Pure/injectable: no live Firebase Admin dependency at require-time.
 * Callers inject `deps.verifyIdToken(token) -> Promise<{uid}>` and
 * `deps.isAuthorizedCoach(uid) -> Promise<boolean>` = the paid-API ENTITLEMENT (coaches/{uid}.apiAccessEnabled === true, T539) (the real implementations
 * live in ./_firebaseAdmin.js and are wired in by the endpoint's default
 * export only -- never at module load, so tests never need firebase-admin
 * installed).
 *
 * Identity comes ONLY from the verified token's own decoded `uid`. Nothing
 * in the request body (coachId, email, clientId, etc.) is ever treated as
 * proof of who the caller is.
 */

var ERR = {
  AUTH_MISSING:   'AUTH_MISSING',
  AUTH_MALFORMED: 'AUTH_MALFORMED',
  AUTH_INVALID:   'AUTH_INVALID',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN'
};

// Extracts the token from "Bearer <token>". Returns null for anything else
// (missing header, wrong scheme, empty token) -- never throws.
function extractBearerToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  var m = /^Bearer\s+(\S+)$/.exec(authHeader.trim());
  return m ? m[1] : null;
}

// Returns { ok:true, uid } or { ok:false, status, errorCode }.
// Never includes the token itself anywhere in the returned object.
async function authenticateCoachRequest(authHeader, deps) {
  deps = deps || {};

  if (!authHeader || typeof authHeader !== 'string' || !authHeader.trim()) {
    return { ok: false, status: 401, errorCode: ERR.AUTH_MISSING };
  }

  var token = extractBearerToken(authHeader);
  if (!token) {
    return { ok: false, status: 401, errorCode: ERR.AUTH_MALFORMED };
  }

  var decoded;
  try {
    decoded = await deps.verifyIdToken(token);
  } catch (e) {
    return { ok: false, status: 401, errorCode: ERR.AUTH_INVALID };
  }

  var uid = decoded && decoded.uid;
  if (!uid || typeof uid !== 'string') {
    return { ok: false, status: 401, errorCode: ERR.AUTH_INVALID };
  }

  // Authorization (T539): the caller must hold the server-managed API ENTITLEMENT (coaches/{uid}.apiAccessEnabled === true, evaluated by
  // deps.isAuthorizedCoach in ./_firebaseAdmin.js). A coach app account alone is NOT enough. FAIL CLOSED everywhere: a route that forgets to
  // wire isAuthorizedCoach is rejected (403), and a failing check is never a pass.
  if (typeof deps.isAuthorizedCoach !== 'function') {
    return { ok: false, status: 403, errorCode: ERR.AUTH_FORBIDDEN };
  }
  var entitled;
  try {
    entitled = await deps.isAuthorizedCoach(uid);
  } catch (e) {
    return { ok: false, status: 401, errorCode: ERR.AUTH_INVALID };
  }
  if (entitled !== true) {
    return { ok: false, status: 403, errorCode: ERR.AUTH_FORBIDDEN };
  }

  return { ok: true, uid: uid };
}

module.exports = {
  ERR: ERR,
  extractBearerToken: extractBearerToken,
  authenticateCoachRequest: authenticateCoachRequest
};
