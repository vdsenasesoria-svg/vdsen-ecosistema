'use strict';
/**
 * T265 — Backup/historical continuity. backupPlanIfExists snapshots the
 * OUTGOING plan into plans_backup before activation. Verifies the backup
 * reflects what the client was ACTUALLY seeing (clients/{uid}'s current
 * nutrition/supplements), not just the original plan doc's own fields,
 * which can drift when a nutrition-only edit (T259/T263's already-correct
 * direct import-path writers) updates only the client doc. Also verifies
 * the merge never mutates the source objects by reference.
 *
 * Run: node tests/t265-backup-historical-continuity.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

const backupSrc = extractFunction(COACH, 'async function backupPlanIfExists(clientId)');
ok(backupSrc, 'backupPlanIfExists extracts cleanly');
ok(backupSrc.includes('clientData.nutritionRaw   !== undefined ? clientData.nutritionRaw'), 'the backup now prefers the CLIENT doc\'s current nutritionRaw over the plan doc\'s own (T265 fix)');

function makeHarness(clientDataFixture, planDataFixture) {
  const backups = [];
  const fakeDoc = function(db, coll, id) { return { __coll: coll, __id: id }; };
  const fakeGetDoc = async function(ref) {
    if (ref.__coll === 'clients') return { exists: function() { return !!clientDataFixture; }, data: function() { return clientDataFixture; } };
    if (ref.__coll === 'plans') return { exists: function() { return !!planDataFixture; }, data: function() { return planDataFixture; } };
  };
  const fakeAddDoc = async function(collRef, data) { backups.push(data); return { id: 'backup-1' }; };
  const fakeCollection = function(db, name) { return { __coll: name }; };
  const fn = new Function('doc', 'getDoc', 'addDoc', 'collection', 'currentCoach', 'db',
    backupSrc + ';\nreturn backupPlanIfExists;'
  )(fakeDoc, fakeGetDoc, fakeAddDoc, fakeCollection, { uid: 'coach-1' }, {});
  return { run: fn, backups: backups };
}

async function main() {
  // ───────────────────────────────────────────────────────────────────────
  // No active plan -> null, no write.
  // ───────────────────────────────────────────────────────────────────────
  {
    const h = makeHarness({}, null);
    const result = await h.run('client-1');
    ok(result === null && h.backups.length === 0, 'no activePlanId -> null, zero writes');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Plan doc missing (deleted) -> null, no write, no crash.
  // ───────────────────────────────────────────────────────────────────────
  {
    const h = makeHarness({ activePlanId: 'plan-GONE' }, null);
    const result = await h.run('client-1');
    ok(result === null && h.backups.length === 0, 'plan doc missing -> null, zero writes, no crash');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Client and plan doc AGREE -> backup preserves exact outgoing training/
  // nutrition/supplements.
  // ───────────────────────────────────────────────────────────────────────
  {
    const planData = { days: [{ dayIndex: 0, exercises: [{ exerciseName: 'Sentadilla' }] }], weeks: 6, nutritionDisplay: { calorias: 2200 }, nutritionRaw: { calorias: 2200, comidas: [] }, supplementDisplay: { texto: 'Creatina' }, supplementsRaw: { tiers: [] } };
    const clientData = { activePlanId: 'plan-A', nutritionPlan: { calorias: 2200 }, nutritionRaw: { calorias: 2200, comidas: [] }, supplementPlan: { texto: 'Creatina' }, supplementsRaw: { tiers: [] } };
    const h = makeHarness(clientData, planData);
    await h.run('client-1');
    const backup = h.backups[0];
    ok(backup.days.length === 1 && backup.days[0].exercises[0].exerciseName === 'Sentadilla', 'training preserved exactly');
    ok(backup.nutritionRaw.calorias === 2200 && backup.supplementsRaw.tiers.length === 0, 'nutrition/supplements preserved exactly when client and plan doc agree');
    ok(backup.originalPlanId === 'plan-A' && backup.backedUpBy === 'coach-1', 'backup metadata (originalPlanId/backedUpBy/backedUpAt) is stamped');
  }

  // ───────────────────────────────────────────────────────────────────────
  // DRIFT: the client doc's nutrition was updated separately (a
  // nutrition-only edit, T259/T263) AFTER the plan doc was originally
  // saved -- the backup must reflect the CLIENT's current (real) value,
  // not the plan doc's stale original.
  // ───────────────────────────────────────────────────────────────────────
  {
    const planData = { days: [], nutritionRaw: { calorias: 1800 }, nutritionDisplay: { calorias: 1800 }, supplementsRaw: { tiers: [{ nombre: 'Old' }] }, supplementDisplay: { texto: 'Old' } };
    const clientData = { activePlanId: 'plan-A', nutritionRaw: { calorias: 2600 }, nutritionPlan: { calorias: 2600 }, supplementsRaw: { tiers: [{ nombre: 'New' }] }, supplementPlan: { texto: 'New' } };
    const h = makeHarness(clientData, planData);
    await h.run('client-1');
    const backup = h.backups[0];
    ok(backup.nutritionRaw.calorias === 2600, 'DRIFT: the backup reflects the CLIENT doc\'s CURRENT nutrition (2600), not the plan doc\'s stale original (1800) -- the backup shows what actually existed for the client at backup time');
    ok(backup.supplementsRaw.tiers[0].nombre === 'New', 'same for supplements -- the client\'s current value wins over the plan doc\'s stale one');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Client doc lacks nutrition entirely (never had it) -> falls back to
  // the plan doc's own value, never a fabricated null/loss.
  // ───────────────────────────────────────────────────────────────────────
  {
    const planData = { days: [], nutritionRaw: { calorias: 1800 }, nutritionDisplay: { calorias: 1800 } };
    const clientData = { activePlanId: 'plan-A' }; // no nutritionRaw field on the client doc at all
    const h = makeHarness(clientData, planData);
    await h.run('client-1');
    const backup = h.backups[0];
    ok(backup.nutritionRaw.calorias === 1800, 'when the client doc genuinely lacks the field, the backup falls back to the plan doc\'s own value -- never lost');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Immutability: the source objects (as returned by getDoc) are never
  // mutated by the backup/merge logic -- byte-identical before/after.
  // ───────────────────────────────────────────────────────────────────────
  {
    const planData = { days: [{ exerciseName: 'X' }], nutritionRaw: { calorias: 1800 } };
    const clientData = { activePlanId: 'plan-A', nutritionRaw: { calorias: 2600 } };
    const planSnapshotBefore = JSON.parse(JSON.stringify(planData));
    const clientSnapshotBefore = JSON.parse(JSON.stringify(clientData));
    const h = makeHarness(clientData, planData);
    await h.run('client-1');
    ok(JSON.stringify(planData) === JSON.stringify(planSnapshotBefore), 'IMMUTABILITY: the plan doc object is byte-identical after backup -- backupPlanIfExists itself never assigns into planData/clientData, only reads from them to build a brand-new backup object');
    ok(JSON.stringify(clientData) === JSON.stringify(clientSnapshotBefore), 'IMMUTABILITY: the client doc object is byte-identical after backup -- never mutated by the merge logic');
  }

  console.log('');
  console.log('T265 — Backup/historical continuity: ' + pass + ' assertions PASSED');
}

main().catch(function(e) { console.error(e); process.exit(1); });
