# T576 — Hosted `applyPending` failure: root cause

**Symptom (T575 hosted ON, 3 runs):** `PENDING` materialized, then `POST /api/autonomous-progression-trigger` answered `500 PROGRESSION_PROCESSING_FAILED`; the APPLIED overlay was never written. Evidence: `docs/t575-matrix-hosted-on.json`. The local REST-driver shim passed 20/20.

**Root cause (CONFIRMED by static trace, INFERRED for the live exception):** `assets/progression-application-consumer.js` loads `./progression-effective-prescription.js` through an injected require (`_req(...)`, lines 346-347). Vercel's file tracer (`@vercel/nft`) follows only literal `require()` calls, so that module was not in the deployed function bundle. `materialize` (PENDING) never calls `_effective()`; `applyPending`/`consumePending` do, so only the APPLIED path threw `MODULE_NOT_FOUND`, which the handler maps to the generic 500. Locally Node resolves the file from disk, which is why every non-hosted driver passed.
- `@vercel/nft` trace of `api/autonomous-progression-trigger.js` before the fix: `HAS effective-prescription: false`; after: `true`.
- The original "Admin SDK `undefined` value" hypothesis was tested and **not reproduced**: `api/_autonomousProgression.admin.test.js` (real Admin SDK, Firestore emulator) passes PENDING -> APPLIED -> idempotent repeat on the unfixed code.
- The live exception text was never captured (handler hides it by design), so the mechanism stays INFERRED. The causal link is supported by the hosted before/after: the same matrix returned `500` on the unfixed build and passed APPLIED on the fixed build (see "Post-validation").

**Fix:** one literal `require('../assets/progression-effective-prescription.js')` in `api/_autonomousProgression.js` (no behavior change; the module was already loaded at runtime locally).

**Regressions:** `api/_functionBundleTrace.test.js` (fails before the fix, for both entrypoints; guards every `_req` module); the Admin SDK + emulator test (T577: moved to `tests/t576-admin-apply-emulator.cjs` so the canonical emulator gate runs it; T576 shipped it as `api/_autonomousProgression.admin.test.js`, which no CI gate executed).

## Post-validation (T576, historical evidence)
Hosted on `vdsen-ecosistema-staging` (Production env of the staging Vercel project, flags enabled only there, Preview untouched), build of PR #69 head:
- `HOSTED_ON` = 20 PASS, 0 FAIL, 1 SKIP (`docs/t575-matrix-hosted-on.json`): PENDING -> APPLIED -> CONSUMED, E06, E08 (SAFETY_CONFLICT blocks), REPS overlay, REST overlay, cron, idempotency (3 concurrent POSTs + sweep = 1 record), data integrity.
- `LOAD` (H22) was **blocked**, not applied: `BLOCKED_EQUIPMENT_DATA` (no verified equipment increments). It is not evidence of a numeric LOAD application.
- `HOSTED_OFF` = 10 PASS, 0 FAIL, 1 SKIP (`docs/t575-matrix-hosted-off.json`, run again after disarming).
- The SKIP in both files is the Preview rejection check (no Preview base / Vercel Authentication wall). Known, unresolved limitation.
- Staging was disarmed afterwards (flags `false`, `CRON_SECRET` removed, allowlist absent, synthetic data deleted) — reported by T576, verified at that time.
- PR #69 merged into `codex/client-app-next` as `5117c898bffc0541238dcf2940b0763a8e7603ca`; `main` unchanged (`f6596ba`).
- Note: `docs/t575-matrix-hosted-off.json` was overwritten by the T576 OFF re-run; the earlier T575 OFF result remains in git history.
