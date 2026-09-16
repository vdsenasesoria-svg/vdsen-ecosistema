/**
 * T110-H: showClientDetail opts.tab preservation
 *
 * Verifies that showClientDetail accepts an optional {tab} option and passes it
 * through to _switchClientTab instead of always resetting to 'ficha'.
 *
 * These are static-analysis / logic tests that run without a browser or Firebase.
 */

const fs = require('fs');
const path = require('path');

// ─── read raw source ──────────────────────────────────────────────────────────
const src = fs.readFileSync(
  path.join(__dirname, '../vdsen-coach.html'),
  'utf8'
);

// ─── helpers ──────────────────────────────────────────────────────────────────
function countOccurrences(str, pattern) {
  return (str.match(pattern) || []).length;
}

// ─── T110-A: showClientDetail signature accepts opts parameter ────────────────
(function testSignature() {
  // After the fix the function line must include "opts" parameter
  const match = src.match(/async function showClientDetail\(clientId,\s*opts\)/);
  if (!match) {
    console.error('FAIL T110-A: showClientDetail does not declare opts parameter');
    process.exit(1);
  }
  console.log('PASS T110-A: showClientDetail declares (clientId, opts)');
})();

// ─── T110-B: _initialTab defaults to 'ficha' when opts omitted ────────────────
(function testDefault() {
  // Source must contain the fallback: (opts && opts.tab) || 'ficha'
  const hasDefault = src.includes("(opts && opts.tab) || 'ficha'");
  if (!hasDefault) {
    console.error("FAIL T110-B: missing default fallback (opts && opts.tab) || 'ficha'");
    process.exit(1);
  }
  console.log("PASS T110-B: default tab is 'ficha' when opts omitted");
})();

// ─── T110-C: _switchClientTab called with _initialTab (not hardcoded 'ficha') ─
(function testSwitchUsesInitialTab() {
  // The final _switchClientTab call inside showClientDetail must use _initialTab
  const hasDynamic = src.includes('_switchClientTab(_initialTab)');
  if (!hasDynamic) {
    console.error("FAIL T110-C: _switchClientTab is not called with _initialTab");
    process.exit(1);
  }
  console.log("PASS T110-C: _switchClientTab(_initialTab) used inside showClientDetail");
})();

// ─── T110-D: plan-mutating operations pass { tab: 'plan' } ───────────────────
(function testPlanCallersPassTab() {
  // Count callers that correctly pass { tab: 'plan' }
  const withPlanTab = countOccurrences(src, /showClientDetail\([^)]+,\s*\{\s*tab:\s*'plan'\s*\}/g);
  // There should be at least 10 (all plan-context operations)
  if (withPlanTab < 10) {
    console.error(`FAIL T110-D: only ${withPlanTab} callers pass { tab: 'plan' } — expected >= 10`);
    process.exit(1);
  }
  console.log(`PASS T110-D: ${withPlanTab} callers correctly pass { tab: 'plan' }`);
})();

// ─── T110-E: no unadorned showClientDetail calls in plan-mutation functions ────
(function testNoBareCallsInPlanFunctions() {
  // After the fix, the only bare showClientDetail(clientId) call remaining in plan
  // context should be the profile-edit one (which intentionally goes to ficha).
  // We verify that deletePlan and duplicatePlan no longer use bare calls.
  const deletePlanBlock = src.match(/function deletePlan[\s\S]{0,500}showClientDetail/);
  if (deletePlanBlock) {
    const callStr = deletePlanBlock[0].match(/showClientDetail\([^)]+\)/);
    if (callStr && !callStr[0].includes('tab:')) {
      console.error('FAIL T110-E: deletePlan still has a bare showClientDetail call');
      process.exit(1);
    }
  }
  const duplicatePlanBlock = src.match(/function duplicatePlan[\s\S]{0,600}showClientDetail/);
  if (duplicatePlanBlock) {
    const callStr = duplicatePlanBlock[0].match(/showClientDetail\([^)]+\)/);
    if (callStr && !callStr[0].includes('tab:')) {
      console.error('FAIL T110-E: duplicatePlan still has a bare showClientDetail call');
      process.exit(1);
    }
  }
  console.log('PASS T110-E: deletePlan and duplicatePlan pass { tab: plan }');
})();

console.log('\nAll T110-H tests passed.');
