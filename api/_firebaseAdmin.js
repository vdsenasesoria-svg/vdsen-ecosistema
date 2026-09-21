'use strict';

/**
 * Lazy Firebase Admin initialization — real implementation behind
 * api/_vdsenAuth.js's injectable deps. Required only at call time (never at
 * module load), so nothing outside a real request touches firebase-admin.
 *
 * Credential comes ONLY from environment variables (Vercel Project Settings
 * -> Environment Variables). Never committed, never logged, never sent to
 * the browser -- this file only runs server-side inside a Vercel function.
 */

var _app = null;

function getAdminApp() {
  if (_app) return _app;

  var admin = require('firebase-admin');
  if (admin.apps && admin.apps.length) {
    _app = admin.apps[0];
    return _app;
  }

  var projectId   = process.env.FIREBASE_PROJECT_ID;
  var clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  var privateKey  = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');
  }

  _app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   projectId,
      clientEmail: clientEmail,
      // Vercel env vars store literal "\n" as two characters; restore real newlines.
      privateKey:  privateKey.replace(/\\n/g, '\n')
    })
  });
  return _app;
}

// -> Promise<{ uid: string }>. Throws on any invalid/expired/malformed token
// (signature, issuer, audience, expiry) -- the caller (_vdsenAuth.js) maps
// any throw to a generic 401, never distinguishing the reason to the client.
async function verifyIdToken(token) {
  var admin = require('firebase-admin');
  var app = getAdminApp();
  var decoded = await admin.auth(app).verifyIdToken(token);
  return { uid: decoded.uid };
}

// -> Promise<boolean>. Mirrors the exact same authorization contract
// firestore.rules already uses everywhere: exists(/coaches/{uid}).
async function isAuthorizedCoach(uid) {
  var admin = require('firebase-admin');
  var app = getAdminApp();
  var snap = await admin.firestore(app).collection('coaches').doc(uid).get();
  return snap.exists;
}

module.exports = {
  getAdminApp:       getAdminApp,
  verifyIdToken:      verifyIdToken,
  isAuthorizedCoach:  isAuthorizedCoach
};
