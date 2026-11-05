// Read the persisted state of one synthetic athlete from the LOCAL Firestore emulator (owner token): node e2e-state.cjs <A..F> [entries-prefix]
const fs = require('fs'), path = require('path');
const all = JSON.parse(fs.readFileSync(path.join(require('os').tmpdir(), 'vdsen-client-e2e-creds.json'), 'utf8')); const c = all.who[process.argv[2]];
if (!c) { console.log('unknown athlete'); process.exit(1); }
const dec = (v) => v.stringValue !== undefined ? v.stringValue : v.integerValue !== undefined ? +v.integerValue : v.doubleValue !== undefined ? v.doubleValue : v.booleanValue !== undefined ? v.booleanValue : v.nullValue !== undefined ? null : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.mapValue ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : undefined;
const get = async (p) => { const r = await fetch('http://127.0.0.1:8085/v1/projects/demo-vdsen-client-e2e/databases/(default)/documents/' + p, { headers: { authorization: 'Bearer owner' } }); return r.status === 200 ? Object.fromEntries(Object.entries((await r.json()).fields || {}).map(([k, v]) => [k, dec(v)])) : null; };
(async () => {
  const m = await get('logs/' + c.uid + '/mesos/' + c.planId) || {}, root = await get('logs/' + c.uid) || {};
  const nm = (pid) => { const i = c.pids.indexOf(pid); return i === 0 ? 'ex0' : i === 1 ? 'ex1' : pid; };
  Object.values(m.progressionApplications || {}).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1).forEach((x) => console.log('RECORD ', nm(x.prescriptionExerciseId), x.state, x.reasonCode, 'action=' + x.action, 'src=W' + x.source.week, 'next=' + (x.nextExposure ? 'W' + x.nextExposure.week : '-'), 'magDim=' + (x.magnitude && x.magnitude.dimension), 'elig=' + (x.magnitude && x.magnitude.eligible), 'cand=' + JSON.stringify((x.magnitude && x.magnitude.candidates || []).map((k) => [k.dimension, k.previousValue, k.rawCandidate]))));
  Object.values(m.nextExposureOverlays || {}).sort((a, b) => a.target.week - b.target.week).forEach((o) => console.log('OVERLAY', nm(o.prescriptionExerciseId), o.status, o.dimension, o.previousValue + '->' + o.appliedValue, o.unit, 'equipmentId=' + o.equipmentId, 'target=W' + o.target.week, o.roundingReason));
  const e = (m.entries || root.entries || {}), pre = process.argv[3];
  Object.keys(e).filter((k) => pre ? k.startsWith(pre) : /^(progrec|postsession)_/.test(k)).sort().forEach((k) => console.log(k, JSON.stringify(e[k]).slice(0, 360)));
  const cl = await get('clients/' + c.uid) || {}; if ((cl.coachInterventions || []).length) console.log('interventions', JSON.stringify(cl.coachInterventions));
})();
