'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createHash, webcrypto} = require('node:crypto');
const html = fs.readFileSync('vdsen-cliente.html','utf8');
const match = html.match(/const _historicalFragmentDigest = .*?[\s\S]+?(?=function renderEntrenamiento\(\))/);
const source = match[0];
const old = 'O'.repeat(20), active = 'N'.repeat(20), payload = 'a'.repeat(64)+'.'+old+'.'+active;
const digest = createHash('sha256').update(payload).digest('hex');
function fixture() {
  const sizes = [[3,3,3,3,3,4], [3,3,3,2]];
  const plan = {clientId:'owner', status:'superseded', supersededBy:active,
    days:sizes.map((counts,dayIndex)=>({dayIndex,exercises:counts.map((count,i)=>({
      exerciseName:dayIndex===1&&i===0?'Ejercicio original':'Ejercicio '+i,
      prescriptionExerciseId:'pid-'+dayIndex+'-'+i,sets:Array.from({length:count},()=>({}))}))}))};
  const entries = {done_1_0:{ts:20,fromHistory:true,autoClosed:true},done_1_1:{ts:21,fromHistory:true,autoClosed:true},done_1_2:true};
  sizes.forEach((counts,d)=>counts.forEach((n,i)=>{for(let s=0;s<n;s++) entries['log_1_'+d+'_'+i+'_s'+s]={done:true,ts:1700000000000,carga:'30',reps:'8',rir_real:'0',unit:'KG',prescriptionExerciseId:'pid-'+d+'-'+i};}));
  return {plan,meso:{planId:old,entries}};
}
function scope(data,{hash='#historial-vdsen='+payload,uid='owner', planId=active, hold=false, mesoMetadata={fromCache:false,hasPendingWrites:false}}={}){
  const calls=[], kids=[], logState={done_1_0:false}; let release, started;
  const readStarted = new Promise(resolve=>{started=resolve;});
  function element(tag){return {tag,textContent:'',children:[],append(e){this.children.push(e);}, remove(){const i=kids.indexOf(this);if(i>=0)kids.splice(i,1);}};}
  const host={style:{},append(e){kids.push(e);}};
  const snap=(d, metadata={fromCache:false,hasPendingWrites:false})=>({exists:()=>true,metadata,data:()=>d});
  const ctx={USER:{uid},ACTIVE_PLAN_ID:planId,LOGS:logState,location:{hash},TextEncoder,
    window:{crypto:webcrypto,addEventListener(){}},
    document:{getElementById:id=>kids.find(el=>el.id===id)??null,createElement:element},
    FB:{auth:{currentUser:{uid}},doc:(_, ...path)=>path,db:{},getDocFromServer:async path=>{
      calls.push(path);
      started();
      if(hold && path[0]==='plans') await new Promise(r=>{release=r});
      return path[0]==='plans'?snap(data.plan):snap(data.meso,mesoMetadata);
    }}};
  vm.createContext(ctx);
  vm.runInContext(source.replace(/'([a-f0-9]{64})'/,"'"+digest+"'"),ctx);
  return {ctx,calls,kids,host,readStarted,release:()=>release?.()};
}
function content(x){return (x.textContent||'')+' '+x.children.map(content).join(' ');}
test('only original 19/11 history is rendered; no mutating API or active completion effects',async()=>{
  const x=scope(fixture());
  await x.ctx._renderOriginalSessionsPanel(x.host);
  assert.deepEqual(x.calls,[['plans',old],['logs','owner','mesos',old]]);
  assert.equal(x.kids.length,1);
  assert.match(content(x.kids[0]),/D1 · Registrada en el plan anterior · cierre automático · 19 series/);
  assert.match(content(x.kids[0]),/D2 · Registrada en el plan anterior · cierre automático · 11 series/);
  assert.match(content(x.kids[0]),/Ejercicio original/);
  assert.match(content(x.kids[0]),/30 KG · 8 reps · RIR 0/);
  assert.doesNotMatch(content(x.kids[0]),/Hip Thrust|D3/);
  assert.deepEqual(x.ctx.LOGS,{done_1_0:false});
  assert.equal(x.ctx.ACTIVE_PLAN_ID,active);
  assert.doesNotMatch(source,/\b(setDoc|updateDoc|runTransaction|localStorage|sessionStorage|calculateProgression)\b/);
});
test('ordinary, tampered, and changed-active navigation read nothing',async()=>{
  for(const options of [{hash:''},{hash:'#historial-vdsen=b'+payload.slice(1)},{planId:old}]){
    const x=scope(fixture(),options);await x.ctx._renderOriginalSessionsPanel(x.host);
    assert.deepEqual(x.calls,[]);assert.deepEqual(x.kids,[]);
  }
});
test('different account cannot fetch another user mesocycle; missing binding fails closed',async()=>{
  for(const [data,opts] of [[fixture(),{uid:'other'}],[fixture(),{}]]){
    if(!opts.uid)data.plan.supersededBy='another';
    const x=scope(data,opts); await x.ctx._renderOriginalSessionsPanel(x.host);
    assert.deepEqual(x.calls,[['plans',old]]);assert.deepEqual(x.kids,[]);
  }
});
test('stale auth or changed fragment cancels in-flight rendering',async()=>{
  const x=scope(fixture(),{hold:true});const pending=x.ctx._renderOriginalSessionsPanel(x.host);
  await x.readStarted;
  assert.equal(x.calls.length,1);
  x.ctx.USER={uid:'other'};x.ctx.FB.auth.currentUser=x.ctx.USER;
  x.ctx._clearHistoricalView();x.release();await pending;
  assert.equal(x.calls.length,1);assert.deepEqual(x.kids,[]);
});
test('completion is never inferred from counts; identity/count mismatches close whole view',()=>{
  const data=fixture(), x=scope(data);
  assert.equal(x.ctx._collectOriginalWeekOne(data.plan,{entries:data.meso.entries},old),null);
  assert.equal(x.ctx._collectOriginalWeekOne(data.plan,{...data.meso,planId:active},old),null);
  data.meso.entries.done_1_1={ts:21,partial:true};
  assert.equal(x.ctx._collectOriginalWeekOne(data.plan,data.meso,old)[1].completed,false);
  data.meso.entries.log_1_0_0_s0.autoFilled=true;
  assert.equal(x.ctx._collectOriginalWeekOne(data.plan,data.meso,old),null);
  data.meso.entries.log_1_0_0_s0.autoFilled=false;
  data.meso.entries.log_1_0_0_s0.prescriptionExerciseId='different';
  assert.equal(x.ctx._collectOriginalWeekOne(data.plan,data.meso,old),null);
});

test('cached and local-pending snapshots never enter the historical display',async()=>{
  const runs = [{fromCache:true,hasPendingWrites:false},{fromCache:false,hasPendingWrites:true}];
  for(const mesoMetadata of runs){
    const x=scope(fixture(),{mesoMetadata}); await x.ctx._renderOriginalSessionsPanel(x.host);
    assert.equal(x.calls.length,2);assert.deepEqual(x.kids,[]);
  }
});
test('an already loaded panel cannot be repainted from memory with a changed credential fragment',async()=>{
  const x=scope(fixture());await x.ctx._renderOriginalSessionsPanel(x.host);
  assert.equal(x.kids.length,1);x.kids[0].remove();
  x.ctx.location.hash='#historial-vdsen=b'+payload.slice(1);
  await x.ctx._renderOriginalSessionsPanel(x.host);
  assert.equal(x.calls.length,2);assert.deepEqual(x.kids,[]);
});
