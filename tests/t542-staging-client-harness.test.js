// T542: the staging client harness never changes production defaults and refuses anything but the staging project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const H = require(path.join(root, 'scripts/client-staging-harness.cjs'));
const prod = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const stg = JSON.parse(fs.readFileSync(path.join(root, 'config/firebase-staging.config.json'), 'utf8'));

test('T542.20 the disposable staging copy swaps ONLY the firebase config', () => {
  const out = H.buildStagingHtml(prod);
  assert.ok(out.includes('"projectId":"' + stg.projectId + '"') && out.includes(stg.appId));
  assert.ok(!/projectId:\s*"vdsen-ecosistema"/.test(out) && !out.includes('1066774387899'));
  const strip = h => h.replace(/const firebaseConfig = \{[\s\S]*?\};/, '');
  assert.equal(strip(out), strip(prod), 'everything except the config block is byte-identical');
});
test('T542.21 production stays the default: the source file is untouched by the harness', () => {
  H.buildStagingHtml(prod);
  assert.ok(prod.includes('projectId: "vdsen-ecosistema"') && !prod.includes(stg.projectId));
});
test('T542.22 the harness refuses unexpected input (no config block / already-staging / two blocks)', () => {
  assert.throws(() => H.buildStagingHtml('<html></html>'), /REFUSING/);
  assert.throws(() => H.buildStagingHtml(H.buildStagingHtml(prod)), /REFUSING/);
  assert.throws(() => H.buildStagingHtml(prod + prod.slice(prod.indexOf('const firebaseConfig'), prod.indexOf('const firebaseConfig') + 400) + '\n'), /REFUSING/);
});
test('T542.23 the staging config is validated against the staging alias and forbidden projects', () => {
  const c = H.stagingConfig();
  assert.equal(c.projectId, JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8')).projects.staging);
  assert.ok(!H.FORBIDDEN.includes(c.projectId) && /staging/.test(c.projectId));
  assert.deepEqual(H.FORBIDDEN.slice().sort(), ['vdsen-ecosistema', 'vdsen-planes']);
});
test('T542.24 the harness only writes synthetic *.invalid accounts and never references the production project id in a URL', () => {
  const src = fs.readFileSync(path.join(root, 'scripts/client-staging-harness.cjs'), 'utf8');
  assert.ok(/@staging-ui\.invalid/.test(src));
  assert.ok(!/projects\/vdsen-ecosistema\//.test(src) && !/vdsen-planes\//.test(src));
  assert.ok(!/serviceAccount|private_key|GOOGLE_APPLICATION_CREDENTIALS/.test(src), 'no service-account material');
  const browser = fs.readFileSync(path.join(root, 'scripts/client-staging-browser.cjs'), 'utf8');
  assert.ok(/H\.stagingConfig\(\)/.test(browser) && /buildStagingHtml/.test(browser));
});
test('T542.25 a synthetic plan keeps Coach-owned prescription identity (PID per exercise, prescribed RIR present)', () => {
  const plan = H.syntheticPlan('coachX', 'clientY');
  assert.equal(plan.schema, 'vdsen-plan-v2');
  const pids = new Set();
  for (const d of plan.days) for (const e of d.exercises) { assert.ok(e.prescriptionExerciseId && !pids.has(e.prescriptionExerciseId)); pids.add(e.prescriptionExerciseId); assert.ok(e.sets.every(s => Number.isInteger(s.rirTarget))); }
});
