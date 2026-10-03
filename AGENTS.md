# VDSEN agent contract

- Canonical branch: `codex/client-app-next`. Never commit, push, merge, or force-push `main`.
- Firebase production: `vdsen-ecosistema`; staging: `vdsen-ecosistema-staging`.
- Vercel production: `prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN`, team `team_VZc5H7Q1DBIJ3g0mwrSBz1o8`.
- Forbidden: `vdsen-planes`, broad IAM changes, service-account keys, production identities/data migrations, secret retrieval or printing by agents.
- A0 analysis; A1 branch edits; A2 PR + tests; A3 explicitly authorized staging; A4 production only through controlled GitHub workflows. Codex/Claude default A2; A3 requires staging scope.
- Production path: `.github/workflows/vdsen-release-prod.yml`, Environment `production`, Google WIF, scoped Vercel credential. Agents never run production mutations locally.
- Source of truth: `.release/vdsen-client.json`, `docs/FIRESTORE_DEPLOYMENT_RUNBOOK.md`, existing runtime engines/contracts. Use small compatible deltas; no unrelated refactors.
- Invariant: `NUMERIC_APPLY_ENABLED=false`. Never enable numeric application in a release infrastructure change.
- Gates: exact approved runtime SHA and immutable preview, runtime/package equivalence, target rules hash, exact READY index, captured rollback rules artifact, baseline deployment metadata, unit + emulator suites, no secrets, reviewed preconditions.
- Forward order: capture/validate → app → rules → smoke. Old app is incompatible with target rules. Recovery/rollback: restore and verify old rules → old app → verify SHA → smoke. Never revert app if rule restoration fails.
- Data boundaries: no release tool writes Firestore documents, Auth identities, entitlements or indexes. Synthetic emulator users only. Production authenticated/write smoke reports GAP when evidence is unavailable; GAP is never PASS.
- Testing: `node scripts/release/check.cjs`; `node --test tests/*.test.js`; `node scripts/test-auto-apply-emulator.cjs`; `git diff --check`. Report specific/related/full suite separately; never claim unexecuted checks PASS.
- Security: production credentials exist only in protected workflow jobs, never in repo or agent sessions. No `pull_request_target`, untrusted PR code with secrets, or workflow token write permission.
- Improvement loop may inspect tests/TODO/failed CI and prepare branch/PR proposals. No deployment, automatic merge, data repair or numeric activation. Preserve stable IDs, tenant isolation, persisted JSON contracts and keyboard accessibility.
