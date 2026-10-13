# SRA integration completion

Continuation from `66d9326bc0012b078af93b44f2277bd9570c08d1` on
`feat/sra-integration-2026-10-11`. PEDS is frozen.

## Authority and runtime

The existing T213 recovery sensitivity implementation and trace helper now live
in `assets/sra-context.js`. The Coach's `VDSEN_LEARNED` methods delegate to that
single implementation; Client and Coach reuse its context builder and escaped,
read-only renderer. No second recovery engine exists. The existing confidence
formula and comparative recovery thresholds are preserved.

SRA counts actual standard, completed, non-autoFilled persisted set keys with an
explicit current-plan prescriptionExerciseId. It does not reconstruct execution
from prescribed sets, progression estimates, names, positions, DOM inputs or
local backups. Recovery signals must come from an existing deloadTriggers array
for a session with eligible execution. Missing recovery signals are unknown,
never implicitly zero. Repeated rendering and repeated writes of the same set
key cannot append observations. An ambiguous current-plan PID fails closed.

Client evidence is a detached acknowledgement snapshot scoped by clientId and
planId. It advances only after the existing save path succeeds or an accepted
server snapshot arrives. Pending/cache snapshots, failed writes, older/equal
versions and superseded save acknowledgements cannot replace it. Logout and plan
loading invalidate it. Async refresh and subscription acceptance use captured
identities. Rollback or edits to mutable LOGS cannot change accepted evidence.
Coach SRA rendering requires matching active plan and a server snapshot without
pending writes or cached-only data.

The trace carries clientId + prescriptionExerciseId, evidence summary/window,
classification, original ruleOrRange, separate progression/recovery signals,
agreement state, final recommendation, reason, review flag and data status.
Progression actions come from the persisted PID recommendation. Recovery concerns
force REVIEW_REQUIRED in this explanatory context and preserve the original
progression action. They never apply a prescription delta. Missing identity or
evidence also requires review. Both apps expose the same read-only trace.

RULE, RANGE, HEURISTIC and MONITOR remain distinct. SESSION_VOLUME=MONITOR_ONLY.
NUMERIC_APPLY_ENABLED=false; SRA_AUTO_MUTATIONS=0;
SILENT_PRESCRIPTION_MUTATION=0. No load, reps, sets, volume, frequency or exercise
changes are produced by SRA. The module has no Firestore write capability.
Image Upload, PEDS, rules, main and production are outside this change.

## Runtime scenarios (16)

Executed with Node against the canonical engine, the actual Client renderer and
extracted persistence helpers. Coach consumer wiring is also checked. These are
synthetic runtime tests, not a production smoke or deployment approval.

- S01 stable real execution remains MONITOR
- S02 existing recovery concerns require review
- S03 favorable progression plus concern does not authorize an increase
- S04 conservative progression is preserved alongside SRA
- S05 RULE classification remains explicit
- S06 RANGE and HEURISTIC stay distinct
- S07 one exposure fails closed
- S08 absent/malformed recovery is unknown, never stable
- S09 session volume is MONITOR_ONLY and inputs remain identical
- S10 complete trace renders escaped evidence with separate signals
- S11 names and positions never substitute for PID
- S12 client and plan identities fence snapshots
- S13 pending and failed evidence excluded, no estimates from history
- S14 stale authority rejected and mutable/rollback state cannot leak
- S15 duplicate clicks and repeated rendering do not append evidence
- S16 real Client and Coach consumers use the single read-only engine

## Documentary checks (24)

Each check below is executable in `tests/t574-sra-documentary-firewall.test.js`.
The pending, failure, stale acknowledgement and rollback checks execute the real
extracted `_doSaveLogs` with controlled asynchronous writes.

- D01 canonical recovery engine
- D02 existing recovery trigger authority
- D03 raw persisted execution authority
- D04 PID authority excludes names and positions
- D05 client identity required
- D06 pending save excluded
- D07 failed write excluded
- D08 stale save acknowledgement excluded
- D09 rollback state detached
- D10 duplicate set authority is a map
- D11 DOM-only state excluded
- D12 autoFilled excluded
- D13 local backup not acknowledged
- D14 cached and pending server snapshots excluded
- D15 Client read-only render wired
- D16 Coach read-only render wired
- D17 trace includes complete evidence and reasons
- D18 progression signal preserved
- D19 RULE preserved
- D20 RANGE preserved
- D21 HEURISTIC preserved
- D22 MONITOR and SESSION_VOLUME monitor-only
- D23 numeric apply disabled
- D24 zero prescription mutations and write paths

## Validation

Commands:

```sh
node --test tests/t573-sra-integration.test.js tests/t574-sra-documentary-firewall.test.js
node scripts/release/baseline.cjs unit
NODE_USE_ENV_PROXY=1 node scripts/release/baseline.cjs emulator
GITHUB_REF=refs/heads/feat/sra-integration-2026-10-11 GITHUB_EVENT_NAME=pull_request node scripts/release/check.cjs
git diff --check
```

The release checker is run in its supported feature-branch PR context; its default
local mode requires the canonical release branch. Both release switches remain
false. Node uses the managed environment proxy for the emulator JAR download.
The emulator uses demo-vdsen-shadow and localhost, never production.

Exact result summaries and source SHA-256 values are in
`sra-validation-evidence.json`. The runner's package_sha is the starting HEAD
because validation preceded the completion commit; the source hashes bind the
results to the tested changed files. Existing baseline manifests are unchanged.
GitHub installation permissions were observed as contents=write, workflows=write
and actions=write before push. No workflows are changed by this task.
