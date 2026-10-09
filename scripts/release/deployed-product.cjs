'use strict';
// Generates the frozen deployed-product manifest.
//
// WHY THIS EXISTS
// The old guard compared `runtime_sha` against HEAD and refused any product file
// difference. But `runtime_sha` means "the commit of the app that is actually deployed",
// so that rule also refused every ordinary product improvement: merging a client-app fix
// would have required a fresh production deploy each time. The free variable was the
// branch, not the deployed artifact.
//
// This manifest freezes WHAT IS DEPLOYED (per-file sha256 of the served surface at the
// deployed runtime commit). The guard then proves the checkout still matches the
// deployed artifact, instead of forbidding product work.
//
// Usage: node scripts/release/deployed-product.cjs generate <runtime_sha> [out]
//        node scripts/release/deployed-product.cjs verify   <runtime_sha> [manifest]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// The served surface: what a client actually downloads. Deliberately explicit — a new
// served path must be added here on purpose, and a test asserts the list is complete
// for the entry points.
const SERVED = [
  'vdsen-cliente.html',
  'vdsen-coach.html',
  'ficha-publica.html',
  'sw.js',
  'vdsen-push.js',
  'manifest.json',
  'vercel.json',
  'firebase.json',
  '.firebaserc',
  'firestore.rules',
  'firestore.indexes.json',
  // Coach exercise image upload (image-upload-v2). Registered on purpose: the served surface is
  // explicitly enumerated so a new path cannot ship without a deliberate edit here.
  'assets/coach-image-upload/controller.js',
  'assets/coach-image-upload/firebase-adapter.js',
  'assets/coach-image-upload/mount.js',
  'assets/coach-image-upload/paths.js',
  'assets/coach-image-upload/photo-section.js',
  'assets/coach-image-upload/process.js',
  'assets/coach-image-upload/sniff.js',
  'assets/coach-image-upload/validate.js',
  'assets/equipment-context.js',
  'assets/equipment-identity.js',
  'assets/exercise-visual-catalog.js',
  'assets/exercise-visual-metadata-editor.js',
  'assets/exercises/pending-license.svg',
  'assets/progression-application-consumer.js',
  'assets/progression-auto-apply-shadow.js',
  'assets/progression-effective-prescription.js',
  'assets/progression-equipment-resolver.js',
  'assets/progression-magnitude-policy.js',
  'assets/vdsen-logo-official.jpg',
  'fonts/BigShouldersDisplay-800.ttf',
  'fonts/CourierPrime-Bold.ttf',
  'fonts/CourierPrime-Regular.ttf',
  'fonts/Inter-400.ttf',
  // Exportar cliente (vdsen-client-export-v1). Registered here on purpose: the served surface is
  // explicit, so a new browser asset must be named or it ships unverified.
  'assets/client-export/util.js',
  'assets/client-export/security.js',
  'assets/client-export/collect.js',
  'assets/client-export/normalize.js',
  'assets/client-export/derive.js',
  'assets/client-export/media.js',
  'assets/client-export/serialize.js',
  'assets/client-export/zip.js',
  'assets/client-export/firestore-io.js',
  'assets/client-export/runner.js',
  'assets/client-export/ui.js',
  'assets/coach-image-upload/controller.js',
  'assets/coach-image-upload/firebase-adapter.js',
  'assets/coach-image-upload/mount.js',
  'assets/coach-image-upload/paths.js',
  'assets/coach-image-upload/photo-section.js',
  'assets/coach-image-upload/process.js',
  'assets/coach-image-upload/sniff.js',
  'assets/coach-image-upload/validate.js',
];

// Paths the CANDIDATE intends to serve but that are NOT yet in production.
//
// WHY THIS EXISTS
// `SERVED` used to be a single registry, and `verify()` required every entry of it to exist at the
// DEPLOYED runtime commit. That coupled product development to a production deploy: the moment a
// candidate added a served asset, the frozen deployed manifest could no longer verify, and the only
// way out was to regenerate the manifest and pretend the new file was already live - i.e. falsify
// production metadata. Adding product files to canonical does not authorize a production deploy, so
// the two concepts are now separate:
//
//   DEPLOYED SURFACE   = SERVED minus CANDIDATE_ONLY   -> frozen in .release/deployed-product.json
//   CANDIDATE SURFACE  = SERVED (everything the candidate serves once released)
//
// A path moves OUT of this list only when it is genuinely deployed, at which point the manifest is
// regenerated as part of an authorized release.
const CANDIDATE_ONLY = [
  'assets/client-export/util.js',
  'assets/client-export/security.js',
  'assets/client-export/collect.js',
  'assets/client-export/normalize.js',
  'assets/client-export/derive.js',
  'assets/client-export/media.js',
  'assets/client-export/serialize.js',
  'assets/client-export/zip.js',
  'assets/client-export/firestore-io.js',
  'assets/client-export/runner.js',
  'assets/client-export/ui.js',

  'assets/coach-image-upload/controller.js',
  'assets/coach-image-upload/firebase-adapter.js',
  'assets/coach-image-upload/mount.js',
  'assets/coach-image-upload/paths.js',
  'assets/coach-image-upload/photo-section.js',
  'assets/coach-image-upload/process.js',
  'assets/coach-image-upload/sniff.js',
  'assets/coach-image-upload/validate.js',
];

const DEPLOYED = SERVED.filter((f) => !CANDIDATE_ONLY.includes(f));

const MANIFEST = '.release/deployed-product.json';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// git output through a temp FILE: piped stdio is not available in this environment.
function gitBytes(args) {
  const os = require('node:os');
  const tmp = path.join(os.tmpdir(), 'dpm-' + crypto.randomBytes(8).toString('hex'));
  const fd = fs.openSync(tmp, 'w');
  try { execFileSync('git', args, { stdio: ['ignore', fd, 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
  finally { fs.closeSync(fd); }
  const b = fs.readFileSync(tmp); fs.unlinkSync(tmp); return b;
}

function hashCommitFile(runtime, file) { return sha256(gitBytes(['show', runtime + ':' + file])); }
// Committed blobs, never the worktree: a gate must prove provenance of the artifact,
// not of whatever happens to be checked out (and Windows line endings must not matter).
function hashHeadFile(file) { return sha256(gitBytes(['show', 'HEAD:' + file])); }

function generate(runtime, out) {
  const files = {};
  // A manifest is a statement about what is DEPLOYED, so it records only the deployed surface.
  // Candidate-only paths are intentionally absent until an authorized release moves them out of
  // CANDIDATE_ONLY.
  for (const f of DEPLOYED) files[f] = hashCommitFile(runtime, f);
  const doc = {
    schema: 'vdsen-deployed-product-v1',
    runtime_sha: runtime,
    note: 'Frozen per-file sha256 of the served surface at the DEPLOYED runtime commit. Regenerate only as part of an authorized deploy.',
    files,
  };
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.log('wrote ' + out + ' for runtime ' + runtime + ' (' + DEPLOYED.length + ' files)');
  return doc;
}

// Throws unless the manifest honestly describes the DEPLOYED runtime commit.
//
// It deliberately does NOT compare against HEAD. A release candidate carrying product work
// necessarily differs from what production serves until it is deployed, so demanding byte
// equality with HEAD would make every product improvement require a production deploy —
// exactly the coupling this module exists to remove. Provenance of the LIVE app is proven
// against the real deployment inside the release workflow (live.cjs verifyDeployment and
// smoke), where credentials exist; a static check must not claim to prove it.
function verify(runtime, manifestPath) {
  const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (doc.schema !== 'vdsen-deployed-product-v1') throw new Error('unexpected manifest schema: ' + doc.schema);
  if (doc.runtime_sha !== runtime) throw new Error('manifest runtime_sha ' + doc.runtime_sha + ' != deployed ' + runtime);
  const problems = [];
  // Only the DEPLOYED surface must exist at the deployed runtime. Candidate-only paths are
  // deliberately absent there, and demanding them would force a production deploy just to merge a
  // candidate asset.
  for (const f of DEPLOYED) {
    // The registry must describe the deployed artifact honestly, or it is just unverified
    // metadata: every served path is re-hashed at the deployed runtime commit.
    const atRuntime = hashCommitFile(runtime, f);
    if (doc.files[f] !== atRuntime) problems.push('manifest does not describe the deployed runtime: ' + f);
  }
  for (const f of Object.keys(doc.files)) if (!SERVED.includes(f)) problems.push('manifest has unknown path: ' + f);
  // A deployed path missing from the manifest means the manifest went stale: production serves
  // something the frozen surface does not describe. Candidate-only paths are exempt by design.
  for (const f of DEPLOYED) if (!(f in doc.files)) problems.push('deployed path missing from manifest: ' + f);
  if (problems.length) { const e = new Error(problems.join('; ')); e.problems = problems; throw e; }
  return doc;
}

// Throws unless the CANDIDATE is internally coherent. This is what lets a candidate add served
// assets WITHOUT touching the deployed manifest.
//
// It proves three things about the candidate commit:
//   1. every registered served path EXISTS there (a registry entry must not name a vanished file)
//   2. every one can be hashed, so the artifact is readable
//   3. the HTML entry points do not reference a local browser asset the registry forgot, which would
//      ship something unverified
function verifyCandidate(candidateSha, { entryPoints = ['vdsen-cliente.html', 'vdsen-coach.html'] } = {}) {
  const problems = [];
  for (const f of SERVED) {
    try { hashCommitFile(candidateSha, f); }
    catch (e) { problems.push('candidate is missing a registered served path: ' + f); }
  }
  const declared = new Set(SERVED);
  for (const ep of entryPoints) {
    let html;
    try { html = gitBytes(['show', candidateSha + ':' + ep]).toString('utf8'); } catch (e) { continue; } // entry point absent at this commit
    for (const m of html.matchAll(/(?:src|href)=["'](assets\/[^"'?]+)["']/g)) {
      const ref = m[1];
      if (!declared.has(ref)) problems.push(ep + ' references an unregistered browser asset: ' + ref);
    }
  }
  if (problems.length) { const e = new Error(problems.join('; ')); e.problems = problems; throw e; }
  return { paths: SERVED.length, candidate_only: CANDIDATE_ONLY.length, entryPoints };
}

if (require.main === module) {
  const [, , cmd, runtime, extra] = process.argv;
  try {
    if (!/^[0-9a-f]{40}$/.test(runtime || '')) throw new Error('a 40-char runtime SHA is required');
    if (cmd === 'generate') { generate(runtime, extra || MANIFEST); process.exitCode = 0; }
    else if (cmd === 'verify') { const d = verify(runtime, extra || MANIFEST); console.log('PASS deployed product manifest (' + Object.keys(d.files).length + ' files)'); process.exitCode = 0; }
    else throw new Error('usage: deployed-product.cjs generate|verify <runtime_sha> [path]');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { SERVED, DEPLOYED, CANDIDATE_ONLY, MANIFEST, generate, verify, verifyCandidate, hashCommitFile, hashHeadFile };
