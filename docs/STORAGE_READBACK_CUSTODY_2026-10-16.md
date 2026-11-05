# Storage Rules live-readback custody record — 2026-10-16

This is a reviewed repository copy of the read-only GitHub Actions artifact from
[run 38895397679](https://github.com/vdsenasesoria-svg/vdsen-ecosistema/actions/runs/38895397679).
It records evidence only; this change did not publish, roll back, or otherwise mutate Firebase Storage.

| Field | Verified value |
|---|---|
| Canonical commit | `6b561b2177563bc02a993e539fb7514bee99ec5f` |
| Bucket | `vdsen-ecosistema.firebasestorage.app` |
| Active ruleset | `6c3b63ba-79e4-4f49-8859-58ccde680e63` |
| Active rules SHA-256 | `e656d238ee388d951268ca38d1eca2dbf2f5fdc55ef4b20e22911413d36c935b` |
| Candidate `storage.rules` SHA-256 | `e1d9545c9470449a554a765010f3b6c58ebf38dbfdff8f9de3db6e2d95bd3440` |
| Rules comparison | `DIFFERENT` |
| Custody digest | `9fa196aa001354981a437db0d5cc35ae963e8b1c897e9210501b90f132d4df4d` |

The copied artifact is in `.release/storage-rollback/` as a content-addressed rules source and its
metadata. Its source is a deny-all policy of 314 bytes. It was verified by the workflow using the
dedicated read-only identity and GET-only Rules API calls.

## Limits and recovery use

The original Actions artifact has temporary retention and neither it nor this Git copy demonstrates
immutability. The custody digest becomes an external trust anchor only when an approver records it in
an approval system outside both artifact storage and this repository. No production rollback has been
executed; rollback readiness therefore remains `NOT_PROVEN`.

Before any authorized release or recovery decision, re-verify this local copy with:

```powershell
$env:STORAGE_ROLLBACK_DIR = '.release/storage-rollback'
$env:STORAGE_ROLLBACK_SHA = 'e656d238ee388d951268ca38d1eca2dbf2f5fdc55ef4b20e22911413d36c935b'
$env:STORAGE_CUSTODY_DIGEST = '9fa196aa001354981a437db0d5cc35ae963e8b1c897e9210501b90f132d4df4d'
node scripts/release/storage-rules.cjs verify-artifact
```

Publication remains blocked by the Rules API's lack of an atomic release-update precondition. The
existing planner must continue to require current live readback, a matching rollback artifact, explicit
approval and a documented non-atomic decision; it must not be bypassed by this custody record.
