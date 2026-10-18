# T576 — Hosted `applyPending` failure: root cause

**Symptom (T575 hosted ON, 3 runs):** `PENDING` materialized, then `POST /api/autonomous-progression-trigger` answered `500 PROGRESSION_PROCESSING_FAILED`; the APPLIED overlay was never written. Evidence: `docs/t575-matrix-hosted-on.json`. The local REST-driver shim passed 20/20.

**Root cause (CONFIRMED by static trace, INFERRED for the live exception):** `assets/progression-application-consumer.js` loads `./progression-effective-prescription.js` through an injected require (`_req(...)`, lines 346-347). Vercel's file tracer (`@vercel/nft`) follows only literal `require()` calls, so that module was not in the deployed function bundle. `materialize` (PENDING) never calls `_effective()`; `applyPending`/`consumePending` do, so only the APPLIED path threw `MODULE_NOT_FOUND`, which the handler maps to the generic 500. Locally Node resolves the file from disk, which is why every non-hosted driver passed.
- `@vercel/nft` trace of `api/autonomous-progression-trigger.js` before the fix: `HAS effective-prescription: false`; after: `true`.
- The original "Admin SDK `undefined` value" hypothesis was tested and **not reproduced**: `api/_autonomousProgression.admin.test.js` (real Admin SDK, Firestore emulator) passes PENDING -> APPLIED -> idempotent repeat on the unfixed code.
- The live exception text was not captured (handler hides it by design). UNVERIFIED until the hosted matrix is re-run on a deployment of this fix.

**Fix:** one literal `require('../assets/progression-effective-prescription.js')` in `api/_autonomousProgression.js` (no behavior change; the module was already loaded at runtime locally).

**Regressions:** `api/_functionBundleTrace.test.js` (fails before the fix, for both entrypoints; guards every `_req` module); `api/_autonomousProgression.admin.test.js` (Admin SDK + emulator, skipped without `FIRESTORE_EMULATOR_HOST`).
