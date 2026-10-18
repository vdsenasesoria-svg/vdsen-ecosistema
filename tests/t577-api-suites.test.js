'use strict';
// T577: the baseline-aware CI unit gate (scripts/release/baseline.cjs) runs ONLY tests/*.test.js. The server-side suites under api/
// (including the T576 function-bundle guard) were therefore never part of any CI gate. Requiring them here registers their tests under
// this file so they run in the unit gate.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'api');
// Only node:test suites: some legacy api/*.test.js are standalone scripts that call process.exit and would end this run early.
fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && /node:test/.test(fs.readFileSync(path.join(dir, f), 'utf8'))).sort().forEach((f) => require(path.join(dir, f)));
