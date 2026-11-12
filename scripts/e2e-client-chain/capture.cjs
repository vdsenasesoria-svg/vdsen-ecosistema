// Capture what the REAL Client wrote (logbook entries, post-session, progrec) and the Coach-normalized plan for each synthetic athlete, from the LOCAL emulator, into a fixture
// the CI can replay against the server half: node e2e-capture.cjs <out.json>. Only synthetic data. UIDs / emails are NOT stored.
const fs = require('fs'), path = require('path');
const all = JSON.parse(fs.readFileSync(path.join(require('os').tmpdir(), 'vdsen-client-e2e-creds.json'), 'utf8'));
const dec = (v) => v.stringValue !== undefined ? v.stringValue : v.integerValue !== undefined ? +v.integerValue : v.doubleValue !== undefined ? v.doubleValue : v.booleanValue !== undefined ? v.booleanValue : v.nullValue !== undefined ? null : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : undefined;
const get = async (p) => { const r = await fetch('http://127.0.0.1:8085/v1/projects/demo-vdsen-client-e2e/databases/(default)/documents/' + p, { headers: { authorization: 'Bearer owner' } }); return r.status === 200 ? Object.fromEntries(Object.entries((await r.json()).fields || {}).map(([k, v]) => [k, dec(v)])) : null; };
const weekOf = (k) => { const m = /^(?:log|done|postsession|progrec|ci_sem|exnote|exnotepid|exexpress|exskip|ss_step)_(\d+)/.exec(k); return m ? Number(m[1]) : null; };
(async () => {
  const out = { meta: { source: 'T583 real-Client E2E on local emulators (Auth + Firestore); the Client UI wrote these entries and ran its own progression algorithm', clientAlgorithm: 'vdsen-cliente.html calculateProgression (VDSEN v3.1)', capturedAt: new Date().toISOString() }, scenarios: {} };
  for (const [name, c] of Object.entries(all.who)) {
    const plan = await get('plans/' + c.planId), meso = await get('logs/' + c.uid + '/mesos/' + c.planId) || {}, cl = await get('clients/' + c.uid) || {};
    const entries = meso.entries || {};
    const upTo = (w) => Object.fromEntries(Object.entries(entries).filter(([k]) => { const x = weekOf(k); return x === null || x <= w; }));
    const keepPlan = JSON.parse(JSON.stringify(plan)); delete keepPlan.clientId; delete keepPlan.coachId;
    out.scenarios[name] = { plan: keepPlan, entriesThroughW2: upTo(2), entriesThroughW3: Object.keys(entries).some((k) => weekOf(k) === 3) ? upTo(3) : null, interventions: cl.coachInterventions || [] };
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + '\n');
  console.log('captured', Object.keys(out.scenarios).join(','), 'bytes=' + fs.statSync(process.argv[2]).size);
})();
