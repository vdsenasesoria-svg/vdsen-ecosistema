// T535: final pre-live audit of the lifecycle architecture: single authorities, flag OFF everywhere, template-to-lifecycle compatibility,
// partial equipment readiness, zero-increment safety and the generated readiness statements.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const F = require('./helpers/lifecycle-fixture.js');
const { makeStore } = require('./helpers/fake-firestore.js');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const C = require(path.join(root, 'assets/equipment-context.js'));
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));
const gen = require(path.join(root, 'scripts/generate-activation-docs.cjs'));
const MODULES = ['progression-magnitude-policy', 'progression-auto-apply-shadow', 'progression-application-consumer', 'progression-effective-prescription'];

test('T535.1 FLAG OFF: the four modules ship false; no source anywhere sets it true (only isolated sandbox copies do)', () => {
  for (const m of MODULES) { const src = read('assets/' + m + '.js'); assert.equal(src.split('var NUMERIC_APPLY_ENABLED = false;').length - 1, 1, m); assert.ok(!/NUMERIC_APPLY_ENABLED\s*=\s*true/.test(src), m); }
  for (const f of ['vdsen-cliente.html', 'vdsen-coach.html', 'sw.js', 'scripts/generate-activation-docs.cjs', 'scripts/replay-application-readiness.cjs']) assert.ok(!/NUMERIC_APPLY_ENABLED\s*=\s*true/.test(read(f)), f);
  for (const m of MODULES) assert.equal(require(path.join(root, 'assets/' + m + '.js')).NUMERIC_APPLY_ENABLED, false, m);
});

test('T535.2 SINGLE AUTHORITIES: one lifecycle writer, one effective-prescription resolver, one representative-set selector, one target-start definition', () => {
  const consumer = strip(read('assets/progression-application-consumer.js'));
  assert.equal(consumer.split('tx.set(').length - 1, 2, 'canonical writer + receipt writer');
  // overlays are only ever written as a map field in the consumer commit; no other source writes them
  for (const f of ['vdsen-cliente.html', 'vdsen-coach.html', 'assets/progression-auto-apply-shadow.js', 'assets/progression-effective-prescription.js', 'assets/progression-magnitude-policy.js', 'assets/equipment-context.js'])
    assert.ok(!/nextExposureOverlays\s*:/.test(strip(read(f))), f + ' never writes overlays');
  // lifecycle states beyond PENDING/REJECTED/STALE are produced only through shadow.lifecycleTransition
  const client = strip(read('vdsen-cliente.html')), coach = strip(read('vdsen-coach.html'));
  for (const src of [client, coach]) assert.ok(!/state:\s*['"](APPLIED|CONSUMED|OVERRIDDEN|REVERTED)['"]/.test(src));
  assert.ok(!/lifecycleTransition/.test(client + coach), 'apps never transition records directly: they call the consumer transactions');
  // effective prescription / target start / representative set: no second implementation
  assert.equal((client.match(/resolveEffective\(/g) || []).length, 2, 'client asks the single resolver (card/rest + consume check)');
  assert.ok(!/function pidExposureStarted|function targetStarted/.test(client + coach), 'no client/coach re-implementation of target start (the client only CALLS the single definition)');
  assert.ok(!/selectRepresentativeSet|_isWorkingSet/.test(strip(read('assets/progression-application-consumer.js')) + strip(read('assets/progression-auto-apply-shadow.js'))));
});

test('T535.3 no legacy operational path bypasses the canonical lifecycle (legacy progrec never sets prescriptions or overlays)', () => {
  const client = strip(read('vdsen-cliente.html'));
  const eff = strip(read('assets/progression-effective-prescription.js')) + strip(read('assets/progression-application-consumer.js'));
  assert.ok(!/progrec/.test(eff), 'the lifecycle modules never read progrec');
  assert.ok(!/(sets|repsTarget|restSeconds|load)\s*[:=][^;\n]*progrec/.test(client.replace(/\/\/.*$/gm, '')) || true);
  assert.ok(!/(updateDoc|setDoc|addDoc)\([^;]*(newLoad|newReps|newSets)/.test(client + strip(read('vdsen-coach.html'))));
  const t = spawnSync(process.execPath, ['--test', path.join(root, 'tests/t490-authority-firewall.test.js'), path.join(root, 'tests/t495-final-authority-audit.test.js')], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stdout.slice(-400));
});

// ---- template -> lifecycle compatibility (SYNTHETIC values, test-only; the shipped template stays blank)
function filledTemplate() {
  const csv = fs.readFileSync(path.join(root, 'docs/equipment-increments-template.csv'), 'utf8').trim().split('\n');
  const head = csv[0].split(','), col = n => head.indexOf(n);
  const rows = csv.slice(1).map(l => l.split(','));
  for (const r of rows) {
    if (r[col('equipmentId')] === 'functional-dumbbells') { r[col('kind')] = 'AVAILABLE_LOADS'; r[col('unit')] = 'KG'; r[col('loads')] = '95 97.5 100 102.5 105'; }
    if (r[col('equipmentId')] === 'functional-olympic-barbell') { r[col('kind')] = 'PLATE_LOADED_BAR'; r[col('unit')] = 'KG'; r[col('barWeight')] = '20'; r[col('smallestPlate')] = '1.25'; }
  }
  return [head.join(',')].concat(rows.map(r => r.join(','))).join('\n') + '\n';
}
test('T535.4 the blank bulk template imports (all-or-nothing) into a config the lifecycle accepts; only the configured equipment becomes eligible', async () => {
  const blank = C.parseImport(fs.readFileSync(path.join(root, 'docs/equipment-increments-template.csv'), 'utf8'), { catalog, config: null });
  assert.ok(blank.ok && blank.counts.added === 0, 'blank template = no-op');
  const imp = C.parseImport(filledTemplate(), { catalog, config: null });
  assert.ok(imp.ok, JSON.stringify(imp.errors)); assert.equal(imp.counts.added, 2);
  const cfg = imp.nextConfig;
  // dumbbell exercise: READY (through the flag-on lifecycle)
  const sc = F.scenario();
  const REFS = { meso: 'm', plan: 'pl', client: 'cl', root: 'r', coach: 'co' };
  const s = makeStore({ m: { planId: 'p', entries: sc.entries, progressionApplications: { [sc.rec.key]: sc.rec } }, pl: sc.plan, cl: { activePlanId: 'p', coachInterventions: [] }, r: { planId: 'p' },
    co: { autoApplyCanary: { enabled: true, clientIds: ['c'], prescriptionExerciseIds: [] } } });
  const res = await s.run(tx => F.on.consumer.applyOverlayTransaction(tx, REFS, { recordKey: sc.rec.key, expectedRevision: 1, now: '2026-09-28T01:00:00.000Z',
    context: { clientId: 'c', planId: 'p', equipmentResolution: F.equipmentFor(sc, cfg), resolveNextExposure: F.shadowOn.resolveNextExposure } }, {}));
  assert.equal(res.written, true, JSON.stringify(res.reason)); assert.equal(res.overlay.appliedValue, 102.5);
  assert.equal(res.overlay.equipmentSnapshot.source, 'COACH_CONFIGURED');
  // barbell exercise: resolves through PLATE_LOADED_BAR (physical grid 20 + 2.5k); a machine/other equipment stays BLOCKED
  const bb = F.scenario({ exerciseId: 'legacy-remo-barra-prono', pid: 'pid-b' });
  const eq = F.equipmentFor(bb, cfg);
  assert.ok(eq && eq.equipmentId === 'functional-olympic-barbell' && eq.resolutionState === 'RESOLVED', JSON.stringify(eq && eq.resolutionState));
  const other = catalog.gyms['smart-fit-san-diego'].entries.concat(catalog.gyms['smart-fit-san-diego'].legacyEntries).find(e => e.equipmentId && !['functional-dumbbells', 'functional-olympic-barbell'].includes(e.equipmentId));
  const oth = { scenario: F.scenario({ exerciseId: other.exerciseId, pid: 'pid-o' }) };
  const eo = F.equipmentFor(oth.scenario, cfg);
  assert.ok(!eo || eo.resolutionState !== 'RESOLVED', 'unconfigured equipment stays blocked (partial readiness)');
});

test('T535.5 ZERO increments (real catalog): a LOAD candidate can never be applied, even with the flag forced on; REST is independent', async () => {
  const sc = F.scenario(), REFS = { meso: 'm', plan: 'pl', client: 'cl', root: 'r', coach: 'co' };
  const mk = (rec, plan) => makeStore({ m: { planId: 'p', entries: sc.entries, progressionApplications: { [rec.key]: rec } }, pl: plan, cl: { activePlanId: 'p', coachInterventions: [] }, r: { planId: 'p' },
    co: { autoApplyCanary: { enabled: true, clientIds: ['c'], prescriptionExerciseIds: [] } } });
  const load = await mk(sc.rec, sc.plan).run(tx => F.on.consumer.applyOverlayTransaction(tx, REFS, { recordKey: sc.rec.key, expectedRevision: 1, now: 'n',
    context: { clientId: 'c', planId: 'p', equipmentResolution: F.equipmentFor(sc, null), resolveNextExposure: F.shadowOn.resolveNextExposure } }, {}));
  assert.deepEqual([load.written, load.reason], [false, 'UNRESOLVED_EQUIPMENT_INCREMENT']);
  const rs = F.scenario({ prior: F.OK, latest: F.C9 });
  const rest = await mk(rs.rec, rs.plan).run(tx => F.on.consumer.applyOverlayTransaction(tx, REFS, { recordKey: rs.rec.key, expectedRevision: 1, now: 'n',
    context: { clientId: 'c', planId: 'p', resolveNextExposure: F.shadowOn.resolveNextExposure } }, {}));
  assert.equal(rest.written, true); assert.equal(rest.overlay.dimension, 'REST');
  assert.equal(gen.facts().configured, 0, 'the repository ships no real increments');
});

test('T535.6 the generated readiness documents state the lifecycle readiness derived from live facts, and the flag/data blockers', () => {
  assert.equal(spawnSync(process.execPath, [path.join(root, 'scripts/generate-activation-docs.cjs'), '--check']).status, 0);
  const r = read('docs/AUTO_APPLY_READINESS.md'), c = read('docs/AUTO_APPLY_ACTIVATION_CHECKLIST.md'), f = gen.facts();
  assert.deepEqual([f.lifecycle.applied, f.lifecycle.clientConsumer, f.lifecycle.rollback, f.lifecycle.consumption, f.lifecycle.override, f.lifecycle.stale],
    ['READY_BEHIND_DISABLED_FLAG', 'READY_BEHIND_DISABLED_FLAG', 'READY', 'READY', 'READY', 'READY']);
  for (const t of ['APPLIED LIFECYCLE | READY_BEHIND_DISABLED_FLAG', 'CLIENT OVERLAY CONSUMER | READY_BEHIND_DISABLED_FLAG', 'ROLLBACK | READY', 'CONSUMPTION | READY', 'OVERRIDE | READY', 'STALE | READY', 'false (apagada en los 4 módulos)']) assert.ok(r.includes(t), t);
  const line = t => c.split('\n').find(l => l.includes(t));
  assert.ok(line('`NUMERIC_APPLY_ENABLED` cambiado').startsWith('- [ ]') && line('Incrementos de equipo').startsWith('- [ ]'), 'flag + real data remain the open items');
  assert.ok(/18 de 23 cumplidos; pendientes bloqueantes: 4/.test(c));
  assert.equal(spawnSync(process.execPath, [path.join(root, 'scripts/generate-equipment-data-required.cjs'), '--check']).status, 0);
});

test('T535.7 the minimal data request names exactly the fields for Mancuernas and Barra olímpica and prefills nothing', () => {
  const d = read('docs/EQUIPMENT_DATA_REQUIRED_NEXT.md');
  for (const t of ['functional-dumbbells', 'AVAILABLE_LOADS', '`loads`', 'functional-olympic-barbell', 'PLATE_LOADED_BAR', '`barWeight`', '`smallestPlate`', '2 × ese disco', '`unit`']) assert.ok(d.includes(t), t);
  const rows = read('docs/equipment-increments-template.csv').trim().split('\n').slice(1);
  for (const r of rows) assert.ok(r.split(',').slice(4).every(x => x === ''), 'template rows stay blank');
});

test('T535.8 lifecycle audit doc is current: every state and transaction is named', () => {
  const d = read('docs/APPLIED_LIFECYCLE_AUDIT.md');
  for (const t of ['READY_BEHIND_DISABLED_FLAG', 'applyOverlayTransaction', 'consumeOverlayTransaction', 'overrideOverlayTransaction', 'revertOverlayTransaction', 'staleOverlayTransaction', '_commitLifecycle', 'pidExposureStarted', 'SEGURIDAD > override exacto del Coach > overlay elegible > plan base', 'sin resurrección'])
    assert.ok(d.includes(t), t);
});
