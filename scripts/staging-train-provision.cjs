'use strict';
// T554: STAGING ONLY provisioning of a clean "human training" athlete (+ its own owner Coach) with the verified Ayrton plan cloned from a LOCAL file (no production access).
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 VDSEN_AYRTON_PLAN_FILE=<json outside repo> VDSEN_KEEP_OUT=<creds json outside repo> node scripts/staging-train-provision.cjs <human|automation>
// Credentials are written ONLY to VDSEN_KEEP_OUT (mode 0600). Nothing is printed except uids / plan id / fidelity counts.
const fs = require('node:fs'), crypto = require('node:crypto');
const H = require('./client-staging-harness.cjs'); const cfg = H.stagingConfig();
if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
const kind = process.argv[2]; if (!['human', 'automation'].includes(kind)) throw new Error('kind = human|automation');
const SRC = JSON.parse(fs.readFileSync(process.env.VDSEN_AYRTON_PLAN_FILE, 'utf8')).data, OUT = process.env.VDSEN_KEEP_OUT; if (!OUT) throw new Error('VDSEN_KEEP_OUT required');
const FS = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents', AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:';
const enc = v => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)])) } };
const dec = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : Object.fromEntries(Object.entries((v.mapValue || {}).fields || {}).map(([k, x]) => [k, dec(x)]));
async function req(m, u, t, b) { const r = await fetch(u, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, t ? { authorization: 'Bearer ' + t } : {}), body: b === undefined ? undefined : JSON.stringify(b) }); const x = await r.text(); let j = null; try { j = JSON.parse(x); } catch (e) { /* non-json */ } return { s: r.status, b: j }; }
const ok = r => r.s >= 200 && r.s < 300;
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const humanPw = () => 'Vdsen-' + Array.from(crypto.randomBytes(8), b => ALPHA[b % ALPHA.length]).join('');
const autoPw = () => crypto.randomBytes(12).toString('base64url') + 'aA1!';
async function signUp(email, password) { const r = await req('POST', AUTH + 'signUp?key=' + cfg.apiKey, null, { email, password, returnSecureToken: true }); if (!ok(r)) throw new Error('signUp ' + r.s + ' ' + (r.b && r.b.error && r.b.error.message)); return { email, password, uid: r.b.localId, token: r.b.idToken }; }
const put = async (t, p, d, q) => { let r; for (let i = 0; i < 4; i++) { r = await req('PATCH', FS + '/' + p + (q || ''), t, { fields: enc(d).mapValue.fields }); if (ok(r)) return r; await new Promise(x => setTimeout(x, 1500)); } throw new Error('write failed ' + p + ' ' + r.s); };
(async () => {
  const tag = kind === 'human' ? 'train' : 'auto' + crypto.randomBytes(2).toString('hex'), pw = kind === 'human' ? humanPw : autoPw;
  const coach = await signUp('coach.' + tag + '@staging-ui.invalid', autoPw()), ath = await signUp('ayrton.' + tag + '@staging-ui.invalid', pw());
  await put(coach.token, 'coaches/' + coach.uid, { role: 'coach', displayName: 'Coach VDSEN (staging ' + kind + ')', email: coach.email, createdAt: new Date().toISOString() });
  await put(coach.token, 'clients/' + ath.uid, { coachId: coach.uid, email: ath.email, displayName: 'Ayrton VD', role: 'client', objetivo: 'Hipertrofia', profileType: 'hipertrofia', phone: '+525500000000', phoneConfirmedAt: Date.now(), nutritionPlan: {}, supplementPlan: {} });
  const planId = 'plan-ayrton-' + kind + '-' + crypto.randomBytes(3).toString('hex');
  // environment rebinding ONLY: clientId, coachId and the plan's updatedAt (= the source createdAt: its true last prescription revision; the source export carries none). Everything else is the raw source data.
  const data = JSON.parse(JSON.stringify(SRC)); data.clientId = ath.uid; data.coachId = coach.uid; data.status = 'active'; if (typeof data.updatedAt !== 'string') data.updatedAt = data.createdAt;
  const c = await req('PATCH', FS + '/plans/' + planId + '?currentDocument.exists=false', coach.token, { fields: enc(data).mapValue.fields }); if (!ok(c)) throw new Error('plan create ' + c.s);
  const a = await req('PATCH', FS + '/clients/' + ath.uid + '?updateMask.fieldPaths=activePlanId', coach.token, { fields: { activePlanId: { stringValue: planId } } }); if (!ok(a)) throw new Error('activate ' + a.s);
  const rb = await req('GET', FS + '/plans/' + planId, coach.token), got = dec({ mapValue: { fields: rb.b.fields } });
  const diffs = []; const walk = (x, y, p) => { if (x && typeof x === 'object') { const ks = new Set([...Object.keys(x), ...Object.keys(y || {})]); for (const k of ks) { if (Array.isArray(x) && k === 'length') continue; walk(x[k], (y || {})[k], p + '.' + k); } } else if (x !== y) diffs.push(p + ': ' + JSON.stringify(x) + ' != ' + JSON.stringify(y)); };
  walk(SRC, got, ''); const allowed = ['.clientId', '.coachId', '.updatedAt'], unexpected = diffs.filter(d => !allowed.some(k => d.startsWith(k + ':')));
  const exs = got.days.flatMap(d => d.exercises), pids = exs.map(e => e.prescriptionExerciseId);
  console.log(JSON.stringify({ kind, planId, athleteUid: ath.uid, coachUid: coach.uid, weeks: got.weeks, days: got.days.length, exercises: exs.length, sets: exs.reduce((n, e) => n + e.sets.length, 0), uniquePids: new Set(pids).size, diffs: diffs.length, unexpectedDiffs: unexpected.length, unexpected: unexpected.slice(0, 5) }));
  fs.writeFileSync(OUT, JSON.stringify({ kind, project: cfg.projectId, planId, coach: { email: coach.email, password: coach.password, uid: coach.uid }, athlete: { email: ath.email, password: ath.password, uid: ath.uid } }), { mode: 0o600 });
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
