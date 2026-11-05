'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('T478 canonical Firestore Emulator pins its JVM locale without mutating the host environment', () => {
  const source = fs.readFileSync('scripts/test-auto-apply-emulator.cjs', 'utf8');
  assert.match(source, /const JAVA_LOCALE_ARGS = \['-Duser\.language=en', '-Duser\.country=US'\]/);
  assert.match(source, /spawn\('java', \[\.\.\.JAVA_LOCALE_ARGS, '-jar', jar/);
  assert.doesNotMatch(source, /process\.env\.JAVA_TOOL_OPTIONS\s*=/);
});
