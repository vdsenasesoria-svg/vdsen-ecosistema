# T577 — Post-merge integrity audit of T576 (canonical `5117c898`)

Scope: read-only audit + test/doc consolidation. No deploy, no Vercel/Firebase writes, `main` untouched (`f6596ba`), Numeric Apply stays disarmed.

## 1. T576 fix integrity — CONFIRMED
- `api/_autonomousProgression.js:14` keeps the literal `require('../assets/progression-effective-prescription.js')`.
- Real `@vercel/nft@0.29.4` trace of `api/autonomous-progression-trigger.js` on canonical: `progression-effective-prescription.js` present.
- Runtime comparison: every `api/` + `assets/` module actually loaded while running `api/_autonomousProgression.test.js` (PENDING -> APPLIED path, 7/7 pass) is inside the nft bundle (13 loaded, 0 missing).
- Admin SDK + Firestore emulator (PENDING -> APPLIED -> idempotent repeat): pass.
- OFF behavior untouched (`DISARMED` unit tests pass).
- Reproduce the trace: install `@vercel/nft` outside the repo, `nodeFileTrace(['api/autonomous-progression-trigger.js'], { base: repoRoot })`.

## 2. Baseline triage (canonical `5117c898`, unit gate)
CI (Linux, Node 22, run 39134167519): unit **1474 PASS / 0 FAIL**, emulator **113 PASS / 0 FAIL**, both gates `PASS`, 0 new regressions, 0 critical.

Local Windows run (the earlier "1455 PASS / 19 FAIL, 8 NEW_REGRESSIONS"), reproduced identically on `5dd3b1b` and `5117c898`:

| Group | Count | Signature | Class | Evidence |
|---|---|---|---|---|
| Generated-docs / byte-hash tests (t501, t510, t514, t516, t521, t522, t525, t527, t535, release-baseline, release-infrastructure, t572, T537.3 baseline list) | 18 | byte comparison of generated docs / test-source hashes | **C — ambiental** (`core.autocrlf=true` checks the tree out as CRLF) | Same SHA in an LF checkout (`-c core.autocrlf=false`): these 18 pass; unit = 1473 PASS / 1 FAIL, twice (deterministic) |
| `T571-1e` export round-trips binary assets | 1 | `tar: C\:\\...: Cannot open` — GNU tar treats `C:` as a remote host | **C — ambiental** (Windows + MSYS tar path) | Fails in LF checkout; passes in CI on Linux; test skips only when the commit is unreachable |
| Emulator gate locally | 65 FAIL | `2 UNKNOWN: Application error processing RPC` / 60s timeouts on rules-evaluated reads | **C — ambiental, root cause UNCONFIRMED** | Same under Node 22 and 24; CI emulator gate green on the same SHA. Local emulator on this Windows host is unreliable; not investigated further |

Counts by class: real regressions **0**, preexisting **0**, environmental **19 unit + emulator**, flaky **0** (2 identical LF runs), classifier errors **0**, unconfirmed root cause **1** (local emulator).
The comparator's "NEW_REGRESSIONS" on Windows are therefore not code regressions; they are CRLF checkouts. Recommendation (not changed here): run the gates in an LF checkout (or set `core.autocrlf=false`) and treat CI as the authoritative gate.

## 3. CI gate audit — `VDSEN release check`
- `Enforce both baseline gates` is `if: steps.unit.outcome != 'success' || steps.emulator.outcome != 'success'`. **SKIPPED means both gates succeeded** (intentional). Because the baseline steps use `continue-on-error`, `outcome` (not `conclusion`) is the correct field; a failing gate makes the enforce step run `exit 1`, and the job fails. A critical failure also sets the gate to `FAIL` independently of the manifest (`critical()` in `scripts/release/baseline.cjs`), and a `SKIP` counts as a regression.
- **Gap found and closed:** the unit gate runs only `tests/*.test.js`, and the emulator gate only the suites listed in `scripts/test-auto-apply-emulator.cjs`. `api/*.test.js` — including the T576 bundle guard and the whole executor/trigger/OIDC test set — ran in **no** CI gate. Fix:
  - `tests/t577-api-suites.test.js` loads every `node:test`-based `api/*.test.js` into the unit gate (legacy standalone scripts that call `process.exit` are excluded; 9 tests).
  - the Admin SDK apply test moved to `tests/t576-admin-apply-emulator.cjs` and registered in the emulator runner (`admin applyPending`).
  New ids pass, so no baseline manifest entry is needed. The emulator addition is only verifiable in CI (the local Windows emulator gate is unreliable, see §2).

## 4. Hosted evidence (historical, T576) and read-only checks (T577)
- `docs/t575-matrix-hosted-on.json`: HOSTED, project `vdsen-ecosistema-staging`, 20 PASS / 0 FAIL / 1 SKIP (declared == counted). `...-off.json`: 10 / 0 / 1. No secrets (grep for bearer/secret/cookie/_vercel: only test titles). The SKIP is the Preview rejection check — still open.
- LOAD (H22) was blocked (`BLOCKED_EQUIPMENT_DATA`), not applied.
- T577 read-only: canonical HEAD `5117c898`, `main` `f6596ba`; open PRs #43, #46, #54 unrelated; staging env var *names* present for Production and Preview separately (values are Secret type and unreadable, so current values are UNVERIFIED by T577; the last verified disarmed state is T576's OFF run).

## 5. Coach / Client regression
Unit gate in an LF checkout (includes Coach, Client, tenant-boundary, release suites): 1473 PASS, 1 environmental FAIL (T571-1e). CI: 1474 / 0.

## 6. Status
`READY_FOR_NEXT_PHASE` conditional on this PR's CI being green (new emulator entry unverified locally) and a re-read of the staging flags by the owner.
