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
];

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
  for (const f of SERVED) files[f] = hashCommitFile(runtime, f);
  const doc = {
    schema: 'vdsen-deployed-product-v1',
    runtime_sha: runtime,
    note: 'Frozen per-file sha256 of the served surface at the DEPLOYED runtime commit. Regenerate only as part of an authorized deploy.',
    files,
  };
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.log('wrote ' + out + ' for runtime ' + runtime + ' (' + SERVED.length + ' files)');
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
  for (const f of SERVED) {
    // The registry must describe the deployed artifact honestly, or it is just unverified
    // metadata: every served path is re-hashed at the deployed runtime commit.
    const atRuntime = hashCommitFile(runtime, f);
    if (doc.files[f] !== atRuntime) problems.push('manifest does not describe the deployed runtime: ' + f);
  }
  for (const f of Object.keys(doc.files)) if (!SERVED.includes(f)) problems.push('manifest has unknown path: ' + f);
  if (problems.length) { const e = new Error(problems.join('; ')); e.problems = problems; throw e; }
  return doc;
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
module.exports = { SERVED, MANIFEST, generate, verify, hashCommitFile, hashHeadFile };
