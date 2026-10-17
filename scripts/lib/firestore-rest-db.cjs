'use strict';
// Shared STAGING-ONLY Firestore REST helpers (operator IAM identity via gcloud; refuses any project other than vdsen-ecosistema-staging).
// Exposes the same small surface the trusted executor needs (collection/doc/get/where/runTransaction) so the production handler code can be
// exercised locally against real staging data, and plain admin REST calls for evidence snapshots and cleanup.
const { execSync } = require('node:child_process');
const P = 'vdsen-ecosistema-staging';
const DOCS = 'https://firestore.googleapis.com/v1/projects/' + P + '/databases/(default)/documents';
const DBPATH = 'projects/' + P + '/databases/(default)/documents';
// ---- Firestore REST codec
const enc = v => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null
  : 'timestampValue' in v ? v.timestampValue : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : null;
const decDoc = d => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)]));
const esc = k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : '`' + k.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
function leafPaths(obj, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = (prefix ? prefix + '.' : '') + esc(k);
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) out.push(...leafPaths(v, p)); else out.push(p);
  }
  return out;
}
let _tok = null, _tokAt = 0;
const gToken = () => { if (!_tok || Date.now() - _tokAt > 600000) { _tok = execSync('gcloud auth print-access-token', { encoding: 'utf8', shell: true }).trim(); _tokAt = Date.now(); } return _tok; };
async function http(method, url, token, body, extra) {
  const r = await fetch(url, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}, extra || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ }
  return { s: r.status, b: j };
}
const ok = r => r.s >= 200 && r.s < 300;
const adminHdr = { 'x-goog-user-project': P };

// ---- REST db driver exposing exactly the Admin-SDK surface the executor uses (IAM identity; transactions are real Firestore transactions)
function ref(pathStr) { return { path: pathStr, collection: n => ref(pathStr + '/' + n), doc: id => ref(pathStr + '/' + id), get: async () => snap(await http('GET', DOCS + '/' + pathStr, gToken(), undefined, adminHdr)) }; }
const snap = r => ({ exists: r.s === 200, data: () => (r.s === 200 ? decDoc(r.b) : undefined) });
const restDb = {
  collection: n => Object.assign(ref(n), { where: (field, op, val) => ({ get: async () => {
    if (op !== '==') throw new Error('driver supports == only');
    const q = await http('POST', DOCS + ':runQuery', gToken(), { structuredQuery: { from: [{ collectionId: n }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: enc(val) } } } }, adminHdr);
    const docs = (Array.isArray(q.b) ? q.b : []).filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), data: () => decDoc(x.document) }));
    return { docs };
  } }) }),
  runTransaction: async fn => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const begin = await http('POST', DOCS + ':beginTransaction', gToken(), { options: { readWrite: {} } }, adminHdr);
      const txId = begin.b.transaction, writes = [];
      const tx = {
        get: async r => snap(await http('GET', DOCS + '/' + r.path + '?transaction=' + encodeURIComponent(txId), gToken(), undefined, adminHdr)),
        set: (r, data, opts) => {
          const name = DBPATH + '/' + r.path;
          if (opts && opts.merge) writes.push({ update: { name, fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) }, updateMask: { fieldPaths: leafPaths(data) } });
          else writes.push({ update: { name, fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) } });
        }
      };
      let out;
      try { out = await fn(tx); } catch (e) { await http('POST', DOCS + ':rollback', gToken(), { transaction: txId }, adminHdr); throw e; }
      if (!writes.length) { await http('POST', DOCS + ':rollback', gToken(), { transaction: txId }, adminHdr); return out; }
      const c = await http('POST', DOCS + ':commit', gToken(), { writes, transaction: txId }, adminHdr);
      if (ok(c)) return out;
      if (c.s !== 409 && c.s !== 400) throw new Error('commit failed ' + c.s);
    }
    throw new Error('transaction retries exhausted');
  }
};


module.exports = { P, DOCS, DBPATH, enc, dec, decDoc, leafPaths, gToken, http, ok, adminHdr, restDb };
