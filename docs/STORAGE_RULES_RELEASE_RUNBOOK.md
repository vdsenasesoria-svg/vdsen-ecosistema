# Storage Rules release lane (readback / plan / apply / rollback)

Status: **prepared, not authorized**. Nothing here publishes rules; no workflow reaches `apply`/`rollback`.

## Registration
`.release/storage-rules.json` registers project, bucket and release name. It is deliberately NOT in
`firebase.json`: that file is part of the hashed served surface (`.release/deployed-product.json`) and
T540 pins it, and `firebase deploy` must never publish Storage implicitly. The bucket is the single
`storageBucket` shipped in `vdsen-cliente.html` / `vdsen-coach.html`; `storage-rules.cjs` fails on drift.
Release resource: `projects/vdsen-ecosistema/releases/firebase.storage/<bucket>`.

## Stages (`scripts/release/storage-rules.cjs`)
| Stage | Effect | Gate |
|---|---|---|
| `readback` | GET release + ruleset, sha256, diff vs `storage.rules` | none (read-only) |
| `capture` | readback + writes `storage.rules.<sha>.rules/.json` (identity, ruleset, hash, size, provenance) | none (read-only) |
| `plan` | BLOCKED unless live is readable and the artifact equals what is live now | none (read-only) |
| `apply` (library only) | create ruleset, PATCH release, verify, auto-restore on failed verify | `STORAGE_RULES_RELEASE_ENABLED=true` and `STORAGE_RULES_APPROVED_SHA == sha256(storage.rules)` |
| `rollback` (library only) | restore from verified artifact, verify | same gate, approved sha = artifact hash |

Fail-closed: unreadable/absent live rules, wrong project/bucket/identity, tampered or stale artifact,
failed verification. Responses and tokens are never logged.

## IAM required (NOT changed by this work)
Read-only lane: `firebaserules.releases.get`, `firebaserules.rulesets.get` for
`vdsen-release-bot@vdsen-ecosistema.iam.gserviceaccount.com` (role `roles/firebaserules.viewer`, or a
custom role with those two permissions). A future apply additionally needs `firebaserules.rulesets.create`
and `firebaserules.releases.update` plus `firebase.storage` `firebaserules.releases.create` only if the
release does not exist. Grant through the authorized IAM process, then dispatch
`vdsen-storage-readback.yml` from `codex/client-app-next`.

## Not verified by synthetic rehearsal
The in-memory fake models the documented Rules REST contract (`GET release`, `GET ruleset`, `POST rulesets`,
`PATCH release updateMask=rulesetName`). Real IAM behaviour, quota, propagation delay between PATCH and
readback, and the exact live bucket/release existence remain unverified until the live readback runs.
Also: Storage rules call `firestore.get/exists`; cross-service IAM for Storage to read Firestore is a
platform concern not exercised here.
