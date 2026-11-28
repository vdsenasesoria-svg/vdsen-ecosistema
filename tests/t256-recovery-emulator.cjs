'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {initializeApp,deleteApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');
const ops = require('../scripts/pilot/numeric-cohort-ops.cjs');
const {buildServedCohortProbePayload} = require('../api/_planActivationSync.js');
const state = require('../.release/vdsen-client.json');

const appLane = require('../scripts/release/app-live.cjs');
const guardLib = require('../scripts/release/numeric-guard.cjs');
const {restoreOffRuntime} = require('../scripts/pilot/numeric-runtime-prep.cjs');
const modes = {
  'app-fail':'T256 STOP → failed APP-ONLY → protected recovery and full ARM',
  'provenance-fail':'T256 APP-ONLY → synchronized provenance → failed numeric prepare → protected recovery and full ARM',
  'resume':'T256 resumes partial ARM, rejects a lost lock and verifies ambiguous promotion rollback',
};

for (const [mode,title] of Object.entries(modes)) test(title, async () => {
  const projectId = process.env.GCLOUD_PROJECT;
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  assert.match(projectId || '', /^demo-/);
  assert.match(host || '', /^127\.0\.0\.1:\d+$/);
  const app = initializeApp({projectId}, 't256-recovery-'+mode);
  const db = getFirestore(app);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'vdsen-t256-'));
  try {
    const coachId = 'fixture-recovery-coach';
    const runtimeSha = state.runtime_sha;
    const operationId = 'FIXTURE-RECOVERY-256-'+mode;
    const startsAt = new Date(Date.now()-60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const expiresAt = new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const deploymentId = 'dpl_fixtureRecovery';
    const deploymentHost = 'fixture-recovery.vercel.app';
    const cohortIds = ['cohort-01','cohort-02','cohort-03'];
    const clients = Array.from({length:25}, (_, i) => ({
      _id:'fixture-client-'+String(i).padStart(2,'0'), coachId, status:'activo', activePlanId:'fixture-plan-'+i,
    }));
    const plans = {};
    const batch = db.batch();
    for (const [i,client] of clients.entries()) {
      const pids = Array.from({length:i < 11 ? 34 : 33}, (_, j) => ({
        prescriptionExerciseId:'fixture-pid-'+i+'-'+j,
      }));
      plans[client.activePlanId] = {
        clientId:client._id, coachId, status:'active', updatedAt:startsAt, days:[{exercises:pids}],
      };
      batch.set(db.doc('clients/'+client._id),client);
      batch.set(db.doc('plans/'+client.activePlanId),plans[client.activePlanId]);
    }
    const savedLog = {planId:clients[0].activePlanId,entries:{log_1_0_0_s0:{done:true,reps:10}}};
    const logRef = db.doc('logs/'+clients[0]._id+'/mesos/'+clients[0].activePlanId);
    batch.set(logRef,savedLog);
    const lockPath = 'releaseControl/numericPilotGlobalLock';
    batch.set(db.doc(lockPath),{status:'IDLE',activeOperationId:null,version:10,pendingQueue:[]});
    batch.set(db.doc('coaches/'+coachId),{autoApplyCanary:{enabled:true,cohorts:{}}});
    for (const cid of cohortIds) {
      batch.set(db.doc('releaseControl/autonomousProgression_cohort_'+cid),{enabled:true});
      batch.set(db.doc('releaseControl/numericPilot_cohort_'+cid),{enabled:true});
    }
    await batch.commit();
    const commercialRosterPath = path.join(scratch,'roster.json');
    fs.writeFileSync(commercialRosterPath, JSON.stringify({
      schema:'vdsen-commercial-roster-v1', firebaseProject:'vdsen-ecosistema',
      confirmedAt:startsAt, confirmedBy:'owner', activeUids:clients.map(c=>c._id), inactiveUids:[],
    }));
    const manifest = ops.buildCohortsFromRoster(clients,plans,{runtimeSha,operationId,startsAt,expiresAt});
    assert.equal(manifest.totalEligiblePids,836);
    const shards = manifest.cohorts.flatMap(c=>c.envShards);
    assert.equal(shards.length,5);
    const seal = ops.sealRecoveryShards(manifest,state.production_deployment,runtimeSha,expiresAt,coachId);
    const env = Object.fromEntries(shards.map(s=>[s.name,JSON.stringify(s.windows)]));
    env.VERCEL_DEPLOYMENT_ID = deploymentId;
    env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA = runtimeSha;
    let loseLockBeforeCommit = false;
    let liveAlias = mode === 'resume' ? deploymentId : 'dpl_fixtureLive';
    const providerDeployment = {id:deploymentId, url:deploymentHost, target:'production', readyState:'READY',
      projectId:state.production_project, teamId:state.vercel_team, meta:{githubCommitSha:runtimeSha,vdsenRecoverySeal:seal},
      env:[...shards.map(s=>s.name), 'AUTONOMOUS_PROGRESSION_ENABLED', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED',
        'VDSEN_NUMERIC_PILOT_ENABLED','VDSEN_NUMERIC_PILOT_RUNTIME_SHA']};
    const fetcher = async (input, opts = {}) => {
      const url = new URL(input);
      if (url.hostname === 'firestore.googleapis.com') {
        assert.ok(url.pathname.startsWith('/v1/projects/'+projectId+'/'));
        if (loseLockBeforeCommit && url.pathname.endsWith(':commit')) {
          loseLockBeforeCommit = false;
          await db.doc(lockPath).update({status:'REQUESTED',activeOperationId:'fixture-other',version:11});
        }
        return fetch('http://'+host+url.pathname+url.search,
          {...opts,headers:{...opts.headers,authorization:'Bearer owner'}});
      }
      if (url.hostname === 'api.vercel.com') {
        if (url.pathname.startsWith('/v2/aliases/')) return Response.json({deploymentId:liveAlias});
        if (url.pathname.startsWith('/v9/projects/')) return Response.json({envs:[]});
        assert.equal(url.pathname,'/v13/deployments/'+deploymentId);
        return Response.json(providerDeployment);
      }
      assert.equal(url.hostname,deploymentHost);
      assert.equal(opts.headers.authorization,'Bearer fixture-probe-id');
      return Response.json(buildServedCohortProbePayload(env,url.searchParams.get('cohortId')));
    };
    const opts = {projectId,googleToken:'fixture',vercelToken:'fixture',deploymentId,coachId,runtimeSha,
      operationId,startsAt,expiresAt,commercialRosterPath,fetcher,acquireProbeIdentity:async ()=>'fixture-probe-id'};
    for (const cohortId of cohortIds) {
      const stop = await ops.stopCohorts({...opts,targetCohortId:cohortId});
      assert.equal(stop.status,'STOPPED_VERIFIED');
    }
    if (mode !== 'resume') {
      const currentApp = async () => liveAlias;
      const moveAlias = async id => { liveAlias = id; };
      const off = await restoreOffRuntime({
        baseline:{deployment:state.production_deployment,runtimeSha}, pilotDeploymentId:'dpl_fixtureLive',
      }, {current:currentApp, rollback:moveAlias, verifyBytes:async () => ['vdsen-cliente.html']});
      assert.equal(off.runtimeRestored,true);
      assert.equal(liveAlias,state.production_deployment);
      // Real APP-ONLY apply machinery consumes the same artifact shape as its workflow.
      const nextSha = 'a'.repeat(40);
      const target = 'dpl_fixtureUpdatedOff';
      const run = process.env.GITHUB_RUN_ID || 'local';
      const guard = () => guardLib.evaluateProductionEnv([], {
        project:state.production_project, team:state.vercel_team, runtimeSha:nextSha,
      });
      const put = (name, data) => fs.writeFileSync(path.join(scratch,name),JSON.stringify(data));
      put('app-preflight.json',{release_id:run,runtime_sha:nextSha,candidate:target,
        production_deployment:state.production_deployment,rollback_artifact:'app-rollback-test.json',numeric_guard:guard()});
      put('app-rollback-test.json',{release_id:run,candidate_sha:nextSha,candidate_deployment:target,
        production_deployment:state.production_deployment,production_runtime_sha:runtimeSha,
        production_project:state.production_project,vercel_team:state.vercel_team,production_origin:state.production_origin,
        main_sha:'b'.repeat(40),captured_at:startsAt});
      const previousOut = appLane.getOut();
      const previousSha = process.env.APP_RUNTIME_SHA;
      const apply = () => appLane.apply({
        currentApp, numericGuard:async()=>guard(),
        promote:async (_,id)=>{
          if (mode === 'app-fail') throw new Error('FIXTURE_APP_ONLY_FAILURE');
          await moveAlias(id);
        },
        deployment:async (_,id)=>({id,readyState:'READY',projectId:state.production_project,teamId:state.vercel_team,
          meta:{githubCommitSha:id===target?nextSha:runtimeSha}}),
        servedSurface:()=>['vdsen-cliente.html'],verifyPublicBytes:async()=>['vdsen-cliente.html'],
      });
      try {
        appLane.setOut(scratch);
        process.env.APP_RUNTIME_SHA = nextSha;
        if (mode === 'app-fail') {
          await assert.rejects(apply(), /FIXTURE_APP_ONLY_FAILURE/);
          assert.equal(liveAlias,state.production_deployment);
          assert.equal(JSON.parse(fs.readFileSync(path.join(scratch,'app-result.json'))).app_release_status,'FAIL');
        } else {
          const published = await apply();
          assert.equal(published.app_release_status,'SUCCESS');
          opts.releaseState = {...state,runtime_sha:published.runtime_sha,production_deployment:published.production_deployment,
            app_release:{runtime_sha:published.runtime_sha,deployment:published.production_deployment,
              previous_runtime_sha:runtimeSha,previous_deployment:published.previous_deployment,source_release_run:'123'}};
          assert.equal(liveAlias,target);
        }
      } finally {
        appLane.setOut(previousOut);
        if (previousSha === undefined) delete process.env.APP_RUNTIME_SHA;
        else process.env.APP_RUNTIME_SHA = previousSha;
      }
      const appAdapter = {
        currentApp, promote:async (_,id)=>moveAlias(id), revertApp:async (_,id)=>moveAlias(id),
        deployment:async()=>providerDeployment, servedSurface:()=>['vdsen-cliente.html'],
        verifyPublicBytes:async()=>['vdsen-cliente.html'], exportCandidateTree:()=>{}, verifyExportedTree:()=>{},
        runVercelCli:async()=>({code:1,err:'FIXTURE_NUMERIC_PREPARE_FAILURE'}),
      };
      const outFile = path.join(scratch,'numeric-result.json');
      if (mode === 'provenance-fail') {
        await assert.rejects(ops.prepareFleetRuntime({...opts,outFile,app:appAdapter,runtimeSha:nextSha}), /FIXTURE_NUMERIC_PREPARE_FAILURE/);
        assert.equal(liveAlias,target);
      }
      const recovered = await ops.prepareFleetRuntime({...opts,outFile,app:appAdapter,stagedRecoveryId:deploymentId});
      assert.equal(recovered.status,'FLEET_RUNTIME_READY_FENCES_CLOSED');
      assert.equal(liveAlias,deploymentId);
      for (const cohortId of cohortIds) {
        assert.equal((await ops.armCohort({...opts,cohortId})).status,'COHORT_ARMED_VERIFIED');
      }
      const recoveredFleet = await ops.auditFleet(opts);
      assert.ok(recoveredFleet.exactCoverageVerified && recoveredFleet.allCohortsArmed);
      assert.equal(recoveredFleet.eligibleCount,25);
      assert.equal(recoveredFleet.totalEligiblePids,836);
      assert.deepEqual((await logRef.get()).data(),savedLog);
      return;
    }
    assert.equal((await ops.armCohort({...opts,cohortId:cohortIds[0]})).status,'COHORT_ARMED_VERIFIED');
    loseLockBeforeCommit = true;
    await assert.rejects(ops.armCohort({...opts,cohortId:cohortIds[1]}), /FS_COMMIT_FAILED/);
    assert.equal((await db.doc(lockPath).get()).get('activeOperationId'),'fixture-other');
    assert.equal((await db.doc('releaseControl/numericPilot_cohort_cohort-02').get()).get('enabled'),false);
    const secondOperation = manifest.cohorts[1].operationId;
    assert.equal((await db.doc('releaseControl/numericPilot/operations/'+secondOperation).get()).exists,false);
    // The demo operator confirms the contender is finished before clearing the lock.
    await db.doc(lockPath).update({status:'IDLE',activeOperationId:null,version:12});
    for (const cohortId of cohortIds.slice(1)) {
      assert.equal((await ops.armCohort({...opts,cohortId})).status,'COHORT_ARMED_VERIFIED');
    }
    const audit = await ops.auditFleet(opts);
    assert.ok(audit.exactCoverageVerified && audit.allCohortsArmed);
    assert.equal(audit.eligibleCount,25);
    assert.equal(audit.totalEligiblePids,836);

    const renewId = 'FIXTURE-AMBIGUOUS-256';
    const renewPath = 'releaseControl/numericPilot/operations/'+renewId;
    await db.doc(renewPath).set({operationId:renewId, status:'REQUESTED', cohortId:'cohort-03',
      clientId:clients[24]._id, coachUid:coachId, planId:clients[24].activePlanId,
      runtimeSha, startsAt, expiresAt, lockVersion:13, history:[]});
    await db.doc(lockPath).set({status:'REQUESTED',activeOperationId:renewId,version:13,
      pendingQueue:[],leaseExpiresAt:expiresAt});
    const base = 'https://firestore.googleapis.com/v1/projects/'+projectId+'/databases/(default)/documents';
    let alias = deploymentId;
    const readRaw = async p => {
      const response = await fetcher(base+'/'+p);
      if (response.status === 404) return null;
      assert.equal(response.status,200);
      return response.json();
    };
    const guard = require('../scripts/release/numeric-guard.cjs').evaluateProductionEnv([], {
      project:state.production_project, team:state.vercel_team, runtimeSha,
    });
    const before = (await db.doc('releaseControl/numericPilot_cohort_cohort-03').get()).updateTime.toMillis();
    const result = await ops.executeRenewCohortOperation({projectId,operationId:renewId,io:{
      readDoc:async p=>(await db.doc(p).get()).data()||null,
      writeDoc:(p,data)=>db.doc(p).set(data),
      readVersion:readRaw,
      commitVersion:async writes=>{
        const response = await fetcher(base+':commit',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({writes})});
        assert.equal(response.status,200);
        return response.json();
      },
      loadLiveRoster:async options=>ops.buildCohortsFromRoster(clients,plans,options),
      currentApp:async()=>alias,
      checkNumericGuardOff:async()=>guard,
      baselineState:state,
      buildDeployment:async()=>({deploymentId:'dpl_fixtureAmbiguous'}),
      verifyCandidate:async()=>({verified:true}),
      promoteDeployment:async({deploymentId:id})=>{alias=id;throw new Error('FIXTURE_PROMOTION_TIMEOUT');},
      revertDeployment:async id=>{alias=id;return {restored:true};},
    }});
    assert.equal(result.status,'ROLLED_BACK_VERIFIED');
    assert.equal(alias,deploymentId);
    assert.equal((await db.doc(renewPath).get()).get('status'),'ROLLED_BACK_VERIFIED');
    assert.equal((await db.doc(lockPath).get()).get('status'),'IDLE');
    assert.equal((await db.doc('releaseControl/numericPilot_cohort_cohort-03').get()).updateTime.toMillis(),before);
  } finally {
    await deleteApp(app);
    for (const entry of fs.readdirSync(scratch,{withFileTypes:true})) {
      assert.ok(entry.isFile());
      fs.unlinkSync(path.join(scratch,entry.name));
    }
    fs.rmdirSync(scratch);
  }
});
