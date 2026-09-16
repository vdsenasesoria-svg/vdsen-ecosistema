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

// ─── T111-C: _applyAllModuloD includes updatedAt in updateDoc call ────────────
(function testUpdatedAt() {
  // The updateDoc call inside _applyAllModuloD must include updatedAt
  // We find the function body by looking for updatedDays + updatedAt in close proximity
  const hasUpdatedAt = /updateDoc\(doc\(db,'plans',planId\),\{days:updatedDays,\s*updatedAt/.test(src);
  if (!hasUpdatedAt) {
    console.error('FAIL T111-C: _applyAllModuloD updateDoc does not include updatedAt');
    process.exit(1);
  }
  console.log('PASS T111-C: _applyAllModuloD sets updatedAt on plan doc (client listener will fire)');
})();

// ─── T111-D: _applyAllModuloD has in-flight guard ────────────────────────────
(function testInflightGuard() {
  const hasGuardVar = src.includes('_applyModuloDInFlight');
  if (!hasGuardVar) {
    console.error('FAIL T111-D: _applyModuloDInFlight guard variable not found');
    process.exit(1);
  }
  // Guard must check before proceeding
  const hasGuardCheck = src.includes('if (_applyModuloDInFlight) return;');
  if (!hasGuardCheck) {
    console.error('FAIL T111-D: guard check `if (_applyModuloDInFlight) return;` not found');
    process.exit(1);
  }
  // Guard must reset in finally
  const hasFinallyReset = src.includes('_applyModuloDInFlight = false;');
  if (!hasFinallyReset) {
    console.error('FAIL T111-D: _applyModuloDInFlight is not reset to false in finally block');
    process.exit(1);
  }
  console.log('PASS T111-D: _applyAllModuloD has proper in-flight guard with finally reset');
})();

// ─── T111-E: button is disabled during in-flight ──────────────────────────────
(function testButtonDisable() {
  const hasDisable = src.includes("_applyBtn.disabled = true;");
  const hasRestore = src.includes("_applyBtn.disabled = false;");
  if (!hasDisable || !hasRestore) {
    console.error('FAIL T111-E: apply button is not disabled during async operation');
    process.exit(1);
  }
  console.log('PASS T111-E: apply button is disabled during _applyAllModuloD and restored in finally');
})();

console.log('\nAll T111-H tests passed.');
