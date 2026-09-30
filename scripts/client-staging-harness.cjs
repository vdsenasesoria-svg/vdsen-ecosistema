'use strict';
// T542: STAGING-ONLY harness for the real client (vdsen-cliente.html).
//  - buildStagingHtml(): in-memory / disposable copy of the client whose Firebase config is swapped for the staging web config.
//    The production file is never edited: production stays the default, staging exists only in the generated copy.
//  - seed()/cleanup(): synthetic coach + athlete + plan against the STAGING project via REST (the deployed rules decide).
// Refuses to run for any project that is not the staging alias (production / vdsen-planes are forbidden targets).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const FORBIDDEN = ['vdsen-ecosistema', 'vdsen-planes'];

function stagingConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/firebase-staging.config.json'), 'utf8'));
  const rc = JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8')).projects;
  if (cfg.projectId !== rc.staging || FORBIDDEN.includes(cfg.projectId) || !/staging/.test(cfg.projectId)) throw new Error('REFUSING: not the staging project');
  return cfg;
}

const CFG_BLOCK = /const firebaseConfig = \{[\s\S]*?\};/;
function buildStagingHtml(prodHtml) {
  const cfg = stagingConfig();
  const m = prodHtml.match(new RegExp(CFG_BLOCK.source, 'g')) || [];
  if (m.length !== 1 || !/projectId:\s*"vdsen-ecosistema"/.test(m[0])) throw new Error('REFUSING: expected exactly one production firebaseConfig block to swap');
  const block = 'const firebaseConfig = ' + JSON.stringify({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId, storageBucket: cfg.storageBucket, messagingSenderId: cfg.messagingSenderId, appId: cfg.appId }) + ';';
  const out = prodHtml.replace(CFG_BLOCK, () => block);
  if (/projectId:\s*"vdsen-ecosistema"/.test(out) || !out.includes(cfg.projectId)) throw new Error('REFUSING: staging swap incomplete');
  return out;
}

// ---- Firestore REST codec
const enc = v => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const fields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
async function req(method, url, token, body) {
  const r = await fetch(url, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, body: j };
}
const ok = r => r.status >= 200 && r.status < 300;

// Synthetic plan (vdsen-plan-v2 training block; identities are stable PIDs, prescribed RIR is the Coach's).
const set = (i, reps, rir, rest, load) => ({ setIndex: i, repsTarget: reps, rirTarget: rir, restSeconds: rest, load: load || 0 });
const sets = (n, reps, rir, rest, load) => Array.from({ length: n }, (_, i) => set(i, reps, rir, rest, load));
const ex = (pid, name, n, reps, rir, rest, extra) => Object.assign({ prescriptionExerciseId: pid, exerciseName: name, sets: sets(n, reps, rir, rest) }, extra || {});
function syntheticPlan(coachId, clientId) {
  return {
    schema: 'vdsen-plan-v2', coachId, clientId, status: 'active', weeks: 6, daysPerWeek: 3, generatedBy: 'staging-harness', createdAt: new Date().toISOString(), updatedAt: '2026-09-30T00:00:00.000Z',
    days: [
      { dayIndex: 0, label: 'Empuje · Pecho y hombro', exercises: [
        ex('pid-h-1', 'Press banca con barra', 4, 6, 2, 150), ex('pid-h-2', 'Press inclinado con mancuernas', 3, 10, 2, 120),
        ex('pid-h-3', 'Elevaciones laterales', 3, 15, 1, 60), ex('pid-h-4', 'Extensión de tríceps en polea', 3, 12, 1, 75) ] },
      { dayIndex: 1, label: 'Tirón · Espalda y bíceps', exercises: [
        ex('pid-h-5', 'Dominadas asistidas', 4, 8, 2, 120), ex('pid-h-6', 'Remo con mancuerna unilateral', 3, 10, 2, 0, { supersetGroup: 'A', technique: 'superset' }),
        ex('pid-h-7', 'Curl con barra Z', 3, 10, 1, 90, { supersetGroup: 'A', technique: 'superset' }) ] },
      { dayIndex: 2, label: 'Pierna · Cuádriceps y glúteo', exercises: [
        ex('pid-h-8', 'Sentadilla trasera', 4, 6, 2, 180), ex('pid-h-9', 'Prensa de pierna', 3, 12, 2, 120),
        ex('pid-h-10', 'Curl femoral tumbado', 3, 12, 1, 90), ex('pid-h-11', 'Elevación de talones de pie', 4, 15, 1, 60) ] }
    ]
  };
}
const NUTRITION_TEXT = ['COMIDA 1 — DESAYUNO', 'Huevo entero 3 pza', 'Avena en hojuelas 60 g', 'Plátano 1 pieza', 'Macros: 620 kcal · 38 P · 78 C · 16 G', '',
  'COMIDA 2 — ALMUERZO', 'Pechuga de pollo 200 g', 'Arroz blanco cocido 250 g', 'Aguacate 60 g', 'Macros: 780 kcal · 55 P · 82 C · 24 G', '',
  'COMIDA 3 — PRE-ENTRENO', 'Yogur griego natural 200 g', 'Miel 15 g', 'Macros: 260 kcal · 22 P · 30 C · 6 G', '',
  'COMIDA 4 — CENA', 'Salmón 180 g', 'Papa cocida 250 g', 'Ensalada verde 150 g', 'Macros: 720 kcal · 46 P · 60 C · 30 G'].join('\n');

async function seed() {
  const cfg = stagingConfig(), PROJECT = cfg.projectId, KEY = cfg.apiKey;
  const FS = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
  const rid = crypto.randomBytes(3).toString('hex');
  async function signUp(label) {
    const email = label + '.' + rid + '@staging-ui.invalid', password = crypto.randomBytes(12).toString('base64url') + 'aA1!';
    const r = await req('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + KEY, null, { email, password, returnSecureToken: true });
    if (!ok(r)) throw new Error('signUp failed ' + r.status);
    return { label, email, password, uid: r.body.localId, token: r.body.idToken };
  }
  const put = (t, p, data) => req('PATCH', FS + '/' + p, t, { fields: fields(data) });
  const del = (t, p) => req('DELETE', FS + '/' + p, t);
  const coach = await signUp('coach'), athlete = await signUp('athlete');
  const planId = 'plan-ui-' + rid;
  async function cleanup() {
    const res = { docsDeleted: 0, usersDeleted: 0 };
    // owner Coach deletes athlete evidence first (the rules require the coach doc to exist), then plan / client / coach.
    for (const p of ['logs/' + athlete.uid + '/mesos/' + planId, 'logs/' + athlete.uid, 'plans/' + planId, 'clients/' + athlete.uid, 'coaches/' + coach.uid]) { const r = await del(coach.token, p); if (ok(r) || r.status === 404) res.docsDeleted++; }
    for (const u of [coach, athlete]) { const r = await req('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:delete?key=' + KEY, null, { idToken: u.token }); if (r.status === 200) res.usersDeleted++; }
    return res;
  }
  try {
  const w = async (t, p, d) => { const r = await put(t, p, d); if (!ok(r)) throw new Error('seed write failed ' + p + ' ' + r.status); };
    await w(coach.token, 'coaches/' + coach.uid, { role: 'coach', displayName: 'Coach UI (synthetic)', email: coach.email, createdAt: new Date().toISOString() });
    await w(coach.token, 'clients/' + athlete.uid, { coachId: coach.uid, email: athlete.email, displayName: 'Atleta Demo', role: 'client', activePlanId: null, nutritionPlan: {}, supplementPlan: {}, objetivo: 'Hipertrofia', peso: '82', profileType: 'hipertrofia' });
    await w(coach.token, 'plans/' + planId, syntheticPlan(coach.uid, athlete.uid));
    await w(coach.token, 'clients/' + athlete.uid, { coachId: coach.uid, email: athlete.email, displayName: 'Atleta Demo', role: 'client', objetivo: 'Hipertrofia', peso: '82', profileType: 'hipertrofia', phone: '+525500000000', phoneConfirmedAt: Date.now(), activePlanId: planId, nutritionPlan: { calorias: 2380, proteina: 161, carbos: 250, grasas: 76, texto: NUTRITION_TEXT }, supplementPlan: { texto: 'Creatina monohidratada 5 g diarios\nVitamina D3 2000 UI con comida' } });
  } catch (e) { await cleanup(); throw e; }
  return { athlete: { email: athlete.email, password: athlete.password, uid: athlete.uid }, coachUid: coach.uid, planId, cleanup, project: PROJECT };
}
module.exports = { buildStagingHtml, stagingConfig, seed, syntheticPlan, FORBIDDEN };
