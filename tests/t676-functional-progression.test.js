'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const sra = require('../assets/sra-context'), structural = require('../assets/progression-structural-policy');
const { importLikeCoach } = require('./helpers/coach-plan-import');
const html = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = html.indexOf('function _scheduleTrustedProgression(');
const src = html.slice(start, html.indexOf('// T570-R: the athlete app never creates canonical records.', start));
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function transport(storage = new Map()) {
  const timers = new Map(), requests = [], events = {}, box = {
    USER: { uid: 'athlete', getIdToken: async () => 'test-only' }, ACTIVE_PLAN_ID: 'plan',
    FB: { db: {}, waitForPendingWrites: async () => {} }, _trustedProgressionPending: {},
    console: { warn() {} }, Date, Promise, navigator: { onLine: true },
    localStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    setTimeout: (f, ms) => { const key = {}; timers.set(key, { f, ms }); return key; }, clearTimeout: k => timers.delete(k),
    window: { addEventListener: (k, f) => { events[k] = f; } }, document: { addEventListener() {} },
    fetch: async () => { requests.push(1); return { ok: false, status: 503 }; }
  };
  vm.createContext(box); vm.runInContext(src, box);
  return { box, storage, timers, requests, events, async next() { const [k,t] = [...timers][0]; timers.delete(k); t.f(); await flush(); return t.ms; },
    success() { box.fetch = async () => { requests.push(1); return { ok: true, status: 200, json: async () => ({ status: 'NO_CHANGE' }) }; }; } };
}
test('T676 durable transport survives reload and recovers automatically without retaining training data or credentials', async () => {
  const a = transport(); a.box._scheduleTrustedProgression('athlete','plan'); await flush();
  assert.equal(a.requests.length,1); assert.ok([...a.timers.values()][0].ms > 0 && [...a.timers.values()][0].ms <= 1500);
  assert.equal(a.storage.size,1); assert.ok(!JSON.stringify([...a.storage]).includes('test-only'));
  const b = transport(a.storage); b.success(); b.events.pageshow(); await b.next();
  assert.equal(b.requests.length,1); assert.equal(b.storage.size,0);
});
test('T676 retries are bounded and account changes never send a stale intent', async () => {
  const a = transport(); a.box._scheduleTrustedProgression('athlete','plan'); await flush();
  while (a.timers.size) await a.next();
  assert.equal(a.requests.length,6); assert.equal(a.storage.size,1);
  a.events.online(); a.box.USER = { uid: 'other' }; await a.next(); assert.equal(a.requests.length,6);
});
test('T676 an older acknowledgement cannot erase a newer save from another tab', async () => {
  const a = transport(); let done;
  a.box.fetch = () => new Promise(r => { done = r; });
  a.box._scheduleTrustedProgression('athlete','plan'); await flush();
  const b = transport(a.storage); b.box._trustedProgressionIntent('athlete','plan',true);
  const newer = [...a.storage.values()][0];
  done({ ok:true, status:200, json:async()=>({status:'NO_CHANGE'}) }); await flush();
  assert.equal([...a.storage.values()][0],newer); assert.equal(a.timers.size,1);
});
test('T676 canonical live state accepts only server-confirmed same-account same-plan snapshots and preserves active input', () => {
  const a = transport(), b = a.box; let renders = 0;
  b.LIFECYCLE_STATE = { uid:'athlete',planId:'plan',records:{},overlays:{},receipts:{},candidatePlanDoc:{days:[]} };
  b.renderEntrenamiento = () => renders++; b.renderResumen = () => {};
  const snap = { exists:()=>true, data:()=>({planId:'plan',progressionApplications:{r:{state:'APPLIED'}},nextExposureOverlays:{o:{status:'APPLIED'}}}), metadata:{fromCache:true} };
  b._acceptTrustedProgressionSnapshot('athlete','plan',snap); assert.equal(renders,0); assert.equal(Object.keys(b.LIFECYCLE_STATE.records).length,0);
  snap.metadata = {}; b.document.activeElement = {offsetParent:{},matches:()=>true};
  b._acceptTrustedProgressionSnapshot('athlete','plan',snap); assert.equal(renders,0); assert.equal(b.LIFECYCLE_STATE.records.r.state,'APPLIED');
  b.document.activeElement = null; b._flushTrustedProgressionRender(); assert.equal(renders,1, 'deferred update renders on focus loss');
  snap.data = () => ({planId:'plan',progressionApplications:{r:{state:'CONSUMED'}}});
  b._acceptTrustedProgressionSnapshot('athlete','plan',snap); assert.equal(renders,2);
  b.USER.uid = 'other'; b._acceptTrustedProgressionSnapshot('athlete','plan',snap); assert.equal(renders,2);
});
test('T676 out-of-order canonical reads never replace a newer overlay snapshot', async () => {
  const b=transport().box, pending=[];
  b.LIFECYCLE_STATE={uid:'athlete',planId:'plan',records:{},overlays:{},receipts:{},candidatePlanDoc:{}};
  b.document.activeElement=null; b.renderEntrenamiento=()=>{}; b.renderResumen=()=>{};
  b.FB.doc=()=>({}); b.FB.getDoc=()=>new Promise(resolve=>pending.push(resolve));
  const snap=state=>({exists:()=>true,metadata:{},data:()=>({planId:'plan',progressionApplications:{r:{state}}})});
  b._refreshTrustedProgression('athlete','plan'); b._refreshTrustedProgression('athlete','plan');
  pending[1](snap('CONSUMED')); await flush(); pending[0](snap('APPLIED')); await flush();
  assert.equal(b.LIFECYCLE_STATE.records.r.state,'CONSUMED');
});
function monitoring(days = 1) {
  const planDoc = {clientId:'a', days:[{dayIndex:0,exercises:[{prescriptionExerciseId:'p'}]}]}, entries = {};
  for (let w=1; w<=days; w++) {
    entries['done_'+w+'_0'] = {ts:Date.UTC(2026,0,w)};
    entries['postsession_'+w+'_0'] = {durationMinutes:30+w,rpeAverage:7};
    entries['log_'+w+'_0_0_s0'] = {done:true,prescriptionExerciseId:'p',carga:'20',reps:'10',rir_real:2,unit:'KG'};
    entries['log_'+w+'_0_0_s1'] = {done:true,prescriptionExerciseId:'p',carga:'30',reps:'8',rir_real:3,unit:'KG'};
  }
  return {clientId:'a',planDoc,entries};
}
test('T676 template context uses actual duration x sRPE and exact tonnage; missing data never becomes zero', () => {
  const x = monitoring(); x.entries.log_1_0_0_s2 = {done:true,prescriptionExerciseId:'p',warmup:true,carga:500,reps:10,unit:'KG'};
  x.entries.log_1_0_1_s0 = {done:true,prescriptionExerciseId:'p',carga:500,reps:10,unit:'KG'};
  let m = sra.sessionMonitoring(x), s = m.sessions[0];
  assert.equal(s.loadAU,217); assert.equal(s.tonnageByUnit.KG,440); assert.equal(s.repetitions,18); assert.equal(s.realRIR,2.5);
  assert.equal(m.numericApplyEnabled,false); assert.equal(m.acwr,null); assert.equal(s.workingSets,2);
  delete x.entries.log_1_0_0_s0.rir_real; x.entries.log_1_0_0_s0.rir = 0;
  assert.equal(sra.sessionMonitoring(x).sessions[0].realRIR,3, 'prescribed RIR is not a substitute for actual RIR');
  delete x.entries.postsession_1_0.durationMinutes; m = sra.sessionMonitoring(x); assert.equal(m.sessions[0].loadAU,null);
  assert.ok(m.sessions[0].reasons.includes('REPORTED_SESSION_DURATION_OR_RPE_MISSING'));
  x.clientId='other'; assert.deepEqual(sra.sessionMonitoring(x).reasons,['IDENTITY_MISMATCH']);
});
test('T676 EWMA includes current load and requires 28 actual contiguous days; missing rest days are not invented', () => {
  const x = monitoring(28), m = sra.sessionMonitoring(x);
  let acute=217,chronic=217;
  for(let w=2;w<=28;w++){acute=.25*((30+w)*7)+.75*acute;chronic=2/29*((30+w)*7)+27/29*chronic;}
  assert.ok(Math.abs(m.acuteEWMA7-acute)<1e-9); assert.ok(Math.abs(m.chronicEWMA28-chronic)<1e-9);
  assert.ok(Math.abs(m.acwr-acute/chronic)<1e-9); assert.equal(m.sessions.length,2); assert.equal(m.sessionCount,28);
  delete x.entries.done_15_0; assert.equal(sra.sessionMonitoring(x).acwr,null);
  Object.values(x.entries).forEach(e=>{if(e.durationMinutes)e.durationMinutes=30;});
  const constant = sra.sessionMonitoring(x); assert.equal(constant.monotony7,null); assert.ok(constant.reasons.includes('MONOTONY_ZERO_VARIANCE'));
});
test('T676 Coach preserves explicit fractional metadata; autonomous volume counts direct 1, indirect .5 and stabilizers 0', () => {
  const plan = importLikeCoach({weeks:4,daysPerWeek:1,days:[{dayIndex:0,exercises:[
    {exerciseName:'Press',muscleGroup:'pectoral',secondaryMuscles:['triceps','delt_anterior'],stabilizers:['delt_anterior'],sets:[{repsTarget:10,rirTarget:2,load:0,restSeconds:90},{repsTarget:10,rirTarget:2,load:0,restSeconds:90}]},
    {exerciseName:'Extensión',muscleGroup:'triceps',sets:[{repsTarget:10,rirTarget:2,load:0,restSeconds:90}]}
  ]}]});
  assert.deepEqual(plan.days[0].exercises[0].secondaryMuscles,['triceps','delt_anterior']);
  assert.equal(structural.weeklyVolume(plan,{},1,'triceps'),2); assert.equal(structural.weeklyVolume(plan,{},1,'pectoral'),2);
  assert.equal(structural.weeklyVolume(plan,{},1,'delt_anterior'),0);
  plan.days[0].exercises[0].secondaryMuscles=['unknown']; assert.equal(structural.weeklyVolume(plan,{},1,'triceps'),null);
  assert.ok(structural.volumeCeiling('pectoral','NO_PRIORITARIO') < structural.volumeCeiling('pectoral','PRIORITARIO'));
  const legacy = importLikeCoach({weeks:4,daysPerWeek:1,days:[{dayIndex:0,exercises:[{exerciseName:'Press',muscleGroup:'pectoral',secondaryMuscles:['deltoides_anterior'],sets:[{repsTarget:10,rirTarget:2,load:0,restSeconds:90}]}]}]});
  assert.deepEqual(legacy.days[0].exercises[0].secondaryMuscles,['deltoides_anterior']);
  assert.equal(structural.weeklyVolume(legacy,{},1,'pectoral'),null, 'unknown legacy muscle keys do not authorize volume increases');
});
