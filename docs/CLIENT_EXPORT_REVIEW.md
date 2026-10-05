# Coach "Exportar cliente" — review notes (`vdsen-client-export-v1`)

Branch `claude/coach-client-export-v1`, based on `794929c71752bd3945ded7503158cb37b5bd495a`. Local only (not pushed). No release, rules, workflow, `.release/*` or production file is touched.

## What it does
Coach → open a client (client modal) → header button **⬇ Exportar cliente** → confirm → one ZIP download
`VDSEN_<safe-client-name>_<YYYY-MM-DD>_export.zip`. Read-only, local, download-only (no upload, no endpoint, no Admin credentials, no write).
Copy: confirm text / "Preparando exportación..." / "Cliente exportado correctamente" / "La exportación no pudo completarse" (no stack traces on screen).
Duplicate clicks are refused while a job runs (one exporter instance per coach session).

## Architecture (`assets/client-export/`, plain scripts, UMD: browser globals + `require` in tests)
| file | stage |
|---|---|
| `security.js` | ownership gate, per-record ownership check, secret denylist / scan, `ExportError` + safe user messages |
| `collect.js` | reads through an injected read-only `io` adapter (`getDoc` / `query` / `listSub`) |
| `normalize.js` | raw docs → sanitized, key-sorted, deterministically ordered model (mesocycles, sessions, set logs, recovery, notes, biomechanics, body metrics, nutrition, supplements) |
| `derive.js` | DERIVED analytics only (performance, adherence, trends); never mutates the model; every block `derived: true` + formulas |
| `media.js` | inline `data:` images → `media/`; URLs → reference only |
| `serialize.js` | canonical JSON, section files, RFC 4180 CSV |
| `zip.js` | dependency-free STORE zip writer (CRC32, UTF-8 names, deterministic) |
| `firestore-io.js` | read-only adapter built from the Coach's own Firestore web-SDK functions (only `getDoc`/`getDocs`) |
| `runner.js` | `buildArchive` (pure) + `createExporter` (in-flight guard, error → `{ok:false, code, message}`) |
| `ui.js` | confirm dialog / progress / result (DOM injected → testable) |
`vdsen-coach.html`: 11 `<script>` tags, header button `#modalExportClientBtn`, ~20 lines of glue (`_vdsenOpenClientExport`, `_vdsenClientExportIo`). No existing function was modified except the 5 lines in `showClientDetail` that bind the button.

## Data sources (authoritative, from `firestore.rules` + app writers)
`clients/{clientId}` · `plans` (query `coachId==uid AND clientId==id`, plus `activePlanId`/mesocycle/root-log plan refs) · `plans_backup` (same query) · `logs/{clientId}` · `logs/{clientId}/mesos/{planId}` · `fichas_onboarding/{clientId}` · `fichas_renovacion/{clientId}` · `fichas_publicas` (`coachId==uid AND clientUid==id`).
Log entry keys parsed: `log_W_D_E_sS`, `done_W_D`, `postsession_W_D`, `progrec_W_D`, `ci_sem_W`, `exnotepid_W_PID`, `exnote_W_D_E`, `exnote_D_E`(legacy), `exsub_*`, `exskip_*`, `exseries_*`, `exexpress_*`, `nutrilog_YYYY-MM-DD`. Anything else is preserved in `additional_client_data.unclassified_log_entries`; root/meso log document fields (exerciseUnits, exerciseHistory, progression state…) in `additional_client_data.logs_document_fields` / `mesos_document_fields`.
Not client-domain (excluded on purpose): `exercises` catalog, `templates`, `compendio`, `coaches`, `phone_index`, `diag_pings`.

## Ownership / security model
* Keyed by `clientId` only (never by name). Gate #1: `clients/{clientId}` must exist, `id` must match, `coachId` must be a non-empty string equal to the signed-in coach uid (same predicate as `ownsClient`) else `OWNERSHIP_DENIED`.
* Gate #2: each fetched plan / backup / public form is re-checked (`coachId`, `clientId`/`clientUid`); mismatches are dropped (warning without echoing the foreign id). Plans reached through this client's own subtree with no `clientId` are kept with `LEGACY_RECORD_WITHOUT_CLIENT_ID`.
* Gate #3 (`assertOwnedModel`) re-verifies the final model before serialization.
* Any `permission-denied` (any section) aborts the export (`PERMISSION_DENIED`); other read errors → `SECTION_READ_FAILED` + `manifest.complete=false`.
* Secrets: keys matching privateKey/token/accessToken/refreshToken/authorization/cookie/secret/serviceAccount/clientSecret/apiKey/password (and any key ending in token/secret/apikey/password/privatekey) and PEM private-key values are removed (paths, never values, recorded in `SECRET_FIELDS_REDACTED`). Free text is never touched. A final scan of every JSON + manifest aborts with `SECRET_SCAN_FAILED`. Signed-URL query strings are stripped from media references.
* Browser code uses only the Coach's existing authenticated SDK reads, so Firestore rules remain the enforcement point.

## Archive contents
`manifest.json`, `vdsen-client-export-v1.json` (canonical single document), `cliente.json`, `ficha360.json`, `biomecanica.json`, `metricas_corporales.json`, `entrenamiento.json`, `mesociclos.json`, `sesiones.json`, `rendimiento.json`, `adherencia.json`, `recuperacion.json`, `notas.json`, `nutricion.json`, `suplementos.json`, `media.json`, `additional_client_data.json`, `rendimiento_sesiones.csv`, `adherencia.csv`, `metricas_corporales.csv`, `media/*` (only if bundled). Manifest lists per-file bytes + CRC32, `included_sections`, `empty_sections`, `record_counts`, `data_range`, `media_status`, warnings.
Raw vs derived: sessions / exercise_logs / notes / recovery / body_metrics / plans are raw-faithful (`raw` kept on set records). `performance`, `adherence`, `trends` are derived and flagged.
Ordering: mesocycles by plan `createdAt` (else first evidence ts, else id); sessions by (mesocycle order, week, day_index); set logs by (session, exercise, set); recovery/notes by timestamp then program order. Output is byte-identical for identical data regardless of insertion order (tested).

## Derived analytics (see `derive.js` `FORMULAS`)
* observed set = `done===true` and not a synthetic Express set; volume load = Σ load×reps per unit (kg/lb never mixed); average RIR = mean of `rir_real` only.
* adherence: completed = `done_W_D` true or non-auto-closed object; denominators documented in output (`planned_sessions_full_plan = weeks×daysPerWeek`; `…_through_last_activity_week = lastWeekWithEvidence×daysPerWeek`); missed = through − completed − partial; mesocycles with unknown plan structure or no evidence → `ADHERENCE_INSUFFICIENT_DATA` and are excluded from the overall figure (listed).
* trends: last − first in chronological order, direction from sign only; bodyweight change/week only when both timestamps exist.

## Tests
Unit (`node --test tests/*.test.js`): `tests/client-export.test.js` (31 tests: the 26 required items + layout, sensitive sections, UI contract, wiring), `tests/client-export-large.test.js` (large history), `tests/client-export-harness-dryrun.test.js` (see below), helpers `client-export-fixture.js` (synthetic data, rules-emulating adapter, independent ZIP reader with CRC check, RFC 4180 parser), `client-export-large.js`, `emulator-dryrun-preload.cjs`. Whole suite: 1131/1131 pass.
Integration: `node scripts/client-export-emulator.cjs` → `tests/client-export-emulator.cjs` (11 tests).

## Firestore Emulator validation (real emulator + repository `firestore.rules`)
Runner `scripts/client-export-emulator.cjs` (copy of the isolated approach of `scripts/test-auto-apply-emulator.cjs`: demo project `demo-vdsen-export`, localhost-only emulator `cloud-firestore-emulator-v1.19.8.jar` with sha256 check, the repo's `firestore.rules`, private temp dir, no Auth emulator; the release runner/baseline was not modified). Seeding uses the Admin SDK (test harness only); the export itself runs the production adapter over the **Firestore web SDK 10.12.0 as an authenticated user** (`mockUserToken`), exactly like the Coach app.
Result: **11/11 pass** on the real emulator (and the pre-existing emulator suites still pass: 84/84).
* coachA → clientA: complete ZIP (all required sections, counts, ids, Unicode, CSV, chronological order, adherence 0.5, pharmacology listed in `sensitive_sections`).
* coachA → clientB / clientSameNameB (coachB) **denied** (`PERMISSION_DENIED`, no bytes); coachB → clientA denied; coachB exports its own clients. Client without `coachId`, `coachId` of a ghost coach, non-existent client, the athlete themself and an unrelated uid all fail closed.
* Same display name on 4 clients (2 per coach): exports never contain another client's sentinel (`CLIENT_A_ONLY_SECRET_TEXT` / `CLIENT_B_ONLY_SECRET_TEXT`) in JSON, CSV, manifest, file names, media metadata or ZIP payload (latin1 scan of every byte), in both directions.
* No Admin SDK / credentials / privileged endpoint in the export path (static check + web-SDK-only run). `firestore.rules` untouched.
* **Defect found and fixed by the real emulator**: the rules read `resource.data.coachId` for `plans`, so reading a plan that does not exist (stale `activePlanId`, orphan `logs/{id}/mesos/{planId}`) is answered with `permission-denied`, which the exporter treated as fatal. Now a denial on a plan fetched *by reference* → warning `REFERENCED_PLAN_UNREADABLE`, plan omitted, export continues (a plan this coach owns is always readable, so a denial means missing or not ours; nothing foreign is read). Denials on the collection queries/other documents stay fatal. Verified RED (EM.8 fails without the fix on the real emulator) → GREEN.
### Real query shapes (asserted from the recorded SDK calls)
| source | call | filters |
|---|---|---|
| `clients/{clientId}` | getDoc | — |
| `logs/{clientId}` | getDoc | — |
| `logs/{clientId}/mesos` | getDocs(collection) | — |
| `plans` | getDocs(query) | `coachId == coachUid`, `clientId == clientId` |
| `plans/{planId}` (active/mesocycle/root refs) | getDoc | — |
| `plans_backup` | getDocs(query) | `coachId == coachUid`, `clientId == clientId` |
| `fichas_onboarding/{clientId}`, `fichas_renovacion/{clientId}` | getDoc | — |
| `fichas_publicas` | getDocs(query) | `coachId == coachUid`, `clientUid == clientId` |
No query uses a display name; all filters are `==`. EM.7 proves with the real rules that the `coachId` filter is mandatory (a `clientId`-only query on `plans` / `plans_backup` / `fichas_publicas` is rejected, and `logs/{other}` / `mesos` / fichas of another client are denied).
### Production indexes
**None required.** Only equality filters on two fields (served by automatic single-field indexes), no `orderBy`. The existing composite index (`plans_backup`: coachId, clientId, backedUpAt desc) is not used by the export. `firestore.indexes.json` untouched.
### Harness dry run
Where the emulator JAR cannot be downloaded (it could not be through the proxy via `curl`/`gsutil`, but the Node runner's download with sha256 verification worked), `tests/client-export-harness-dryrun.test.js` runs the same integration file against a rules-*emulating* in-memory fake. It is only a self-check of the harness/adapter code and does not prove anything about the real rules.

## Archive structural validation
Programmatically on real-emulator output: JSON of every file parses; per-file CRC32 verified by an independent ZIP reader; CSV parses (RFC 4180, BOM, CRLF); UTF-8 preserved (`Tracción`, `ñandú`, `Pérez`); sessions in program order (`P1:w1:d0 … P2:w2:d1`); `record_counts` equal the seeded data; `client_id` / `coach_id` correct; `manifest.files` bytes equal the archive entries.
## Sensitive sections
`manifest.sensitive_sections` is always present; it lists `"pharmacology"` only when `clients.pharmacoPlan` has content (verified: A1 → `["pharmacology"]`, A2 → `[]`). The data is exported unredacted under `additional_client_data.pharmacology`; infrastructure secrets are always removed.
## Media
Inline `data:image|video` → bundled in `media/` (status `INCLUDED`/`PARTIAL`); http(s) URL → reference only (`REFERENCES_ONLY`, warning `MEDIA_REFERENCE_ONLY`, signed query stripped, never fetched — asserted with a `fetch` spy); none → `NOT_PRESENT`.
## Large export benchmark (synthetic, STORE zip, Node 22, unit-test machine)
| set records | sessions | ZIP | time | RSS delta |
|---|---|---|---|---|
| 7,680 | 240 | 19.6 MiB | ~0.6 s | ~125 MiB |
| 38,400 | 1,200 | 96.8 MiB | ~4 s | ~480 MiB |
| 76,800 | 2,400 | 193.7 MiB | ~9.4 s | ~720 MiB |
Roughly 2.5 KiB of ZIP per set record (each set appears in the canonical JSON and in `sesiones.json`, with its raw entry, pretty-printed) and ~4× the ZIP size in RSS. A realistic client (a year of training ≈ 3–8k sets) exports in under a second and < 150 MiB. Fix applied: text files are UTF-8-encoded once (previously three times). Compression was deliberately not added; CI guards the 7.7k-set case (`CE_LARGE_SCALE=n` for ad-hoc runs). Limitation: the whole archive is built in memory (browser tab) — histories beyond ~100k sets would need streaming/compression.

## Local browser E2E (real Coach UI + Auth Emulator + Firestore Emulator)
**LOCAL_BROWSER_E2E: PASS (34/34 checks)** — `NODE_PATH=$(npm root -g) node scripts/client-export-browser-e2e.cjs [--shots dir] [--out results.json]`.
* Runtime: Playwright 1.56.1 + the pre-installed Chromium 141 (`/opt/pw-browsers`), headless. Nothing was added to the repo; test-only packages (`firebase-admin`, `firebase-tools` for the Auth Emulator, `firebase`/`esbuild`/`tailwindcss` to rebuild the page's CDN assets) are installed into a private temp dir that is deleted on exit.
* Emulators: Firestore Emulator (pinned jar, sha256-checked) loaded with the repository `firestore.rules` + Firebase **Auth Emulator**, demo project `demo-vdsen-e2e`. Synthetic coaches are real Auth-emulator accounts (coachA/coachB); clients use the same fixture data as the integration suite plus a long-name client and a client whose `activePlanId` points to a deleted plan.
* The page under test is the unmodified `vdsen-coach.html` served from the working tree over plain HTTP loopback; only its `firebaseConfig` is swapped in memory for the demo project and wired to the emulators (guard: aborts unless `projectId` starts with `demo-`). The organisation egress policy blocks gstatic/cdnjs/tailwind, so the Firebase SDK 10.12.0 ESM, Tailwind v3 CSS and empty jsPDF/pdf.js/font stubs are rebuilt locally: **no internet is used**. Fidelity caveat: system fonts instead of web fonts.
* Flow actually driven through the UI: login (Auth Emulator) → client list shows only coachA's clients → open client → **Exportar cliente** → confirm dialog (sensitive-data wording) → **Cancelar** (no download) → **Exportar** (status "Preparando exportación..."), a triple click yields exactly 1 download → real browser download `VDSEN_Ana-Perez_<today>_export.zip` → success message, dialog closes.
* Downloaded ZIP inspected: all sections + CSV, JSON/CSV parse, CRC32, Unicode, session order, counts, `client_id`/`coach_id` = the Auth-emulator uid, `sensitive_sections=["pharmacology"]`, media `PARTIAL`, no other client's data, no secrets.
* Same-name UI: two clients named "Ana Pérez" under coachA (plus two under coachB): exporting `clientA2` yields only `clientA2`.
* Cross-coach: coachB's clients are not listed for coachA; `showClientDetail('clientB1')` leaves the export button hidden/unbound; forcing `_vdsenOpenClientExport('clientB1')` through the dialog fails closed (no download, "La exportación no pudo completarse. No tienes permiso para leer todos los datos de este cliente.", no technical text); a client without `coachId` also fails closed; coachB exports only its own client.
* Referenced plan missing: export completes, `REFERENCED_PLAN_UNREADABLE` in `manifest.warnings`, no stack text in the UI.
* Download safety: one `blob:` object URL created and revoked; no non-GET request left loopback, no blocked/external request occurred (every https request not served locally would have failed the run).
* Responsive: desktop 1280×800 and mobile 390×844 — export button inside the viewport, dialog fits (no horizontal scroll), both dialog buttons visible, 130-character unbroken client name wraps without overflow; export works on mobile.
* UI changes made as a result of this phase: dialog wording now warns about sensitive data ("Se generará una copia completa de la información de este cliente. El archivo puede incluir datos sensibles como historial, métricas corporales, notas, recuperación y farmacología."); dialog wraps long names/fits narrow screens; the export button binding is cleared as soon as another client starts loading (a previous client's binding could otherwise stay clickable while a different client — or a failed load — was shown). No opt-in toggle added; pharmacology still exported.
* **Pre-existing Coach behaviours observed (NOT export code, not changed):** (1) logging in without a page reload leaves the shell broken — the logged-out screen replaces `document.body`, so `initCoachUI` throws `Cannot set properties of null (setting 'innerHTML')` until the page is reloaded (the E2E reloads after sign-in, which restores the persisted session); (2) opening a client whose `activePlanId` points to a missing plan raises a Firestore permission error in `showClientDetail` (rules answer a missing plan with permission-denied).
* **Still not done: authenticated test against real staging** (staging was not touched).

## Known gaps / review points
1. **No authenticated staging run yet.** The Coach UI flow is validated in a real browser against the local emulators (see above), not against staging/production data. Staging was not touched.
2. VDSEN has no Firebase Storage; media = inline data URIs (bundled) or URL references (`MEDIA_REFERENCE_ONLY`, never fetched). Photos sent outside the app are not exportable.
3. Set index base (`_s0` vs `_s1`) is preserved as stored; session date = earliest/latest set `ts` (null when a session has none).
4. Plans with no `clientId` that nothing in the client's subtree references are not exported (cannot be attributed safely).
5. STORE zip, in-memory build (see benchmark); `exerciseHistory`/progression state in the logs doc are exported verbatim (can be large).
6. Pharmacology (PED) is exported on purpose and flagged in `sensitive_sections`; the archive should be handled as confidential health data.
7. `node scripts/release/check.cjs` asserts the canonical branch name and therefore fails on this feature branch by design; the unit baseline discovers the new `tests/*.test.js` files automatically (no manifest change made); the new emulator suite lives in its own runner and is not part of the release emulator baseline.
8. Local ref `codex/client-app-next` was stale (`ab8c0ac`); `origin/codex/client-app-next` = `794929c`. The branch was created from the SHA; the local ref was not touched.

## Files changed
`vdsen-coach.html`, `assets/client-export/{util,security,collect,normalize,derive,media,serialize,zip,firestore-io,runner,ui}.js`, `scripts/client-export-emulator.cjs`, `tests/client-export*.test.js`, `tests/client-export-emulator.cjs`, `tests/helpers/{client-export-fixture,client-export-large,emulator-dryrun-preload}.js|cjs`, `docs/CLIENT_EXPORT_REVIEW.md`. Dependencies added to the repo: none (the emulator runner installs `firebase@10.12.0` / `firebase-admin@13.10.0` into a private temp dir, as the existing runner does).
