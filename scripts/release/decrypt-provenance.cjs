'use strict';
// OWNER-LOCAL tool (T619). Decrypts the restricted provenance tier written by the OIDC diagnostic. It needs the owner's PRIVATE key, which must never be committed, uploaded or placed on a runner.
//   node scripts/release/decrypt-provenance.cjs <provenance.enc> <private-key.pem>
// The result is printed to stdout for the owner only; nothing is written to disk and nothing is sent anywhere.
const fs = require('node:fs');
const { decryptRestricted } = require('./provenance-diagnostic.cjs');
if (require.main === module) {
  const [encFile, keyFile] = process.argv.slice(2);
  if (!encFile || !keyFile) { console.error('usage: decrypt-provenance.cjs <provenance.enc> <private-key.pem>'); process.exitCode = 2; }
  else {
    try { process.stdout.write(JSON.stringify(decryptRestricted(JSON.parse(fs.readFileSync(encFile, 'utf8')), fs.readFileSync(keyFile, 'utf8')), null, 2) + '\n'); }
    catch { console.error('Could not decrypt (wrong key, tampered or malformed envelope); details withheld'); process.exitCode = 1; }
  }
}
module.exports = { decryptRestricted };
