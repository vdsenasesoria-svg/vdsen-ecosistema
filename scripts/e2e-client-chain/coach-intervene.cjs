// Simulates the Coach recording an exact-exposure decision on ONE exercise of a synthetic athlete (LOCAL emulator, owner token): node e2e-coach-intervene.cjs <A..F> <exIndex>
const fs = require('fs'), path = require('path');
const all = JSON.parse(fs.readFileSync(path.join(require('os').tmpdir(), 'vdsen-client-e2e-creds.json'), 'utf8')); const c = all.who[process.argv[2]], ei = Number(process.argv[3]);
const iv = { id: 'iv-e2e-1', targetType: 'EXERCISE', targetId: c.pids[ei], action: 'REDUCE_SETS', decidedAt: new Date().toISOString() };
const enc = (v) => typeof v === 'string' ? { stringValue: v } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
(async () => {
  const r = await fetch('http://127.0.0.1:8085/v1/projects/demo-vdsen-client-e2e/databases/(default)/documents/clients/' + c.uid + '?updateMask.fieldPaths=coachInterventions', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: JSON.stringify({ fields: { coachInterventions: { arrayValue: { values: [enc(iv)] } } } }) });
  console.log('intervention written HTTP ' + r.status + ' for exercise index ' + ei);
})();
