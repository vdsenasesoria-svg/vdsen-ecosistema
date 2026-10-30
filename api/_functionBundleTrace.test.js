'use strict';
// T576: Vercel bundles a serverless function from the files its tracer (nft) can see: LITERAL require('./x') calls only.
// The progression consumer loads some modules through an injected require (`_req('./x.js')`), which the tracer cannot follow; such a module is
// absent from the deployed function and the APPLIED path throws MODULE_NOT_FOUND (hosted-only: Node resolves it fine locally).
// Guard: every module loaded indirectly by a traced module must also be reachable through a literal require from the entrypoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LITERAL = /(?<![\w.$])require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const INDIRECT = /(?<![\w.$])_req\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const resolveFile = (from, spec) => { const p = path.resolve(path.dirname(from), spec); return fs.existsSync(p) ? p : p + '.js'; };

function trace(entry) {
  const seen = new Set(), indirect = [];
  (function walk(file) {
    if (seen.has(file)) return; seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(LITERAL)) walk(resolveFile(file, m[1]));
    for (const m of src.matchAll(INDIRECT)) indirect.push({ from: file, file: resolveFile(file, m[1]) });
  })(entry);
  return { seen, indirect };
}

for (const entry of ['autonomous-progression-trigger.js', '_autonomousProgressionSweep.js']) {
  test('T576 function bundle: indirect (_req) modules are statically traceable from api/' + entry, () => {
    const { seen, indirect } = trace(path.join(__dirname, entry));
    assert.ok(indirect.length >= 2, 'the consumer is expected to use indirect requires');
    const missing = indirect.filter(i => !seen.has(i.file)).map(i => path.relative(path.join(__dirname, '..'), i.file));
    assert.deepEqual([...new Set(missing)], [], 'not reachable through a literal require => absent from the Vercel function bundle');
  });
}
