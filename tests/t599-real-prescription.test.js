'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const F = require('./helpers/lifecycle-fixture.js');
const eff = require('../assets/progression-effective-prescription.js');
const source = fs.readFileSync('vdsen-cliente.html', 'utf8');
function applied(dimension, value, extra = {}) {
  const a = F.applied(F.scenario());
  Object.assign(a.overlay, { dimension, appliedValue: value, unit: dimension === 'REST' ? 'SECONDS' : ['SETS','DELOAD'].includes(dimension) ? 'SETS' : 'KG' }, extra);
  return F.effectiveInput(a, { canonicalOverlayRead: true, unit: 'KG' });
}
test('T599 FREEZE binds the authorized historical load even when Coach prescribed no kg', () => {
  const input = applied('FREEZE', 10); const r = eff.resolveEffective(input);
  assert.ok(r.sets.every(s => s.effective.load === 10)); assert.equal(r.appliedValue, 10);
  assert.equal(eff.describeProgression(input).hasAppliedLoad, true);
});
test('T599 every authorized dimension reaches the effective set, including the entire DELOAD', () => {
  for (const [dim, value, field] of [['LOAD',12.5,'load'],['REPS',9,'repsTarget'],['REST',180,'restSeconds']]) {
    const r = eff.resolveEffective(applied(dim,value)); assert.ok(r.sets.every(s => s.effective[field] === value));
  }
  assert.equal(eff.resolveEffective(applied('SETS',4)).sets.length,4);
  const r = eff.resolveEffective(applied('DELOAD',2,{loadUnit:'KG',components:{SETS:2,LOAD:9,RIR:3}}));
  assert.equal(r.sets.length,2); assert.ok(r.sets.every(s => s.effective.load===9 && s.effective.rirTarget===3));
});
test('T599 malformed or unit-incompatible DELOAD applies no component, even with a carried prescription', () => {
  for (const components of [null,{SETS:2,LOAD:-1},{SETS:3,LOAD:9},{SETS:2,RIR:8},{SETS:2,REST:180}]) {
    const r=eff.resolveEffective(applied('DELOAD',2,{loadUnit:'KG',components}));
    assert.equal(r.provenance,'BASE_PLAN'); assert.equal(r.sets.length,3); assert.ok(r.sets.every(s=>s.effective.load===0));
  }
  assert.equal(eff.resolveEffective(applied('DELOAD',2,{loadUnit:'LB',components:{SETS:2,LOAD:9,RIR:3}})).reason,'UNIT_MISMATCH');
  assert.equal(eff.resolveEffective(applied('RIR',4)).provenance,'BASE_PLAN','no standalone RIR policy is invented');
});
test('T599 no authorized overlay never makes plan kg or a PENDING candidate effective', () => {
  const input=applied('REPS',9), a=Object.values(input.records)[0];
  input.overlays={}; a.state='PENDING'; a.nextExposure={week:input.week,dayIndex:input.dayIndex}; a.magnitude.eligible=true;
  const view=eff.describeProgression(input); assert.equal(view.state,'PENDING'); assert.equal(view.applied,false);
  assert.equal(view.hasAppliedLoad,false); assert.ok(view.result.sets.every(s=>s.effective.repsTarget===10 && s.effective.load===0));
  assert.equal(eff.describeProgression({...input,pid:'wrong'}).state,'NO_AUTHORIZED_ADJUSTMENT');
});
test('T599 plan, PID, override, safety, rollback and consumed history keep their canonical precedence', () => {
  const input=applied('LOAD',12.5);
  assert.equal(eff.resolveEffective({...input,activePlanId:'other'}).provenance,'BASE_PLAN');
  assert.equal(eff.resolveEffective({...input,pid:'wrong'}).provenance,'BASE_PLAN');
  assert.equal(eff.describeProgression({...input,safetyConflict:true}).state,'BLOCKED');
  const rec=Object.values(input.records)[0], ov=Object.values(input.overlays)[0]; rec.state='REVERTED';ov.status='REVERTED';
  assert.equal(eff.resolveEffective(input).provenance,'BASE_PLAN');
  rec.state='CONSUMED';ov.status='CONSUMED';assert.equal(eff.resolveEffective(input).sets[0].effective.load,12.5);
});
test('T599 presentation keeps the effective target separate from a historical copy (10 reps vs target 8)', () => {
  const names=['_effectiveSetTargetHtml','_seriesAuthorityHtml'];
  const ctx={_escHTml:s=>String(s).replace(/</g,'&lt;'),Number,String,Object,Math};vm.createContext(ctx);
  for(const name of names){const start=source.indexOf('function '+name+'('), next=source.indexOf('\nfunction ',start+1);vm.runInContext(source.slice(start,next<0?source.length:next).split('\n// ──')[0],ctx);}
  const html=ctx._effectiveSetTargetHtml({load:0,repsTarget:8,rirTarget:3,restSeconds:150},'COACH','KG',false,{sets:3,hasAppliedLoad:false});
  assert.match(html,/OBJETIVO DE ESTA SERIE/);assert.match(html,/>8<\/b> reps/);assert.match(html,/RIR 3/);assert.match(html,/3 series/);assert.match(html,/2:30/);
  const status=ctx._seriesAuthorityHtml(null,0);assert.match(status,/Sin autoajuste aplicado/);assert.match(status,/la referencia no es una progresión/);
});
