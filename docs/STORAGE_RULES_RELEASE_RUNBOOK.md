# Storage Rules release lane (readback / plan / verify-artifact; apply+rollback BLOCKED)

Status: **readback prepared, mutation blocked.** No workflow can publish Storage rules, and the library
refuses to do so because the platform offers no atomic precondition (see "Concurrency").

## Registration
`.release/storage-rules.json` registers project, bucket and release name. It is deliberately NOT in
`firebase.json`: that file is part of the hashed served surface (`.release/deployed-product.json`) and
T540 pins it, and `firebase deploy` must never publish Storage implicitly. The bucket is the single
`storageBucket` shipped in `vdsen-cliente.html` / `vdsen-coach.html`; `storage-rules.cjs` fails on drift.
Release resource: `projects/vdsen-ecosistema/releases/firebase.storage/<bucket>`.

## Stages (`scripts/release/storage-rules.cjs`)
| Stage | Effect | Notes |
|---|---|---|
| `readback` | GET release + ruleset, sha256, diff vs `storage.rules` | GET-only transport (`readOnlyFetch` rejects any other verb) |
| `capture` | readback + `storage.rules.<sha>.rules/.json` + `storage-custody.json` | provenance from CI env only |
| `plan` | `BLOCKED` unless live is readable and the artifact equals what is live now | best case is `READY_BLOCKED_NON_ATOMIC` |
| `verify-artifact` | integrity + provenance + optional `STORAGE_CUSTODY_DIGEST` match | for recovery / pre-use check |
| `apply`, `rollback` | library-only, `MUTATION_BLOCKED_NO_ATOMIC_PRECONDITION` | not reachable from any workflow or the CLI |

## Read-only identity (required; no fallback)
The readback workflow authenticates as a **dedicated** service account, set in the `Production`
environment variable `GCP_STORAGE_READONLY_SERVICE_ACCOUNT`, whose name must be exactly
`vdsen-storage-readonly@vdsen-ecosistema.iam.gserviceaccount.com`. The job fails before authentication if
the variable is unset, empty, or equal to the release bot. It is NOT created by this change.

Minimum privilege to request through the authorized IAM process:
- Custom role `vdsenStorageRulesReader` containing only `firebaserules.releases.get` and
  `firebaserules.rulesets.get` (`roles/firebaserules.viewer` is acceptable but broader: it also lists).
- Granted on project `vdsen-ecosistema` to that service account only.
- No `firebaserules.rulesets.create`, `firebaserules.releases.update`, no `iam.*`, no token-creator on
  other accounts, no Storage object or Firestore data roles.
- Token scope used by the job: `https://www.googleapis.com/auth/firebase.readonly`.

WIF restriction (so the read-only account cannot be assumed from arbitrary workflows):
- Bind `roles/iam.workloadIdentityUser` on the read-only service account to a principalSet limited to
  `attribute.repository/vdsenasesoria-svg/vdsen-ecosistema`.
- Provider attribute condition must additionally require the canonical ref
  (`assertion.ref == 'refs/heads/codex/client-app-next'`) and, ideally, `assertion.environment == 'Production'`
  and `assertion.job_workflow_ref` equal to `.github/workflows/vdsen-storage-readback.yml@refs/heads/codex/client-app-next`.
- The release bot keeps its own binding; the two accounts must not share impersonation grants.

## Rollback artifact: traceability and custody
Metadata records: project, bucket, release name, ruleset name, release `updateTime`, rules sha256 + size,
capture time, and provenance `{ source, repository, ref, run_id, run_attempt, commit, workflow }`.
Provenance is accepted only for repository `vdsenasesoria-svg/vdsen-ecosistema`, ref
`refs/heads/codex/client-app-next`, numeric run id/attempt and a 40-hex commit; local or hand-written
labels are rejected.

Custody (be precise about what is and is not guaranteed):
1. **Workflow artifact** `storage-readback-<run_id>`: retention 30 days. This is *temporary retention*,
   **not immutability**. Anyone with write access to the repository/actions can alter or delete it.
2. **Custody digest** (`storage-custody.json`, printed and written to the run summary): sha256 over
   metadata+bytes. It is a trust anchor only if the approver records it **outside** the artifact store
   (approval ticket / reviewed PR description). A digest stored next to the artifact proves nothing.
3. **Recovery**: download the artifact, place both files in a directory, then run
   `STORAGE_ROLLBACK_DIR=<dir> STORAGE_ROLLBACK_SHA=<sha> STORAGE_CUSTODY_DIGEST=<approved digest> node scripts/release/storage-rules.cjs verify-artifact`.
   A durable copy may be committed to `.release/rollback/` through a reviewed PR; note that branches are
   currently not protected (see AGENTS.md), so git history alone is also not an immutability guarantee.
4. Not implemented: signed attestations or a write-once bucket with retention lock. Either would give
   demonstrable immutability but needs new permissions (`attestations: write`, or a dedicated locked
   bucket) and therefore an explicit authorization.

## Concurrency (no atomic control is available)
The Firebase Rules REST API `projects.releases.patch` accepts `updateMask` but documents **no**
precondition (no etag, generation, or "if ruleset == X"). The `Release` resource exposes `updateTime`,
which can be *read* but not *asserted* on write. Consequently:
- `apply`/`rollback` re-read the release immediately before publishing and abort on ruleset, hash or
  `updateTime` drift. This narrows the race window; it does **not** eliminate it.
- Because no atomic guarantee exists, `ATOMIC_PRECONDITION_AVAILABLE=false` and mutation stays blocked.
  `allowNonAtomic:true` exists only for the synthetic rehearsal and is not reachable from the CLI.
- Uncertain outcomes (timeout, network error, 5xx, 429, malformed body after PATCH) are never retried
  blindly: the lane re-reads and classifies `APPLIED_VERIFIED_DEFERRED`, `NOT_APPLIED_VERIFIED` or
  `UNKNOWN_STATE_MANUAL_INTERVENTION`. If live rules are neither the target nor the captured previous
  rules, the lane does not overwrite them. An unverifiable restoration is reported as
  `*_ROLLBACK_UNVERIFIED`, never as success.

## Not verified by synthetic rehearsal
The in-memory fake models the documented REST contract only. Real IAM, quota, propagation delay between
PATCH and readback, release existence for this bucket, and `updateTime` semantics are unverified until the
live readback runs. Storage rules call `firestore.get/exists`; cross-service behaviour is a platform
concern not exercised here. A new Draft PR is required to introduce any publication workflow, with its own
kill switch, protected-environment approval, and a demonstrated concurrency control.
