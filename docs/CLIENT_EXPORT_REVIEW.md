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
| `runner.js` | `buildArchive` (pure) + `createExporter` (in-flight guard, error → `{ok:false, code, message}`) |
| `ui.js` | confirm dialog / progress / result (DOM injected → testable) |
`vdsen-coach.html`: 10 `<script>` tags, header button `#modalExportClientBtn`, ~25 lines of glue (`_vdsenOpenClientExport`, `_vdsenClientExportIo`) that map the adapter to the Coach's own Firestore SDK calls. No existing function was modified except the 5 lines in `showClientDetail` that bind the button.

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
`tests/client-export.test.js` (27 tests covering the 26 required items + layout, UI, wiring, read-only guard) + `tests/helpers/client-export-fixture.js` (synthetic data, rules-emulating adapter, independent ZIP reader with CRC check, RFC 4180 parser). `node --test tests/*.test.js`: 1125/1125 pass locally (incl. these 27).

## Known gaps / review points
1. VDSEN has no Firebase Storage; media = inline data URIs (bundled) or URL references (`MEDIA_REFERENCE_ONLY`, never fetched). Real client photos are, per the app, sent outside the app (WhatsApp) and therefore not exportable.
2. Not run against the real Firestore emulator/staging (query shapes `coachId+clientId` equality rely on `firestore.rules`; emulated only by the test adapter). Recommended: one authenticated staging export by Ayrton/Codex.
3. No browser/E2E run (needs Coach auth); button wiring is covered by a source-contract test and the extracted module script parses (`node --check`).
4. Set index base (`_s0` vs `_s1`) is preserved as stored; session date = earliest/latest set `ts` (null when a session has none).
5. Plans with no `clientId` that nothing in the client's subtree references are not exported (cannot be attributed safely).
6. STORE zip (no compression) — larger files; JSON compresses well if the user re-zips.
7. `exerciseHistory`/progression state in the logs doc are exported verbatim in `additional_client_data` (can be large).
8. Pharmacology (`pharmacoPlan`, PED) is Coach-visible and exported under `additional_client_data.pharmacology`; confirm that is desired for backups.
9. `node scripts/release/check.cjs` asserts the canonical branch name and therefore fails on this feature branch by design; the unit baseline discovers `tests/client-export.test.js` automatically (no manifest change made).
10. Local ref `codex/client-app-next` was stale (`ab8c0ac`); `origin/codex/client-app-next` = `794929c`. The branch was created from the SHA; the local ref was not touched.

## Files changed
`vdsen-coach.html` (+41), `assets/client-export/{util,security,collect,normalize,derive,media,serialize,zip,runner,ui}.js`, `tests/client-export.test.js`, `tests/helpers/client-export-fixture.js`, `docs/CLIENT_EXPORT_REVIEW.md`. Dependencies added: none.
