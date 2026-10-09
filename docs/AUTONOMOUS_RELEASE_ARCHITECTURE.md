# VDSEN autonomous release infrastructure

Bootstrap stays `PENDING_EXTERNAL_SETUP`; production kill switch defaults to **false**. This reconciliation does not mutate production or main, or request/access secret values.

## Canonical external contract

Repository `vdsenasesoria-svg/vdsen-ecosistema`, branch `codex/client-app-next`. Work reports existing Environment **Production**, ID `13808916927`. Reuse it; never create a lowercase duplicate.

| Environment variable | Expected public value |
|---|---|
| GCP_PROJECT_ID | vdsen-ecosistema |
| GCP_WORKLOAD_IDENTITY_PROVIDER | Provider resource supplied by Work |
| GCP_RELEASE_SERVICE_ACCOUNT | vdsen-release-bot@vdsen-ecosistema.iam.gserviceaccount.com |
| VERCEL_PROJECT_ID | prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN |
| VERCEL_ORG_ID | team_VZc5H7Q1DBIJ3g0mwrSBz1o8 |
| PRODUCTION_RELEASE_ENABLED | false initially |

Sole Environment secret: **VERCEL_TOKEN**. Only protected jobs consume it. No Google service-account JSON key. Runtime application secrets remain outside this infrastructure and are not retrieved or modified.

## Trust boundaries

Reviewed branch/PR → credential-free repository gates → protected Production Environment → Google Workload Identity Federation → exact Firestore Rules. Forward Vercel access is read-only; explicit rollback may switch the app. No workflow writes main, Firestore documents, Auth identities, entitlements, indexes or IAM.

OIDC issuer: `https://token.actions.githubusercontent.com`. Restrict exact repository (prefer immutable repository/owner IDs), ref `refs/heads/codex/client-app-next`, Environment `Production` and approved release/rollback workflow identities. Subject: `repo:vdsenasesoria-svg/vdsen-ecosistema:environment:Production`. Work configures scoped impersonation of the expected service account and only index read plus Rules source read/create/release update on the exact project. No Owner/Editor or IAM administration.

Use a revocable Vercel credential isolated to the identified project/team with metadata read and rollback permission. Keep production disabled if adequate scope/isolation is unavailable. Protect main and the integration branch with reviews/required checks and no agent bypass/force pushes. Protect Production with independent review, no self-review and the canonical branch only. GitHub may require definitions on its default branch before dispatch is available; installation there requires a separate owner-reviewed workflow-only PR. This task never modifies main or merges the application branch.

## State and rules-only forward release

> **Superseded 2026-10-07.** The paragraph below records the reconciliation that preceded the first
> Client App production release, so its identifiers are now the ROLLBACK side of that release and no
> longer describe production. Current truth lives in `.release/vdsen-client.json` (`runtime_sha`
> `8365410c...`, `production_deployment` `dpl_4xAS5kXuny7APpaRjozGeNdPETMj`) and its `app_release`
> block. The rest of this section still describes the rules-only forward path.

The user's authoritative reconciliation pins runtime `d7bb71521d750eafd46a15fdd3c6ee157d4bd4cf`, current production `dpl_FngrtpodSKHZ9aPk75aA5SS7JGnB`, rollback deployment `dpl_3RKY7UixzLDr9iK4NQ6VcKriz3Cn` and rollback runtime `f6596ba5207dc158b8a9b01483cd0fe0ebeb274c`. These are supplied identifiers, not new live observations. APIs must verify them again.

Forward mode is **rules_only**: verify the current app's approved SHA, capture rollback-compatible Rules, then deploy the exact pinned target Rules. Do not promote the historical preview or equate production with rollback. The canonical runbook explains why an old app cannot be paired with target Rules; recovery retains **Rules → app** ordering.

### Release mode is an explicit intent record

`.release/vdsen-client.json` carries `release_mode`, which records WHICH kind of release the reviewed
state is prepared for. Both lanes read the same file, so the mode is what stops one lane from being
driven by the other's baseline:

- the **Firestore rules lane** (`live.cjs`, `prepare()` and `apply()`) requires `rules_only`. The
  assertion is local and runs **before any network work**, so an `app_only` state can never reach the
  rules deploy path.
- the **Client App lane** (`app-live.cjs`) requires `app_only` at its mutation entry points (staging
  and promote). The read-only preflight deliberately does not check it, so diagnostics still work
  while a state is being prepared.

After the first Client App production release (2026-10-07) the state therefore reads `app_only`, and
`release_mode: app_only` **requires** an `app_release` block (JSON Schema `if`/`then`) whose fields
must agree with the top-level ones — `runtime_sha`, `production_deployment`, `rollback_deployment`
and `rollback_runtime_sha`. That cross-field coherence is enforced in `check.cjs`, because JSON
Schema cannot express equality between siblings.

**A future rules release must deliberately change the mode.** Setting `rules_only` is not enough on
its own: it must also capture and review the CURRENT live rules as its new rollback baseline and
update `rules_transition.rollback_*` before dispatch.

### `rules_transition` under an app-only state is HISTORICAL

While `release_mode` is `app_only`, the `rules_transition` block describes the **closed rules
release**, not a pending one:

- `target_sha256` is the rules hash that release deployed and that is still live
  (`ba172a4f...`). It is a property of the deployed app baseline, so it is re-verified on every
  check rather than being historical.
- `rollback_sha256` / `rollback_source_path` refer to the rules that release captured as ITS
  rollback baseline (`bb4402e9...`). They are **historical provenance** and are deliberately NOT
  rewritten when an app release happens: the app release did not touch rules, so silently moving
  those fields would destroy the evidence of what the rules release would have restored.

An app-only state must therefore never be read as "ready for a new rules deployment". The mode gate
above enforces that, and a test pins it.

`.release/vdsen-client.json` and its schema bind explicit runtime/deployment/project IDs, target hash, required ordered index, false numeric flag and reviewed preconditions. Bootstrap remains pending. A separately authorized reviewed commit may eventually mark state READY after the preconditions are satisfied. The separate Environment enable variable must also be exactly `true`; missing/false/uppercase/malformed values block live entrypoints before network activity. Repo-only checks remain runnable while production is disabled.

## Exact regression baseline

`.release/known-baseline-failures.json` records 50 exact identities from preserved logs reproduced on source `904e7bc7822982454fc8cec75f7e5c77d635d02c` and infrastructure commit `af13a6d`: 13 unit failures, 36 emulator failures and 1 emulator cancellation. Each records category, suite/file, exact test name, source SHA, test-source hash, failure status/reason and captured timestamp. Original log hashes bind the evidence. Counts are observations, never waivers.

The structured Node reporter emits exact file/name/status events across Windows/Linux and Node reporter defaults. The existing canonical emulator runner supplies the suite inventory. Gates reject unknown failures, changed failure/cancellation status, changed failing-test source, missing tests/suites, skips, duplicate identities, malformed results and invalid manifests. A known failure that executes and PASSes is `FIXED_BASELINE_FAILURE`; absence is not a fix. Recommend removing fixed entries through review; never modify the manifest automatically.

Noncritical known failures can pass the regression gate while the raw suite remains failing. **Critical/security failures never receive that allowance**, even when known. All emulator suites and release/security/provenance/secret/kill-switch/numeric tests, plus canonical write/tenant boundaries, are independently protected by code; a manifest flag cannot disable protection. Current pinned observations include 38 critical identities, so production remains blocked even with zero new regressions.

Artifacts separate `TEST_BASELINE_MATCH`, `NEW_REGRESSIONS`, `KNOWN_FAILURES_REMAINING`, `FIXED_BASELINE_FAILURES`, exact identity lists and `gate`. A YES baseline match is not production readiness. Production preparation requires both artifacts from this package/run, gate PASS, zero regressions and no critical failures.

## Workflows and recovery

Branch-native bootstrap does not require definitions on main: a push to `codex/client-app-next` starts both release-check and `vdsen-oidc-validate.yml`. Missing release-check input resolves only to the SHA in canonical state. The dedicated OIDC workflow is protected by Production and runs with the kill switch false; it does not call the release/rollback mutation path. Work must allow its exact push/ref/Environment/workflow identity in WIF and satisfy any Environment reviewer/branch restrictions. It validates scoped service-account impersonation and GET-only project/index/Rules release+ruleset/Vercel project metadata. Project metadata requires `resourcemanager.projects.get`. No client-data, IAM mutation, key creation or destructive negative probes. Result `oidc-validation-RUN_ID` contains status fields and `mutations_performed=false`, never tokens or response bodies; failed configuration/authentication also produces a failure artifact. Least-privilege absence remains GAP because successful metadata reads do not prove denial of other permissions. Production and rollback kill-switch guards remain unchanged. API references: [Google project metadata](https://docs.cloud.google.com/resource-manager/reference/rest/v1/projects/get), [Vercel project metadata](https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name).

`vdsen-release-check.yml` checks state/manifest, explicit dispatch SHA, runtime/package relationship, Rules/index provenance, all numeric flags, canonical variable references and tracked secret patterns; runs both baseline gates and uploads reports even if either fails. It has no live Environment binding, Production secrets or OIDC permission. PRs use the reviewed state SHA. The kill switch is reported disabled/unavailable by default; this job does not claim to read protected Environment variables.

`vdsen-release-prod.yml` runs both credential-free gates, then enters protected Production only on success. It checks the kill switch before OIDC, downloads this run's test evidence, authenticates via WIF and checks exact READY index/current app/rollback metadata. Capture live Rules and verify compatibility against the rollback runtime's committed Rules. Incompatible or unavailable source stops before mutation. Upload `rollback-rules-RUN_ID` before changing any Rules release pointer; upload failure blocks deployment.

Apply repeats live preconditions, package/run identity, capture age, current deployment/source provenance and unchanged main reference. Create exact runtime Rules, update only the Firestore release, reread live source/hash and compare public client/coach/ficha/service-worker/numeric-module bytes against the approved SHA. No arbitrary latest source or forward app promotion. Authenticated client/coach/security/write smoke reports GAP without authorized evidence; public smoke/emulator tests never manufacture production PASS, and result remains PARTIAL without that evidence.

After a possible mutation, recovery verifies captured source compatibility, restores exact Rules and verifies them before switching the app to the explicit rollback deployment. Then verify SHA and baseline files. Source/restoration failure prohibits an old-app switch. Ambiguous POST outcomes also trigger recovery.

`vdsen-rollback.yml` takes explicit deployment and original release run ID, downloads the exact repository/run/artifact, verifies workflow/event/ref/package provenance and rejects superseding app/Rules states. Order: restore captured compatible Rules → verify → explicit app rollback → verify SHA → baseline smoke → result artifact. Recreate from stored source if historical ruleset retention expires. Both workflows share noncanceling concurrency; external console changes are outside the lock. Runner loss/timeout can interrupt recovery; retain the pre-mutation artifact and use protected rollback. Never manually revert the app while target Rules remain.

Artifacts expire after 90 days; retain protected operational copies if longer recovery is required. Update observed state only through review. Release/rollback results conform to `.release/schema/release-result.schema.json`; preflight failures receive a schema-valid failure artifact with unverified main status instead of invented PASS.

## Improvement and operations

`vdsen-improvement-audit.yml` is read-only A0: inspect tests/TODO/failed CI/pinned baseline and emit proposals. A1 edits, A2 tests/PR preparation and separately configured A3 staging are permitted scopes. A4 is only the protected release/rollback path. No automatic waivers, production secrets, IAM changes, deployment or merge.

Emergency stop: set/keep `PRODUCTION_RELEASE_ENABLED=false`, disable production workflow, revoke compromised Vercel credential/WIF trust. This cannot undo a completed POST. Authorize and temporarily enable only protected rollback when necessary. Rotate/revoke Vercel credentials through an authorized owner, replace Environment VERCEL_TOKEN, validate read-only metadata and revoke the old credential; no values in chat/source/logs.

Missing/CREATING index: authorized existing index runbook outside this workflow. Hash/provenance mismatch: review source, never relax gates. WIF denial: check exact claims/scoped impersonation, never create keys. Vercel 401/403: check expiry/scope without printing credentials. Critical baseline failures: diagnose separately; never mark raw suites green or add waivers.

Local validation: infrastructure tests, `node scripts/release/check.cjs`, independent YAML/actionlint and JSON Schema 2020-12 validation, secret-pattern scan and `git diff --check`. Broad tests are run only to verify/regenerate baseline evidence. Pattern scanning does not prove detection of every credential format.

Push only with clearly verified workflow-write permission. Existing OAuth rejection and lack of another authenticated session mean **PENDING_AUTH_WORKFLOW_SCOPE**. Do not retry blindly, remove workflows, force-push or push main. Preserve the reconciled local commit for an authorized normal branch push.
