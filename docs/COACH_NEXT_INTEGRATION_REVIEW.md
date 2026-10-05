# Coach next integration candidate — review notes

> **THIS IS NOT THE CURRENT RULES-ONLY RELEASE.** The validated release (`codex/client-app-next` @ `794929c71752bd3945ded7503158cb37b5bd495a`, plan `rules_only`, `PRODUCTION_RELEASE_ENABLED=false`) is untouched. This branch is a possible FUTURE Coach runtime release, to be considered only after the rules-only release is closed. Local only, not pushed, no staging/production contact.

Branch `claude/coach-next-integration-v1`, created from exactly `794929c`, containing:
1. **Coach runtime hardening** (source `claude/coach-runtime-hardening-v1` @ `5bb6e33`): login without reload, stale `activePlanId` tolerance.
2. **Client Export** (source `claude/coach-client-export-v1` @ `e8d43f6`): "Exportar cliente" (see `docs/CLIENT_EXPORT_REVIEW.md`).
Both source branches were left untouched (verified at the end: `e8d43f6`, `5bb6e33`).

## Commit provenance (cherry-picked in this order; no squash)
Ancestry of both lists was verified against the source branches before starting (`git log 794929c..<branch>` matched the stated lists exactly).
| integration | source | subject |
|---|---|---|
| 0c8ddef | 645efd4 | fix(coach): restore shell after authentication |
| 9e9e87d | 4baa365 | fix(coach): tolerate stale active plan reference |
| 32ce5ff | 5bb6e33 | test(coach): cover coach runtime recovery cases |
| 33e3bd7 | 2963643 | feat(coach): add client export data collector |
| b692521 | 1422647 | feat(coach): add export archive and analytics |
| f8c75f1 | 95d8abb | feat(coach): add export client UI |
| 99704d1 | 8aa7741 | test(coach): cover full client export |
| 2c13bf3 | f059bd6 | docs(coach): client export review notes |
| c08b764 | 879aca4 | fix(coach): enforce export query compatibility |
| 47240c2 | 032ad41 | test(coach): validate client export with firestore emulator |
| d57b7fe | f9ade54 | fix(coach): clarify sensitive client export warning |
| 295587e | e8d43f6 | test(coach): validate client export browser flow |
| 6456c85 | — new | fix(coach): integrate runtime recovery with client export |
| 83a078c | — new | test(coach): cover combined coach session and export flows |
(+ this document.)

## Conflicts
**Textual conflicts: none.** All 12 cherry-picks applied cleanly (three auto-merged `vdsen-coach.html`: the UI commit, the query-compatibility commit, the sensitive-warning commit).
**Semantic conflicts: four**, found by the combined browser suite and fixed in `6456c85` (the integrated implementation only; no source branch edited, no suite weakened):
1. *Export dialog survives logout.* The dialog is a direct child of `<body>`. Runtime hardening parks the whole body in a fragment on logout and restores it on the next sign-in, so an open dialog would have been restored for the **next coach**, still bound to the previous coach's client. Fix: `VDSEN_CE_UI.closeActive()` is called before parking; it also marks the controller cancelled so an in-flight export finishing after logout neither downloads nor toasts.
2. *Export button binding parked with the shell.* `#modalExportClientBtn` kept its `onclick` for the previous client inside the stash. Fix: hidden and unbound before parking (same as the delete button), plus the cached per-coach exporter (`_clientExporter*`) and the client caches (`_clientIdList`, `_clientNameMap`) are reset.
3. *Client pickers in hidden DOM.* `<select>` dropdowns (monitor/plan/evaluation) held `value=clientId>display name` options of the previous coach inside the parked shell. Fix: options whose value is one of the outgoing coach's client ids are removed (ids read before the cache reset).
4. *Account box in hidden DOM.* `#accountInfoBox` held the previous coach's email and uid. Fix: cleared when parking.
Items 3–4 are in fact gaps of the runtime-hardening scrub that only a scan of the parked fragment (new in the combined suite) could reveal; they are fixed here, not on the source branch.

## Combined security behaviour
* After logout/login or a coach switch in the same tab nothing of the previous coach remains — verified by scanning **the parked shell fragment, the login screen and the DOM after the next sign-in** for client ids, names, emails, coach uid/email, notes and plan names: client name/email, modal title/body, delete binding, export binding, export dialog, selected client id (`_detailClientId` and caches reset by the logged-out branch), cached client object, client pickers, account box.
* A restored shell never restores another coach's selected client, export binding or client metadata.
* clientId authority, coachId ownership, same-name isolation, cross-client and cross-coach isolation and secret filtering are unchanged (export modules untouched except `ui.js`'s dismiss logic) and re-verified in the browser: coachB forcing `_vdsenOpenClientExport('clientA1')` fails closed ("No tienes permiso…"), coachB exports only its own same-name clients, coachA's second export after logout/login contains only `clientA2`.
* `firestore.rules`, indexes and all release files are unchanged.

## Stale plan + export (integrated)
Owned client with an unreadable/missing `activePlanId`: detail opens ("Referencia de plan rota"), **Exportar cliente stays available** (bound before the referenced-plan read), the export succeeds, `manifest.warnings` contains `REFERENCED_PLAN_UNREADABLE` (`PDELETED`), no plan is exported or generated, no raw Firestore text in the UI, and a full before/after snapshot of `clients`, `plans` and `logs` is identical (`activePlanId` never rewritten).

## Tests (all on this branch)
| suite | result |
|---|---|
| `scripts/coach-next-integration-e2e.cjs` (new; real Coach UI + Auth + Firestore emulators + repo rules) cases A/B/C, stale+export, hidden-DOM scan, local-only network | 20/20 |
| `scripts/client-export-browser-e2e.cjs` (unchanged) | 34/34 |
| `scripts/coach-runtime-e2e.cjs` (unchanged) | 18/18 |
| `scripts/client-export-emulator.cjs` (real Firestore Emulator + rules) | 11/11 |
| `scripts/test-auto-apply-emulator.cjs` (existing emulator suites) | 84/84 |
| `tests/coach-next-integration.test.js` (new, source contracts + UI controller) | 4/4 |
| `node --test tests/*.test.js` | 1138/1138 |
`git diff --check`: clean. The new E2E script duplicates the emulator/browser bootstrap of the two existing ones (they live on other branches); consolidating into a shared module is a possible follow-up.

## Remaining gap / release implications
* **Authenticated test against real staging has not been done** (staging untouched). It is still required before this candidate can be considered for release.
* This candidate changes the Coach app runtime (`vdsen-coach.html` + `assets/client-export/*`); it is independent of, and must not be mixed into, the current rules-only release. Releasing it later needs its own release plan (app deploy path), after the current release is closed.
* Pre-existing Coach behaviour not addressed here: the auth-failure message still shows the raw Firebase text.
