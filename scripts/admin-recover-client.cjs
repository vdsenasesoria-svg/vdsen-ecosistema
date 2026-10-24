#!/usr/bin/env node
// T539: ADMIN-ONLY recovery of a legacy client that has NO coach. Ordinary Coach accounts can no longer claim unowned clients
// (firestore.rules). Requires an explicit client UID and an explicit destination Coach UID, verifies the client is currently UNOWNED and
// FAILS if it already has a coachId. Admin SDK (bypasses rules by design). Never runs automatically; contains NO real UIDs.
//
//   node scripts/admin-recover-client.cjs --project <projectId> --client <clientUid> --coach <coachUid> --yes   (--dry-run to preview)
'use strict';

function parse(argv) {
  const o = { yes: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') o.yes = true; else if (a === '--dry-run') o.dry = true;
    else if (a === '--project') o.project = argv[++i]; else if (a === '--client') o.client = argv[++i]; else if (a === '--coach') o.coach = argv[++i];
    else throw new Error('Unknown argument: ' + a);
  }
  return o;
}
const bad = v => !v || /[\/\s]/.test(v);

async function run(argv, db, log) {
  log = log || console.log;
  const o = parse(argv);
  if (!o.project) throw new Error('--project <projectId> is required (never inferred)');
  if (bad(o.client)) throw new Error('--client <clientUid> is required'); if (bad(o.coach)) throw new Error('--coach <coachUid> is required');
  const cRef = db.doc('clients/' + o.client), cSnap = await cRef.get();
  if (!cSnap.exists) throw new Error('clients/' + o.client + ' does not exist');
  const owner = cSnap.data().coachId;
  if (owner !== undefined && owner !== null && owner !== '') throw new Error('clients/' + o.client + ' is already owned by a coach: refusing to reassign (owner relationships are immutable)');
  const kSnap = await db.doc('coaches/' + o.coach).get();
  if (!kSnap.exists) throw new Error('coaches/' + o.coach + ' does not exist');
  log('project=' + o.project + ' client=' + o.client + ' (unowned) -> coach=' + o.coach);
  if (o.dry || !o.yes) { log(o.dry ? 'dry-run: nothing written' : 'add --yes to apply'); return { changed: false }; }
  await cRef.set({ coachId: o.coach, recoveredAt: new Date().toISOString(), recoveredBy: 'admin-script' }, { merge: true });
  return { changed: true };
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
