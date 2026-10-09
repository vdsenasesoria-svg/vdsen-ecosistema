#!/usr/bin/env node
// T539: ADMIN-ONLY grant / revoke of the paid-API entitlement (coaches/{uid}.apiAccessEnabled). Uses the Firebase Admin SDK, so it bypasses
// firestore.rules by design; no browser / client-side path can do this. It never runs automatically and contains NO real UIDs.
//
//   node scripts/admin-coach-api-access.cjs --project <projectId> --uid <coachUid> --grant  --yes
//   node scripts/admin-coach-api-access.cjs --project <projectId> --uid <coachUid> --revoke --yes
//   (credentials: GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_* environment of the operator; add --dry-run to only print what would change)
'use strict';

function parse(argv) {
  const o = { grant: false, revoke: false, yes: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--grant') o.grant = true; else if (a === '--revoke') o.revoke = true; else if (a === '--yes') o.yes = true; else if (a === '--dry-run') o.dry = true;
    else if (a === '--project') o.project = argv[++i]; else if (a === '--uid') o.uid = argv[++i]; else throw new Error('Unknown argument: ' + a);
  }
  return o;
}

// db: { doc(path) -> { get(), set(data, opts) } }  (a Firestore Admin instance, or a fake in tests). Returns { changed, before, after }.
async function run(argv, db, log) {
  log = log || console.log;
  const o = parse(argv);
  if (!o.project) throw new Error('--project <projectId> is required (never inferred)');
  if (!o.uid || /[\/\s]/.test(o.uid)) throw new Error('--uid <coachUid> is required');
  if (o.grant === o.revoke) throw new Error('choose exactly one of --grant / --revoke');
  const ref = db.doc('coaches/' + o.uid), snap = await ref.get();
  if (!snap.exists) throw new Error('coaches/' + o.uid + ' does not exist: the Coach must register first (this tool never creates Coach accounts)');
  const before = snap.data().apiAccessEnabled === true, after = o.grant;
  log('project=' + o.project + ' coach=' + o.uid + ' apiAccessEnabled: ' + before + ' -> ' + after);
  if (o.dry || !o.yes) { log(o.dry ? 'dry-run: nothing written' : 'add --yes to apply'); return { changed: false, before, after }; }
  await ref.set({ apiAccessEnabled: after, apiAccessUpdatedAt: new Date().toISOString(), apiAccessUpdatedBy: 'admin-script' }, { merge: true });
  return { changed: before !== after, before, after };
}

module.exports = { run, parse };
if (require.main === module) {
  (async () => {
    const admin = require('firebase-admin');
    const o = parse(process.argv.slice(2));
    admin.initializeApp({ projectId: o.project });
    await run(process.argv.slice(2), admin.firestore());
  })().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
}
