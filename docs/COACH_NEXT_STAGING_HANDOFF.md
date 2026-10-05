# Coach next candidate — staging acceptance handoff

> **THIS DOCUMENT DOES NOT EXECUTE STAGING.** It is the exact procedure for a future authenticated staging run by Ayrton / Work / Codex. It is **NOT** the current rules-only release, which is frozen (`codex/client-app-next` @ `794929c`, `PRODUCTION_RELEASE_ENABLED=false`). Nothing here authorises a merge, push, deploy or production action.

## A. Candidate
* branch: `claude/coach-next-integration-v1` (local; not pushed)
* base: `794929c71752bd3945ded7503158cb37b5bd495a`
* audited code HEAD: `1626d9d` (the commit that adds this handoff sits on top; code is identical). Source branches untouched: `claude/coach-client-export-v1` = `e8d43f6`, `claude/coach-runtime-hardening-v1` = `5bb6e33`.
* contents: Coach runtime hardening (login without reload, stale `activePlanId`, coach-switch cleanup) + Client Export ("Exportar cliente", `vdsen-client-export-v1`). Review docs: `docs/COACH_NEXT_INTEGRATION_REVIEW.md`, `docs/CLIENT_EXPORT_REVIEW.md`.
* Delta vs base: 28 files — `vdsen-coach.html` (modified) + 11 `assets/client-export/*.js` + 5 scripts + 9 tests/helpers + 3 docs. No change to `firestore.rules`, indexes, `.release/*`, workflows, `scripts/release/*`, Vercel/Firebase config, `package.json`.

## B. Preconditions
* Staging Firebase project only (`vdsen-ecosistema-staging`, see `docs/FIREBASE_STAGING.md` / `config/firebase-staging.config.json`); production untouched.
* An authenticated **staging Coach test account** (email/password) — plus a **second** staging Coach account for the coach-switch / cross-coach cases.
* Synthetic staging clients only (no real client data): minimum 4 under Coach 1 — C1 (rich history: ≥2 mesocycles, ≥6 sessions with sets/RIR, post-session + weekly check-ins, notes incl. an exercise note, ficha with biomechanics fields, nutrition + supplements, a pharmacology plan, one `data:` image field optional), C2 (**same display name as C1**, different data and a distinguishable sentinel text), C3 (`activePlanId` pointing at a plan id that does not exist — create by editing the client doc in staging, never in production), C4 (no plan); and ≥1 synthetic client under Coach 2 (same display name as C1 recommended).
* Put a unique sentinel string in each client's note/coachNote (e.g. `STG_C1_ONLY`, `STG_C2_ONLY`, `STG_OTHERCOACH_ONLY`).
* The candidate served as a **staging** deployment/preview built from the exact HEAD (the app must point at the staging Firebase config; confirm the project id in the page before testing). Never the production alias.
* Browser: desktop Chromium/Chrome with DevTools console open + a phone (or devtools mobile emulation 390×844).
* Staging rules must be the repository rules (`firestore.rules` @ base) — verify the deployed staging rules hash if the staging runbook provides one.

## C. Minimum staging test matrix (record PASS/FAIL per row)
| # | Case | Pass criteria |
|---|---|---|
| 1 | Login without reload | From the logged-out screen sign in; Coach shell + client list render **without** reloading; console clean |
| 2 | Logout / login, same coach (twice) | Shell restores each time; list correct; no console errors |
| 3 | Coach switch (Coach 1 → Coach 2 in the same tab) | Coach 2 sees only its clients; **nothing** of Coach 1 visible anywhere (lists, selects in Plan/Evaluación/Monitor, Plantillas, Catálogo, Config account box, modal title/body); also open sections as Coach 1 first. Search page DOM for `STG_C1_ONLY` / Coach 1 email / client names — none |
| 4 | Open a normal client (C1) | Detail renders; **⬇ Exportar cliente** visible only inside the client modal |
| 5 | Open C3 (stale `activePlanId`) | Detail opens; Plan tab shows "Referencia de plan rota"; no raw Firestore text; Export button still present; `activePlanId` unchanged afterwards |
| 6 | Export selected client (C1) | Confirmation dialog mentions sensitive data (historial, métricas corporales, notas, recuperación, **farmacología**); "Preparando exportación..." then "Cliente exportado correctamente" |
| 7 | Cancel | Cancelar → no download |
| 8 | Duplicate-click protection | Triple-click Exportar → exactly **one** download |
| 9 | Download ZIP | File `VDSEN_<safe-name>_<YYYY-MM-DD>_export.zip` downloads; opens; no upload/network POST of the ZIP (DevTools Network) |
| 10 | clientId / coachId | `manifest.json`: `client_id` = C1's uid/doc id, `coach_id` = Coach 1 uid |
| 11 | Session history | `sesiones.json`: chronological, sets/reps/load/RIR present as in the app |
| 12 | Historical mesocycles | `mesociclos.json` lists every mesocycle (active + previous) |
| 13 | Adherence | `adherencia.json` figures match the fixture (or `ADHERENCE_INSUFFICIENT_DATA` where plan structure is unknown) |
| 14 | Recovery | `recuperacion.json` has post-session + weekly check-ins |
| 15 | Ficha 360 | `ficha360.json` + `biomecanica.json` contain the stored fields |
| 16 | Notes | `notas.json` has coach note, client messages, exercise notes with source/association |
| 17 | sensitive_sections | `manifest.sensitive_sections == ["pharmacology"]` for C1; `[]` for a client without pharmacology; no infrastructure secrets in any file |
| 18 | Same-name isolation | Export C2 (same visible name as C1): ZIP `client_id` = C2, contains `STG_C2_ONLY`, **no** C1 data |
| 19 | Cross-client / cross-coach isolation | No sentinel of another client/coach in any ZIP (search all files incl. CSV/manifest/filenames); as Coach 2, the Coach 1 client is not listed and cannot be exported; export of C3 shows `REFERENCED_PLAN_UNREADABLE` in `manifest.warnings` |
| 20 | Mobile viewport | Export button inside viewport; dialog fits; both buttons visible; a long client name does not overflow; export works |

## D. Exit criteria
**PASS** only if all critical rows (1–6, 8–10, 17–19) pass and there is: no cross-client data, no cross-coach data, no raw Firebase error text in the UI, no uncaught browser error attributable to the candidate, and no production mutation (also no unintended staging data mutation — C3's `activePlanId` and plans unchanged).
Known pre-existing behaviour (not a failure): the wrong-password message shows Firebase's raw text.

## E. Stop / rollback criteria
* **Any** isolation or security finding (another client's/coach's data anywhere, stale binding, secret in ZIP): **STOP. Do not merge.** Report with the row and the artifact.
* Raw Firebase/stack text, uncaught errors, failed export for an owned client: STOP and report (functional blocker).
* Cosmetic-only issues: report separately, do not block.
* Rollback = simply do not promote the staging build; the candidate branch is not merged anywhere and production is untouched. Never "fix" staging by changing `firestore.rules`.

## F. Evidence to capture (no secrets, no tokens)
staging deployment identifier · runtime SHA actually served · staging project id · Coach account type (synthetic, email-password) · client ids used (C1–C4, Coach 2 client) · browser + version · console errors (copy) · each downloaded `manifest.json` · the PASS/FAIL table above · screenshots only where useful (mask nothing sensitive is needed because data is synthetic).

## Audit summary supporting this handoff (local, read-only audit + emulators)
* Delta audit: all changes classified (client export / runtime hardening / integration fix / test / doc); no unexpected or release/infrastructure file.
* Security audit: ownership gate fail-closed; clientId authoritative, display name never used as identity; permission-denied is **not** converted to not-found (only the single referenced-plan read is tolerated, after client ownership is established; collection queries and the client read still fail closed); rules unchanged; no Admin SDK/credentials/CDN in runtime code; media URLs only referenced (signed query stripped), inline images bundled.
* Auth lifecycle resets on logout (all verified in the browser by scanning the parked shell): modals; `#modalClientBody`, `#modalClientName`, delete + export bindings, export dialog (and in-flight export suppressed), per-coach exporter, `_clientIdList/_clientNameMap`, client `<select>` options, `#clientList/#dashSummary/#clientNavBar/#accountInfoBox`, `#fichasRecibidas/#templateList/#exerciseCatalog/#planBuilder/#autoGenStatus/#intake*/#compendioStatus/#vdsenPreviewStatus`; memory `currentCoach`, `_detail*` (client/plan/prev plan/ficha/renovación/logs), `_importedPlan`, `compendioText`, `manualPlan`, `_allExercises`, `_editingPlanId`, `_vdsenDraftPlanId`, `_intakeCurrentClient`, `_historicalMesoState`, `_shadowMonitorContext`, monitor/fichas listeners, `vdsen_apikey`.
* Export memory classification: **NORMAL CLIENT SAFE** (≤ ~8k set records: ~20 MiB ZIP, < 1 s, ~125 MiB RSS); **LARGE HISTORY CAUTION** (≈ 30k–80k sets: 100–200 MiB ZIP, 4–10 s, 0.5–0.7 GB RSS — possible trouble on phones); **STREAMING REQUIRED** beyond ~100k set records / ~250 MiB ZIP (not needed for any realistic current client: a year ≈ 3–8k sets). The STORE zip is built in memory.
* Local test results on the audited HEAD: unit 1139/1139; export unit/large/dry-run 33/33; runtime hardening 3/3; combined 5/5; export emulator 11/11; existing emulator suites 84/84; browser E2E: export 34/34, runtime 18/18, combined 21/21.

## Decision
* **READY_FOR_STAGING: YES**
* **READY_FOR_MERGE_AFTER_STAGING_PASS: NO** — stays NO until an authenticated staging run actually passes every critical row above. Nothing has been pushed, merged or deployed.
