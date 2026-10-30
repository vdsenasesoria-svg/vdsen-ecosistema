'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('client Auth E2E installs its test-only dependencies and fixes the emulator locale locally', () => {
  const source = fs.readFileSync('scripts/client-auth-e2e.cjs', 'utf8');
  for (const dep of ['firebase-tools@13.35.1', 'firebase@10.12.0', 'esbuild@0.25.10', 'playwright-core@1.56.1']) assert.ok(source.includes(dep));
  assert.match(source, /const JAVA_LOCALE_ARGS = \['-Duser\.language=en', '-Duser\.country=US'\]/);
  assert.match(source, /path\.join\(runtime, 'node_modules', 'firebase-tools'/);
  assert.match(source, /node_modules', 'esbuild', 'install\.js'/);
  assert.match(source, /shell: process\.platform === 'win32'/);
  assert.match(source, /projectId: PROJECT/);
  assert.match(source, /VDSEN_E2E_CHROME/);
  assert.match(source, /pathname === '\/' \|\| pathname === '\/cliente'/);
  assert.match(source, /pathname === '\/api\/autonomous-progression-trigger'/);
  assert.match(source, /authorized \? 202 : 401/);
});

test('T595-B: --out creates its destination directory (a fresh checkout has no release-output/)', () => {
  const source = fs.readFileSync('scripts/client-auth-e2e.cjs', 'utf8');
  assert.match(source, /fs\.mkdirSync\(path\.dirname\(path\.resolve\(outFile\)\), \{ recursive: true \}\);\s*fs\.writeFileSync\(outFile/);
});
