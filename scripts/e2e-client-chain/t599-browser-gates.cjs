'use strict';
// Sequential browser gates against already running LOCAL demo Auth/Firestore emulators.
// Each child owns and stops its servers/browser profiles; no production access or persisted activation.
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const root = path.resolve(__dirname, '../..'), out = path.join(root, 'release-output', 't599');
fs.mkdirSync(out, { recursive: true });
const run = (file, args = []) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, file), ...args], { cwd: root, env: process.env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
};
run('t599-progression-e2e.cjs', ['--out', path.join(out, 'progression')]);
run('t598-logbook-sync-e2e.cjs', ['--root', root, '--out', path.join(out, 't598-sync.json')]);
// T599-R regression gate (D-01 rules C/E reachable from Client data, D-02 invalidated overlay, D-07 coherence, honest labels, numeric OFF = PENDING only). Subset in CI; the full matrix is `scripts/e2e-t599r/chain.cjs`.
run('../e2e-t599r/chain.cjs', ['--numeric', '1', '--only', 'T1,T9,T12', '--out', path.join(out, 't599r-numeric-on.json')]);
run('../e2e-t599r/chain.cjs', ['--numeric', '0', '--only', 'T1,T4', '--out', path.join(out, 't599r-numeric-off.json')]);
run('seed.cjs', [root, 'G']);
// (no argv: the first argument of this script is the Chrome path; passing the repository root made it try to spawn a directory)
run('t594-mobile-runtime-e2e.cjs');
fs.copyFileSync(path.join(os.tmpdir(), 'vdsen-t594-mobile-runtime-result.json'), path.join(out, 'mobile.json'));
console.log('T599 progression, T597/T598 sync, mobile runtime: all browser gates completed');
