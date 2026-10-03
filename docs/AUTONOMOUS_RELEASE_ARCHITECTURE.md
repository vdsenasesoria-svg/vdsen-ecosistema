# VDSEN autonomous release infrastructure

Status: repository infrastructure only; no production mutation. Initial reviewed state is `PENDING_EXTERNAL_SETUP`. Deployment IDs in `.release/vdsen-client.json` come from the historical observation in `CLIENT_PRODUCTION_RELEASE_PACKAGE.md`; live APIs must confirm them at every release.

## Delta and canonical behavior

The branch already has a deployment runbook, production package, numeric application flags, unit tests and an isolated emulator runner. This change reuses them. It adds four workflows, strict state/result schemas, dependency-free Node tooling and an agent contract. No app, rules, indexes, runtime dependency or persisted data contract changes.

The canonical runbook says the new app works with old rules and the old app does not work with new rules. Forward order therefore remains **app → rules**; rollback is **rules → app**. A rules-first forward release would break the old app. Index deployment, entitlements and legacy data review remain preconditions outside these workflows; the release only reads index state and never writes documents or manufactures identities.

## Trust boundaries and external setup

Developer/agent → reviewed branch/PR → credential-free test gates → protected `production` Environment → Google WIF + Vercel promotion → verified artifacts. Only workflow_dispatch on `codex/client-app-next` may mutate production. The workflows have no GitHub write permission and never update `main`.

Configure before enabling:

1. Protect `main` and `codex/client-app-next`: reviews for workflows, release scripts/state, rules and runtime; required `VDSEN release check`; no agent bypass or force pushes. Restrict `production` Environment deployment branches to `codex/client-app-next`, require an independent reviewer, prevent self-review and restrict workflow dispatch access.
2. Google WIF issuer: `https://token.actions.githubusercontent.com`. Bind exact repository `vdsenasesoria-svg/vdsen-ecosistema` (prefer immutable repository/owner IDs), `ref=refs/heads/codex/client-app-next`, `environment=production`, and the approved production/rollback workflow identities. Environment subject: `repo:vdsenasesoria-svg/vdsen-ecosistema:environment:production`. Do not trust PR subjects, forks or all workflows by default.
3. Allow this principal to impersonate only `RELEASE_SERVICE_ACCOUNT`. Grant only Firestore index read and Rules source read/create/release update for `vdsen-ecosistema`. No project-wide Owner/Editor, IAM administration, Auth users or document write access. Existing resources/APIs and exact least-privilege role assignment are Work's responsibility. No service-account JSON key.
4. Environment variables: `WORKLOAD_IDENTITY_PROVIDER`, `RELEASE_SERVICE_ACCOUNT`, `PRODUCTION_RELEASE_ENABLED` (initially `false`). Environment secret: `VERCEL_RELEASE_TOKEN`, a revocable credential scoped to the documented project/team with deployment read/promotion/rollback. If the account cannot provide project scope, do not substitute a broad personal token; keep production disabled until an isolated principal is available.
5. Verify Vercel Git integration keeps this branch as Preview and does not auto-promote it. Verify target preview's production environment compatibility (API entitlement, existing Firebase Admin and OpenAI configuration) before promotion: promotion does not rebuild. This infrastructure does not retrieve or rotate application secrets.
6. Review production package data, entitlement and human UX preconditions. Update the explicit state SHA, target/baseline deployment IDs and target rules hash in a reviewed commit, mark all preconditions true and status `READY`. Only then set the enable variable to `true`.

GitHub may only expose dispatchable workflows after they exist on the default branch. This task does not modify `main`: an owner must approve installing these workflow definitions there through a separate reviewed PR if GitHub requires it. Dispatch must select `codex/client-app-next`; production jobs reject `main`. Do not merge the application branch to install workflows.

## Release

Run `vdsen-release-check.yml` with the full reviewed runtime SHA on the canonical branch. PR checks run without credentials and also validate the state/runtime relationship. Package changes may affect only docs, tests, release tooling/state, workflows and AGENTS; all other tracked files must be identical to the runtime commit. Rules hashes use committed bytes, avoiding Windows checkout newline conversion.

Dispatch `vdsen-release-prod.yml` with that SHA and optional reason. Gates run npm's locked install without lifecycle scripts, all `tests/*.test.js`, all existing demo-project emulator suites and diff validation. Protected job verifies exact READY composite index including ordered fields/scope, baseline alias/project/SHA and target preview provenance. It exports actual live Rules source and saves `rollback-rules-RUN_ID` **before** any mutation. A failed upload blocks promotion.

The apply step repeats live preconditions, validates capture age/package identity and main baseline, promotes the exact preview, waits for the alias, creates the exact rules source, updates the Firestore release and reads the live source back. Public smoke compares client/coach/ficha/service-worker/numeric module bytes against the runtime commit. API error bodies and credentials are never printed. Actions are pinned to immutable commits.

Authenticated client/coach/security/write production smoke currently reports `GAP`. Public availability and emulator tenant tests do not replace it. Results are `PARTIAL`, never `PASS`, until a separately authorized authenticated smoke integration exists. No production user creation, test data writes or synthetic assertion of success. Review the existing production package's smoke procedure using approved test identities; authenticated automation remains a documented gap.

Failures after the first mutation trigger recovery: recreate captured rules, verify source, then rollback the app and compare baseline files. A rules restoration failure blocks the app rollback and records `rollback_status=FAIL`; operator intervention is required. Network loss can make a POST outcome ambiguous, so recovery begins even when the mutation request itself fails.

## Rollback and evidence

Dispatch `vdsen-rollback.yml` with `rollback_deployment` and original `release_run_id`. The artifact is downloaded only from that repository/run/name. The script confirms the original workflow path, event, canonical branch, package SHA, completed status and release ID. It rejects superseding app/rules states and verifies baseline deployment metadata before restoring. Rules source is recreated from the artifact so recovery does not depend on historical ruleset retention. Order: restore → verify rules → rollback app → verify SHA → baseline public smoke.

Production/rollback share a noncanceling concurrency group. External console/API changes are not covered by this lock and invalidate preflight assumptions; keep a single release writer. Forced cancellation, runner loss or timeout can interrupt recovery; use the already-persisted artifact for the rollback workflow. Never roll back Vercel manually while target rules remain active. Artifacts expire after 90 days; retain protected operational copies before expiry when longer recovery is required.

`release-result-RUN_ID` / `rollback-result-RUN_ID` conform to `.release/schema/release-result.schema.json`. A source artifact contains project, captured source/hash, old deployment/SHA, package identity and main reference, never credentials or user data. Artifact publication can itself fail; GitHub logs then remain the failure evidence. Releases do not auto-commit observed production state: review result evidence and update `.release/vdsen-client.json` in a separate branch commit. Stale baseline IDs intentionally block the next release.

## Improvement, troubleshooting and emergency stop

`vdsen-improvement-audit.yml` runs a read-only A0 audit of tests, TODO/FIXME and recent failed CI, and emits an artifact/proposal. Branch edits and PRs remain A1/A2; explicitly scoped staging is A3; only protected release jobs are A4. There is no scheduled production deployment or automatic merge.

- Index missing/CREATING: stop; have the authorized operator follow the existing index runbook, then rerun check. This workflow does not provision indexes.
- Rules or runtime hash mismatch: stop; review source/package equivalence, never relax the hash gate.
- Stale app baseline: reread Vercel metadata and update state through review; never infer the baseline from local `main`.
- WIF denied: check repository/ref/Environment/workflow claims and scoped impersonation. Never create a key as fallback.
- Vercel 401/403: check credential expiry and project/team scope; do not print token or widen permissions to diagnose.
- Authenticated GAP: arrange authorized smoke with existing approved identities; no release result may claim authenticated PASS without evidence.
- Emergency stop: set `PRODUCTION_RELEASE_ENABLED=false`, disable the production workflow in GitHub Actions, and revoke Vercel credential/WIF trust if compromised. To execute recovery after the stop, authorize and temporarily enable only the protected rollback path. Disabling does not undo an in-flight external POST.
- Rotate Vercel credential in its account/team administration using an authorized owner; replace only Environment secret `VERCEL_RELEASE_TOKEN`, run read-only metadata validation, revoke the old credential. Never paste values into chat/source/logs. Revoke immediately on compromise and keep workflow disabled until scope/recovery is verified.

## Local validation

`node scripts/release/check.cjs`; `node --test tests/release-infrastructure.test.js`; `node --test tests/*.test.js`; `node scripts/test-auto-apply-emulator.cjs`; `git diff --check`. Independently parse all workflow YAML and validate state/result schemas with a JSON Schema 2020-12 validator. Secret checks scan tracked files for credential formats/forbidden filenames and redact matches; this is a pattern check, not proof that every possible credential format is detectable.

API references: [Google WIF action](https://github.com/google-github-actions/auth), [Firebase Rules API](https://firebase.google.com/docs/reference/rules/rest), [Vercel promotion](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment), [Vercel rollback](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-previous-production-deployment-by-id). No live production APIs were called during implementation.

Implementation validation on Windows/Node 24: the unchanged base commit `904e7bc` reproduces the same 13 unit failures as the infrastructure checkout (1,050/1,063 base tests pass). These are preexisting failures, not waived release gates. Resolve them in a separate scoped change before declaring the release check operationally green. Workflow syntax is checked with actionlint 1.7.12; schemas are independently checked using JSON Schema 2020-12. Production workflow execution, WIF, Vercel scope and authenticated smoke remain unverified until external setup and an authorized rehearsal.

The full emulator runner also fails identically on that base: 47 pass, 36 fail, 1 cancelled (84 tests). The first three suites pass (7 portable, 18 lifecycle, 19 rules); subsequent suites encounter `UNKNOWN`/timeout errors. The runner's printed aggregate counters are zero under Node 24's default reporter, so this report uses each actual suite summary and the nonzero process exit, not those aggregate counters. Neither runner nor emulator tests were changed here; their diagnosis belongs to the prerequisite validation task.
