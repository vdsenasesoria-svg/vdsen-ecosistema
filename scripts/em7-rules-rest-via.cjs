'use strict';
// EM.7 via the emulator's data REST API - no LISTEN channel, so it cannot hang the way the JS SDK does.
//
// The key question this answers FIRST: is this endpoint subject to firestore.rules at all? `Bearer owner`
// is the emulator's admin bypass, so it proves nothing. A request WITHOUT that bypass, or with a bogus
// token, must be evaluated by the rules engine - and if it is, this becomes a deterministic path that
// can observe a real allow/deny decision.
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-vdsen-export';
if (!HOST) { console.error('need FIRESTORE_EMULATOR_HOST'); process.exit(2); }

const URLQ = 'http://' + HOST + '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery';
const eq = (f, v) => ({ fieldFilter: { field: { fieldPath: f }, op: 'EQUAL', value: { stringValue: v } } });
const and = (...fs) => ({ compositeFilter: { op: 'AND', filters: fs } });

async function q(authHeader, where, collectionId = 'plans') {
  const body = { structuredQuery: { from: [{ collectionId }] } };
  if (where) body.structuredQuery.where = where;
  const headers = { 'content-type': 'application/json' };
  if (authHeader) headers.authorization = authHeader;
  const r = await fetch(URLQ, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  const denied = /PERMISSION_DENIED|permission/i.test(text);
  let rows = 0;
  try { const j = JSON.parse(text); if (Array.isArray(j)) rows = j.filter((x) => x.document).length; } catch (e) { /* not json */ }
  return { status: r.status, denied, rows, snippet: text.replace(/\s+/g, ' ').slice(0, 160) };
}

(async () => {
  const cases = [
    ['owner bypass, no filter        ', 'Bearer owner', null],
    ['NO auth, clientId only         ', null, eq('clientId', 'em7r-clientA1')],
    ['NO auth, coachId+clientId      ', null, and(eq('coachId', 'em7r-coachA'), eq('clientId', 'em7r-clientA1'))],
    ['bogus token, clientId only     ', 'Bearer bogus.token.value', eq('clientId', 'em7r-clientA1')],
    ['bogus token, coachId+clientId  ', 'Bearer bogus.token.value', and(eq('coachId', 'em7r-coachA'), eq('clientId', 'em7r-clientA1'))],
  ];
  console.log('=== EM.7 via REST del emulador: el endpoint evalua reglas? ===');
  for (const [label, auth, where] of cases) {
    const r = await q(auth, where);
    const verdict = r.denied ? 'DENIED' : (r.rows ? 'ROWS(' + r.rows + ')' : 'EMPTY');
    console.log('  ' + label + ' -> HTTP ' + r.status + '  ' + verdict);
    if (r.denied) console.log('        ' + r.snippet);
  }
  console.log('');
  console.log('  Si el bypass owner da ROWS/EMPTY y las variantes sin bypass dan DENIED,');
  console.log('  la REST SI evalua reglas y sirve como via determinista.');
  process.exit(0);
})().catch((e) => { console.error('FATAL ' + e.message); process.exit(2); });
