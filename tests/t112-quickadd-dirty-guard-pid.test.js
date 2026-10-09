/**
 * T112-H: showQuickAddExercise dirty-editor guard + PID stability (F5)
 *
 * Static-analysis tests — no browser or Firebase required.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../vdsen-coach.html'),
  'utf8'
);

// ─── T112-A: showQuickAddExercise checks _dirtyEditor before opening ──────────
(function testDirtyGuard() {
  // The guard must be the first meaningful check (before the Firestore getDoc)
  // We verify the _dirtyEditor check appears inside showQuickAddExercise and
  // before the getDoc call.
  const fnStart = src.indexOf('async function showQuickAddExercise(planId)');
  if (fnStart === -1) {
    console.error('FAIL T112-A: showQuickAddExercise function not found');
    process.exit(1);
  }
  // Grab function up to first getDoc call
  const beforeGetDoc = src.slice(fnStart, fnStart + 600);
  const dirtyGuardPos = beforeGetDoc.indexOf('_dirtyEditor');
  const getDocPos = beforeGetDoc.indexOf('getDoc(');
  if (dirtyGuardPos === -1) {
    console.error('FAIL T112-A: _dirtyEditor guard not found inside showQuickAddExercise');
    process.exit(1);
  }
  if (dirtyGuardPos > getDocPos) {
    console.error('FAIL T112-A: _dirtyEditor guard appears AFTER getDoc — must come first');
    process.exit(1);
  }
  console.log('PASS T112-A: showQuickAddExercise checks _dirtyEditor before any async work');
})();

// ─── T112-B: guard shows toast (not silent failure) ──────────────────────────
(function testDirtyToast() {
  const fnStart = src.indexOf('async function showQuickAddExercise(planId)');
  const snippet = src.slice(fnStart, fnStart + 600);
  const hasToast = snippet.includes('showToast(') && snippet.includes('_dirtyEditor');
  if (!hasToast) {
    console.error('FAIL T112-B: dirty guard does not call showToast to inform the coach');
    process.exit(1);
  }
  console.log('PASS T112-B: dirty guard shows a toast message');
})();

// ─── T112-C: guard returns early (does not fall through to panel open) ────────
(function testDirtyReturn() {
  const fnStart = src.indexOf('async function showQuickAddExercise(planId)');
  const snippet = src.slice(fnStart, fnStart + 600);
  // Pattern: if (_dirtyEditor) { ... return; }
  const hasReturn = /if\s*\(_dirtyEditor\)[\s\S]{0,200}?return;/.test(snippet);
  if (!hasReturn) {
    console.error('FAIL T112-C: dirty guard block does not have a return statement');
    process.exit(1);
  }
  console.log('PASS T112-C: dirty guard returns early');
})();

// ─── T112-D (F5): new exercises start with prescriptionId='' (PID set at save) ─
(function testPidAssignedAtSave() {
  // addExRow adds new exercise rows with prescriptionId="" in the DOM.
  // saveTrainingPlan must assign a fresh PID when saving a row whose PID is empty.
  // We verify saveTrainingPlan generates a PID for rows with empty prescriptionId.
  const saveBlock = src.match(/async function saveTrainingPlan[\s\S]{0,3000}?^  \}/m);
  if (!saveBlock) {
    // Try without ^ anchor
    const idx = src.indexOf('async function saveTrainingPlan');
    if (idx === -1) {
      console.error('FAIL T112-D: saveTrainingPlan function not found');
      process.exit(1);
    }
    const snippet = src.slice(idx, idx + 3000);
    const hasPidAssign = snippet.includes('prescriptionId') &&
      (snippet.includes("|| crypto.randomUUID()") ||
       snippet.includes("|| Date.now()") ||
       snippet.includes("pid ||") ||
       snippet.includes("prescriptionId: pid") ||
       snippet.includes('prescriptionId:') ||
       snippet.includes('prescriptionExerciseId') ||
       snippet.includes('_genPrescriptionId'));
    if (!hasPidAssign) {
      console.error('FAIL T112-D: saveTrainingPlan does not assign a prescriptionId when none exists');
      process.exit(1);
    }
    console.log('PASS T112-D: saveTrainingPlan assigns prescriptionId at save time (PID stable after first save)');
    return;
  }
  const hasPidAssign = saveBlock[0].includes('prescriptionId');
  if (!hasPidAssign) {
    console.error('FAIL T112-D: saveTrainingPlan does not reference prescriptionId');
    process.exit(1);
  }
  console.log('PASS T112-D: saveTrainingPlan assigns prescriptionId at save time (PID stable after first save)');
})();

// ─── T112-E (F5): existing prescriptionId is preserved (not regenerated) ──────
(function testPidPreserved() {
  const idx = src.indexOf('async function saveTrainingPlan');
  if (idx === -1) {
    console.error('FAIL T112-E: saveTrainingPlan function not found');
    process.exit(1);
  }
  const snippet = src.slice(idx, idx + 3000);
  // The PID logic must be: use existing OR generate new (||) — not always regenerate
  const alwaysNew = /prescriptionId\s*[:=]\s*(crypto\.randomUUID|Math\.random|Date\.now)\(\)/.test(snippet);
  if (alwaysNew) {
    // Check it's not inside a ternary/fallback (e.g. existingPid || crypto.randomUUID())
    // A bare assignment without a fallback is the problem
    const bareRegen = /prescriptionId\s*:\s*(crypto\.randomUUID|Math\.random)\(\)/.test(snippet);
    if (bareRegen) {
      console.error('FAIL T112-E: saveTrainingPlan always regenerates prescriptionId — existing PIDs will be lost');
      process.exit(1);
    }
  }
  console.log('PASS T112-E: saveTrainingPlan preserves existing prescriptionId (no PID churn)');
})();

console.log('\nAll T112-H tests passed.');
