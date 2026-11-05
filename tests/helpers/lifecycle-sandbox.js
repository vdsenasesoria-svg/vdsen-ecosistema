// Test-only sandbox: loads FLAG-ON copies of the lifecycle modules (shadow / consumer / effective resolver) inside a vm, wired to each other.
// The shipped sources keep `NUMERIC_APPLY_ENABLED = false`; only this isolated copy is forced on. Never imported by production code.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', '..');
const FLAG = 'var NUMERIC_APPLY_ENABLED = false;';

function load(file, flagOn, deps) {
  const src = fs.readFileSync(path.join(root, 'assets', file), 'utf8');
  if (flagOn && !src.includes(FLAG)) throw new Error(file + ': flag declaration not found');
  const code = flagOn ? src.replace(FLAG, 'var NUMERIC_APPLY_ENABLED = true;') : src;
  const m = { exports: {} };
  const req = id => { const k = path.basename(id); if (deps && deps[k]) return deps[k]; return require(path.join(root, 'assets', k)); };
  new vm.Script('(function(module, globalThis, require){' + code + '\n})', { filename: file }).runInThisContext()(m, {}, req);
  return m.exports;
}
// on=true -> flag ON everywhere (consumer, shadow, effective); on=false -> shipped copies wired the same way
function build(on) {
  const shadow = load('progression-auto-apply-shadow.js', on, {});
  const deps = { 'progression-auto-apply-shadow.js': shadow };
  const effective = fs.existsSync(path.join(root, 'assets/progression-effective-prescription.js')) ? load('progression-effective-prescription.js', on, deps) : null;
  const consumer = load('progression-application-consumer.js', on, Object.assign({}, deps, effective ? { 'progression-effective-prescription.js': effective } : {}));
  return { shadow, consumer, effective };
}
module.exports = { build, load, root };
