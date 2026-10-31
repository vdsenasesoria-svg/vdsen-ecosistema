'use strict';
// One integrated proof: real Client controls, authenticated handler, canonical resolver and Coach read adapter.
// Synthetic users only; the shared fixture helper pins BOTH SDKs to local demo emulators.
const fs = require('node:fs'), path = require('node:path'), {spawn} = require('node:child_process');
const {chromium} = require('playwright-core'), L = require('../e2e-t599r/lib.cjs');
const OUT = path.join(L.root,'release-output','t676'), ORIGIN = 'http://localhost:5276';
const checks = [], evidence = {};
// `sts` is a server timestamp independently assigned to each write, so equality of execution fields excludes only that per-document timestamp.
function sameEntry(a,b) { if (!a || !b) return false; const {sts: _a,...x}=a, {sts: _b,...y}=b; return JSON.stringify(x)===JSON.stringify(y); }
function must(name,ok,detail) { checks.push({name,ok:!!ok,detail}); console.log((ok?'PASS ':'FAIL ')+name+' '+JSON.stringify(detail||'').slice(0,250)); if(!ok) throw Error(name); }
async function until(fn, ms=30000) { const t=Date.now(); let v; while(Date.now()-t<ms) { v=await fn(); if(v)return v; await L.sleep(300); } throw Error('Timed out waiting for '+fn.toString().slice(0,140)); }
const ex = (name,muscleGroup,load,rir=2,real=2,ics=7,more={}) => ({name,muscleGroup,sets:L.S(3,10,rir,90),w1:{load,reps:10,rir,rirReal:real,ics},...more});
const specs = [ex('T676 Press LOAD','pectoral',100,2,3),ex('T676 Curl REPS','biceps',60,1,2,7,{repsRange:{min:8,max:12}}),
  ex('T676 Remo SETS','dorsal_ancho',80,2,2,8),ex('T676 Extensión REST','triceps',40),ex('T676 Bayesian FREEZE','braquial',30),
  ex('T676 Mantener','delt_lateral',20),ex('T676 Primera exposición','gastrocnemio',20,2,2,7,{w1:undefined}),
  {name:'T676 Cardio','exerciseType':'cardio',duracionMin:20,sets:[]}];
const dimensions = ['LOAD','REPS','SETS','REST','FREEZE'];
async function boot(browser,label,intercept) {
  const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await ctx.newPage();
  // Reject external runtime requests; only the local server proxies the public, pinned SDK source.
  await ctx.route('**/*',route=>{ const u=new URL(route.request().url()); return ['localhost','127.0.0.1'].includes(u.hostname)||['blob:','data:'].includes(u.protocol)?route.continue():route.abort(); });
  if(intercept) await page.route('**/api/autonomous-progression-trigger',intercept);
  await page.goto(ORIGIN+'/cliente');await page.addScriptTag({url:'/__driver.js'});await page.evaluate(who=>window.__boot(who),label);
  await page.waitForFunction(()=>typeof window.selDia==='function'); await training(page); return {ctx,page};
}
async function training(page) { await page.evaluate(()=>{ const b=[...document.querySelectorAll('button')].find(x=>/Ahora no/i.test(x.textContent)&&x.offsetParent);b&&b.click();window.goTab(1);window.setEjActivo(0);}); }
async function view(page,ei=0) { return page.evaluate(i=>{window.setEjActivo(i);const e=getSesiones()[0].exercises[i];return {week:CURRENT_WEEK,sets:e.sets,numSeries:e.numSeries,targets:[...document.querySelectorAll('[data-effective-target]')].map(x=>x.innerText),state:document.querySelector('[data-progression-state]')?.dataset.progressionState};},ei); }
async function save(page,ei,si,v) { await page.evaluate(async x=>{window.stopRestTimer();return window.__logSet(0,x.ei,x.si,x.v);},{ei,si,v}); }
async function singleSession(page,real=4,post={}) {
  for(let s=0;s<3;s++)await save(page,0,s,{carga:100,reps:10,rir:real,ics:7,pump:1});
  await page.evaluate(p=>window.__finish(0,p),post);
}
(async()=>{
  fs.mkdirSync(OUT,{recursive:true}); let browser,server,fd;
  try {
    // The excluded athlete shares the Coach but is absent from BOTH allowlists after the main fixture is seeded.
    const other=await L.seedAthlete('T676OTHER',[ex('T676 Aislado','pectoral',100)]);
    const a=await L.seedAthlete('T676MAIN',specs,{coach:other.coach,planExtra:{musclePriorities:{PRIORITARIO:['dorsal_ancho'],NO_PRIORITARIO:['triceps']}}});
    const originalPlan=(await L.db.doc('plans/'+a.planId).get()).data(), originalHistory=JSON.stringify((await L.meso(a)).entries);
    fd=fs.openSync(path.join(OUT,'server.log'),'w');
    server=spawn(process.execPath,[path.join(__dirname,'serve.cjs'),L.root,'5276'],{env:{...process.env,E2E_NUMERIC:'1'},stdio:['ignore',fd,fd]});
    await until(async()=>{try{return(await fetch(ORIGIN+'/__trigger-log')).ok;}catch(_){return false;}},20000);
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    let blocked=true,lost=false,attempts=0;
    const intercept=async route=>{
      attempts++;
      if(blocked)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"SYNTHETIC_TRANSIENT_FAILURE"}'});
      if(!lost) {lost=true;await route.fetch();return route.abort('failed');} // Server commits, response is lost; the real retry must be harmless.
      return route.continue();
    };
    const b=await boot(browser,a.label,intercept);
    const denied=await b.page.evaluate(async uid=>{try {await FB.getDoc(FB.doc(FB.db,'logs',uid));return false;}catch(e){return e.code==='permission-denied';}},other.uid);
    must('emulator enforces Rules and denies another athlete log',denied);
    for(let ei=0;ei<7;ei++)for(let si=0;si<3;si++)await save(b.page,ei,si,{carga:specs[ei].w1?.load||20,reps:ei===3?[10,10,8][si]:10,rir:ei===0?4:ei===4?0:2,ics:ei===2?8:7,pump:1});
    await b.page.evaluate(()=>{window.setEjActivo(7);const key='log_'+CURRENT_WEEK+'_0_7';document.getElementById('card_dur_'+key).value='20';document.getElementById('card_eff_'+key).value='6';window.completeCardio(key,0,7);});
    await b.page.evaluate(()=>window.__finish(0,{durationMinutes:60}));
    let m=await L.meso(a),root=await L.root_(a);
    const sourceKeys=Object.keys(m.entries).filter(k=>/^log_2_0_/.test(k));
    must('A session saved and closed through real Client controls despite HTTP failures',!!m.entries.done_2_0&&sourceKeys.length===22&&sourceKeys.every(k=>sameEntry(m.entries[k],root.entries[k])),{done:!!m.entries.done_2_0,sourceKeys,unequal:sourceKeys.filter(k=>!sameEntry(m.entries[k],root.entries[k])),attempts});
    must('no canonical application fabricated while delivery is unavailable',L.recordsOf(m).length===0&&L.overlaysOf(m).length===0);
    const pendingKey='vdsen_progression_pending_v1:'+a.uid+':'+a.planId;
    must('failed notification is durable across reload',await b.page.evaluate(k=>!!localStorage.getItem(k),pendingKey));
    const sessionBefore=Object.fromEntries(Object.entries(m.entries).filter(([k])=>k.startsWith('log_2_0_')||k==='done_2_0'||k==='postsession_2_0'));
    // Reload preserves localStorage + authenticated persistence. No manual trigger or direct handler invocation.
    blocked=false;await b.page.reload();await b.page.addScriptTag({url:'/__driver.js'});
    await b.page.evaluate(async()=>{const s=document.getElementById('clientModuleSrc');await import(URL.createObjectURL(new Blob([s.textContent],{type:'text/javascript'})));});
    await b.page.waitForFunction(()=>typeof window.selDia==='function'&&document.getElementById('tabEntr'),{timeout:20000});
    await until(async()=>L.overlaysOf(await L.meso(a)).length===5);await training(b.page);
    m=await L.meso(a);
    evidence.main={records:L.recordsOf(m).map(L.slim),overlays:L.overlaysOf(m).map(L.slimOv)};
    must('B C D autonomous recovery materializes canonical decisions and five overlays',dimensions.every((d,i)=>L.ovFor(m,a.pids[i]).some(o=>o.dimension===d&&o.status==='APPLIED')),evidence.main.overlays);
    const maintain=L.recFor(m,a.pids[5]),insufficient=L.recFor(m,a.pids[6]);
    must('maintenance and insufficient evidence preserve prescription with explicit reasons',!L.ovFor(m,a.pids[5]).length&&!L.ovFor(m,a.pids[6]).length&&JSON.stringify(maintain).includes('NO_ADJUSTMENT_NEEDED')&&JSON.stringify(insufficient).includes('INSUFFICIENT_COMPARABLE_EXPOSURES'),{maintain:maintain.map(L.slim),insufficient:insufficient.map(L.slim)});
    const monitoring=L.recFor(m,a.pids[0])[0]?.sraTrace?.inputEvidence?.sessionMonitoring;
    must('template context is persisted with real 60 min x sRPE 7; contextual only',monitoring?.sessions.some(s=>s.loadAU===420&&s.workingSets===21)&&monitoring.numericApplyEnabled===false,monitoring);
    const c=m.entries.log_2_0_7;
    must('cardio stores actual minutes and RPE once, with no invented strength series or decision',c?.exType==='cardio'&&Number(c.duracionMin)===20&&Number(c.rpe)===6&&!Object.keys(m.entries).some(k=>/^log_2_0_7_s/.test(k))&&!L.recFor(m,a.pids[7]).length,c);
    const views=[];
    for(let i=0;i<5;i++){const ov=L.ovFor(m,a.pids[i])[0];await until(async()=>{const v=await view(b.page,i);return v.week===3&&v.state==='APPLIED';});const v=await view(b.page,i);views.push(v);
      must('E live next prescription '+dimensions[i],v.sets.length===(i===2?4:3)&&(i===0?v.sets.every(s=>s.load===105):i===1?v.sets.every(s=>s.repsTarget===11):i===3?v.sets.every(s=>s.restSeconds===120):i===4?v.sets.every(s=>s.load===30):true),v);
      must('target DOM reflects canonical '+dimensions[i],v.targets.some(t=>t.includes('OBJETIVO DE ESTA SERIE'))&&ov.status==='APPLIED');
    }
    await b.page.screenshot({path:path.join(OUT,'live-next-prescription.png'),fullPage:true});
    const appliedKeys=L.recordsOf(m).map(r=>r.key).sort();
    for(let i=0;i<5;i++){const v=views[i].sets[0];await save(b.page,i,0,{carga:v.load||specs[i].w1.load,reps:v.repsTarget,rir:v.rirTarget,ics:7,pump:1});}
    await until(async()=>{const current=await L.meso(a);return dimensions.every((_,i)=>L.ovFor(current,a.pids[i])[0]?.status==='CONSUMED');});
    m=await L.meso(a);const receipts=JSON.stringify(m.consumptionReceipts),afterKeys=L.recordsOf(m).map(r=>r.key).sort();
    must('F each following exposure consumes its canonical record once',Object.keys(m.consumptionReceipts||{}).length===5&&dimensions.every((_,i)=>L.recFor(m,a.pids[i])[0].state==='CONSUMED'));
    await b.page.evaluate(()=>window.dispatchEvent(new Event('online')));await L.sleep(2200);
    m=await L.meso(a);
    must('G lost response and automatic retries create no duplicate records or receipts',lost&&attempts>2&&JSON.stringify(appliedKeys)===JSON.stringify(afterKeys)&&JSON.stringify(m.consumptionReceipts)===receipts,{attempts,records:L.recordsOf(m).length,receipts:Object.keys(m.consumptionReceipts).length});
    must('J prior history, closed source session and Coach plan remain intact',JSON.stringify(Object.fromEntries(Object.entries(m.entries).filter(([k])=>/^log_1_|^done_1_/.test(k))))===originalHistory&&Object.entries(sessionBefore).every(([k,v])=>JSON.stringify(m.entries[k])===JSON.stringify(v))&&JSON.stringify((await L.db.doc('plans/'+a.planId).get()).data())===JSON.stringify(originalPlan));
    // Read through the actual Coach adapter under a separate, authenticated Coach SDK (Rules apply).
    const coachCtx=await browser.newContext(),cp=await coachCtx.newPage();await cp.goto(ORIGIN+'/__trigger-log');await cp.addScriptTag({url:'/assets/client-export/firestore-io.js'});
    const coachView=await cp.evaluate(async ({coach,uid,planId})=>{
      const A=await import('/gs/firebase-app.js'),AU=await import('/gs/firebase-auth.js'),F=await import('/gs/firebase-firestore.js');
      const app=A.initializeApp({apiKey:'demo-key',projectId:'demo-vdsen-client-e2e',authDomain:'demo-vdsen-client-e2e.firebaseapp.com'},'t676-coach');
      const auth=AU.getAuth(app);AU.connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});const db=F.getFirestore(app);F.connectFirestoreEmulator(db,'127.0.0.1',8085);
      await AU.signInWithEmailAndPassword(auth,coach.email,coach.password);const io=VDSEN_CE_FIRESTORE_IO.create({...F,db});const root=await io.getDoc('logs',uid),mesos=await io.listSub('logs',uid,'mesos');const m=mesos.find(x=>x.id===planId)?.data;
      return {rootEntries:root?.data.entries,mesoEntries:m?.entries,overlays:m?.nextExposureOverlays,receipts:m?.consumptionReceipts};
    },{coach:a.coach,uid:a.uid,planId:a.planId});
    must('Coach authorized data adapter reads the same logbook and consumed overlays',JSON.stringify(coachView.receipts)===receipts&&Object.values(coachView.overlays).every(o=>o.status==='CONSUMED')&&sourceKeys.every(k=>sameEntry(coachView.rootEntries[k],coachView.mesoEntries[k])));
    await coachCtx.close();await b.ctx.close();
    const ob=await boot(browser,other.label);await singleSession(ob.page);const om=await L.meso(other);
    must('I another client has persisted execution but zero numerical applications',!!om.entries.done_2_0&&!L.recordsOf(om).length&&!L.overlaysOf(om).length);await ob.ctx.close();
    const d=await L.seedAthlete('T676DELOAD',[ex('T676 Sentadilla','cuadriceps',100)],{planExtra:{rirByWeek:{3:4}}}),bd=await boot(browser,d.label);
    await singleSession(bd.page,2,{sleep:'5',rpe:'10',durationMinutes:60});await until(async()=>L.overlaysOf(await L.meso(d)).length===1);
    const dm=await L.meso(d),dov=L.overlaysOf(dm)[0],dv=await view(bd.page);
    must('reactive DELOAD and plan-owned RIR reach live prescription',dov.dimension==='DELOAD'&&dov.components.SETS===2&&dov.components.LOAD===90&&dov.components.RIR===4&&dv.sets.length===2&&dv.sets.every(s=>s.load===90&&s.rirTarget===4),{overlay:L.slimOv(dov),view:dv});await bd.ctx.close();
    const expired=await L.seedAthlete('T676EXPIRED',[ex('T676 Vencido','pectoral',100)]);
    await L.db.doc('releaseControl/autonomousProgression').update({expiresAt:new Date(Date.now()-1000).toISOString()});
    const be=await boot(browser,expired.label);await singleSession(be.page);const em=await L.meso(expired);
    must('H expired canary preserves the session and blocks all canonical applications',!!em.entries.done_2_0&&!L.recordsOf(em).length&&!L.overlaysOf(em).length);
    await be.ctx.close();evidence.productionMutations=0;
  }catch(e){checks.push({name:'integrated cycle completed',ok:false,detail:e.stack});console.error(e.stack);}
  finally{if(browser)await browser.close();if(server)server.kill();if(fd!==undefined)fs.closeSync(fd);await L.admin.app('t599r').delete();}
  fs.writeFileSync(path.join(OUT,'functional-result.json'),JSON.stringify({project:L.PROJECT,checks,evidence},null,2));
  const failed=checks.filter(c=>!c.ok).length;console.log(`${checks.length-failed}/${checks.length} checks passed`);process.exitCode=failed?1:0;
})();
