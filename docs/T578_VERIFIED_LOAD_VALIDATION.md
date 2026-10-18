# T578 — Verified-equipment LOAD: local validation (Admin SDK + Firestore Emulator)

Status: **LOCAL_LOAD_VALIDATED_HOSTED_PENDING**. No hosted/staging/production action was taken by T578. The only hosted evidence about LOAD remains T576's: LOAD *blocked* (`BLOCKED_EQUIPMENT_DATA`), never applied.

Baseline: canonical `4830affb1777971ac80696284dfe600fa1655333`, `main` `f6596ba5207dc158b8a9b01483cd0fe0ebeb274c`. No product code was changed: the audit found no defect.

## 1. LOAD flow (audited; data classes)
1. **Candidate** — `progression-magnitude-policy.js`: rule A with target RIR >= 2 yields a LOAD candidate `previousValue = last working-set load`, `rawCandidate = load * (1 + 2.5% * RIR gap)`. *Evidence-derived.* It carries the blocker `EQUIPMENT_INCREMENT_POLICY_MISSING` until an increment resolves it.
2. **Identity** — `equipment-context.equipmentRefForExercise` resolves the equipment from the shipped catalog **by exact `exerciseId`** (never by name). *Verified only if the catalog maps it.* Otherwise `EQUIPMENT_IDENTITY_UNRESOLVED`.
3. **Increment** — precedence exercise override > gym equipment > shared equipment (`coaches/{uid}.equipmentIncrements`). `applyPending` passes only the Coach config (no exercise doc), so in the autonomous path the increment must be **Coach-configured**; the equipment *type* never yields an increment. *Absent => `UNRESOLVED_EQUIPMENT_INCREMENT`.*
4. **Resolution** — `progression-equipment-resolver.resolveLoad`: grid from `STEP` / `PLATE_LOADED_BAR` / `AVAILABLE_LOADS`, unit must match, NEAREST rounding with tie toward the current load, out-of-range never clamped (beyond half a step), a result that does not move in the proposed direction is `DIRECTION_NOT_REALIZABLE`.
5. **Block mapping** — `EQUIPMENT_BLOCKERS` in `api/_autonomousProgression.js` => `blocked: 'BLOCKED_EQUIPMENT_DATA'` for LOAD only (REPS/REST never depend on equipment).
6. **Persistence** — `consumer.applyOverlayTransaction` writes the record event `APPLIED` and the overlay `nextExposureOverlays[ovl_*]` with `previousValue`, `requestedValue`, `appliedValue`, `unit`, `roundingReason`, `equipmentId`, `equipmentSnapshot {kind, unit, scope, source, revision, configuredAt}`, `target {week, dayIndex}`, `prescriptionExerciseId`.
7. **Next exposure** — `progression-effective-prescription.resolveEffective` returns `provenance: CANONICAL_OVERLAY` with the overlay load; consumption (`CONSUMED`) needs the athlete's first set of the target exposure plus a receipt.

## 2. Fixtures (all SYNTHETIC)
`tests/t578-verified-load-emulator.cjs`. Equipment *identity* comes from the public shipped catalog (`sf-sd-converging-lat-pulldown-plate-loaded`); the *increments* are synthetic Coach-configured fixtures (`configuredBy: synthetic-t578`) and describe no real client's equipment. Users, coaches, plans and logs are synthetic documents in the emulator project `demo-vdsen-shadow`.

## 3. Results (real `firebase-admin` on the Firestore Emulator)
`T578 suite: 14 / 14 PASS` (together with t570r + t576: 44 / 44 sequential).

| Case | Setup | Result |
|---|---|---|
| A valid | STEP 5 kg, load 100 kg, RIR gap 2 (raw 105) | `PENDING -> APPLIED`: overlay LOAD `previous 100 -> applied 105 KG`, `EXACT`, snapshot STEP/COACH_CONFIGURED/rev 1, target week 2 day 0; evidence, base plan and a bystander athlete byte-identical; effective prescription of the next exposure = 105 (`CANONICAL_OVERLAY`); athlete logs 105 + receipt => `CONSUMED`, applied value unchanged, repeats add nothing |
| A2 | PLATE_LOADED_BAR (bar 20, plate 2.5) / AVAILABLE_LOADS [90,100,105,110] | 105 applied for both |
| B1 | known equipment, no increment configured | `BLOCKED_EQUIPMENT_DATA` (`UNRESOLVED_EQUIPMENT_INCREMENT`), record stays `PENDING`, no overlay; retry stays blocked, no duplicate |
| B2 | exercise not in the catalog | `BLOCKED_EQUIPMENT_DATA` (`EQUIPMENT_IDENTITY_UNRESOLVED`) |
| C1 | raw 102.5 = tie between 100 and 105 | blocked `DIRECTION_NOT_REALIZABLE` (no load fabricated) |
| C2 | AVAILABLE_LOADS [90,100,110] | blocked `DIRECTION_NOT_REALIZABLE` |
| C3 | equipment maximum 100 kg | blocked `EQUIPMENT_OUT_OF_RANGE` |
| C4 | increment in LB, evidence in KG | blocked `UNIT_MISMATCH` |
| C5 | invalid metadata (step 0) | blocked, no overlay |
| D | 2 sequential + 4 concurrent repeats | 1 record, 1 `APPLIED` event, 1 overlay |
| E | `enabled=false` / `numericApplyEnabled=false` | `DISARMED` zero writes / `PENDING` only, no overlay; enabling later applies the same record |
| F | PID outside canary / client outside allowlist | no record, no overlay (`NO_CHANGE`, `OUT_OF_ALLOWLIST`) |
| G | two athlete pairs processed in opposite orders | identical overlays |

REPS and REST regressions: `tests/t570r-autonomous-emulator.cjs` (REPS, REST rule C, E19 LOAD-blocked, idempotency, SAFETY) pass in the same emulator run. The bundle guard from T576/T577 (`api/_functionBundleTrace.test.js` via `tests/t577-api-suites.test.js`) runs in the unit gate.

Limits: the athlete's first-set log and receipt were written with the Admin SDK (engine-level test); the rules-level athlete write path is covered by the existing rules suites and the T576 hosted matrix (H18). The hosted bundle has not been exercised with LOAD.

## 4. Hosted validation — prepared, NOT executed
Requires specific owner authorization (staging only). Nothing below was run.
1. **Preflight (read-only):** canonical HEAD = deployed SHA; Vercel project `prj_ZefsZK0hyGe7WxNqenR7MO9f2H8O` (staging), Firebase `vdsen-ecosistema-staging`; Preview flags `false`; no `releaseControl/autonomousProgression`; no non-synthetic clients in the allowlist; OIDC/WIF OK; `scripts/t575-hosted-matrix.cjs --phase off` = PASS.
2. **Identity/isolation:** synthetic coach + athlete users created by the matrix (`@staging-ui.invalid`), allowlist containing only those UIDs, canary limited to explicit synthetic PIDs.
3. **Fixtures:** add to the hosted matrix (separate change, with the authorization) an athlete whose plan uses a catalog `exerciseId` with equipment identity and a coach doc `equipmentIncrements.shared[<equipmentId>] = STEP 5 KG COACH_CONFIGURED` (synthetic), evidence load 100 kg, RIR gap 2; plus a twin without increments.
4. **Activation (Production env of the staging project only):** `AUTONOMOUS_PROGRESSION_ENABLED=true`, `..._NUMERIC_APPLY_ENABLED=true`, a temporary `CRON_SECRET` (not required for the LOAD checks; **do not enable CRON** for this validation), redeploy the exact approved SHA. Set values via stdin (`printf true | vercel env add ...`).
5. **Matrix:** LOAD-valid APPLIED 100 -> 105 + `CONSUMED`; no-increment twin blocked; repeat idempotency (3 concurrent POSTs); flags/allowlist/canary negatives still zero-write; Firestore before/after snapshots with operator identity.
6. **Restore (always):** both flags `false`, delete `CRON_SECRET`, remove allowlist, delete synthetic docs/users, redeploy, `--phase off` = DISARMED, confirm Firebase production untouched and `main` unchanged.
Success label only after that run: `HOSTED_LOAD_VALIDATED`.

## 5. Gates
See PR #(this PR) CI for the unit and emulator gate results; local numbers are in the PR description. The local Windows emulator gate is unreliable (T577); the authoritative run is CI.
