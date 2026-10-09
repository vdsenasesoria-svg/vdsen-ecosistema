// Test-only: runs the REAL Coach `_materializeShadowRecords` (extracted from vdsen-coach.html) against an in-memory transactional store.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', '..');
const coachHtml = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));

function functionSource(source, name) {
  let start = source.indexOf('async function ' + name + '(');
  if (start < 0) start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  let depth = 0, quote = null, escaped = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Cannot extract ' + name);
}
function coachMaterializer(docs, { coachUid = 'coach-A', detailClientId = 'client-A', shadowApi = shadow } = {}) {
  const writes = [];
  const tx = { get: async ref => ({ exists: () => docs.has(ref), data: () => structuredClone(docs.get(ref)) }),
    set: (ref, value) => { writes.push(ref); docs.set(ref, { ...docs.get(ref), ...structuredClone(value) }); },
    update: ref => { writes.push(ref); } };
  const ctx = { window: { VDSEN_AUTO_APPLY_SHADOW: shadowApi, VDSEN_APPLICATION_CONSUMER: consumer }, currentCoach: { uid: coachUid }, _detailClientId: detailClientId,
    db: {}, doc: (_db, ...parts) => parts.join('/'), runTransaction: async (_db, fn) => fn(tx), console };
  vm.createContext(ctx);
  vm.runInContext(functionSource(coachHtml, '_materializeShadowRecords'), ctx);
  return { ctx, writes, tx, docs, run: (clientId = 'client-A', planId = 'plan-A') => ctx._materializeShadowRecords(clientId, planId) };
}
module.exports = { coachMaterializer, functionSource, coachHtml };
