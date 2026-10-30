/**
 * T111-H: _submitModalImport refresh + _applyAllModuloD updatedAt & in-flight guard
 *
 * Static-analysis tests — no browser or Firebase required.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../vdsen-coach.html'),
  'utf8'
);

// ─── T111-A: _submitModalImport calls showClientDetail after saveImportedPlan ──
(function testImportRefresh() {
  // Check that the new refresh call is present in the source
  const hasShowDetail = src.includes("showClientDetail(_detailClientId || clientId, { tab: 'plan' })");
  if (!hasShowDetail) {
    console.error("FAIL T111-A: _submitModalImport does not call showClientDetail({ tab: 'plan' }) after saveImportedPlan");
    process.exit(1);
  }
  // Verify the old bare innerHTML='' pattern is gone from the import function
  // (the bare innerHTML clear must NOT appear right after saveImportedPlan)
  const bareAfterSave = /await saveImportedPlan[\s\S]{0,200}document\.getElementById\('_importPlanArea'\)\.innerHTML\s*=\s*''/.test(src);
  if (bareAfterSave) {
    console.error("FAIL T111-A: bare innerHTML='' still present after saveImportedPlan — refresh fix not applied");
    process.exit(1);
  }
  console.log('PASS T111-A: _submitModalImport refreshes modal via showClientDetail after import');
})();

// ─── T111-B: _submitModalImport refresh passes { tab: plan } ─────────────────
(function testImportTabPlan() {
  const hasTabPlan = src.includes("showClientDetail(_detailClientId || clientId, { tab: 'plan' })");
  if (!hasTabPlan) {
    console.error("FAIL T111-B: showClientDetail in _submitModalImport does not pass { tab: 'plan' }");
    process.exit(1);
  }
  console.log("PASS T111-B: import refresh opens Plan tab");
})();

// ─── T111-C/D/E: superseded by T481 — the Modulo D apply-to-plan path is neutralized ──────────────
// Its former updatedAt / in-flight-guard / button-restore hardening protected a plan write that no
// longer exists. The contract now is: no plan write is reachable from _applyAllModuloD.
(function testModuloDApplyRemoved() {
  if (src.includes('_applyAllModuloD') || src.includes('_moduloDPending')) {
    console.error('FAIL T111-C: the Modulo D apply-to-plan path must not exist (T487)');
    process.exit(1);
  }
  if (src.includes('Aplicar ajustes al plan</button>')) {
    console.error('FAIL T111-D: the Modulo D apply button must not be rendered (T487)');
    process.exit(1);
  }
  console.log('PASS T111-C/D/E: Modulo D apply-to-plan path removed (T487)');
})();

console.log('\nAll T111-H tests passed.');
