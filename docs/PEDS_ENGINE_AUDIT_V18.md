# PEDS engine v18 — audit baseline

Scope: `peds/index.html` only. This is an audit record; it does not authorize,
enable, or integrate pharmacology into the VDSEN runtime.

## Result

`PEDS_ENGINE_AUDIT_STATUS=BLOCKED`

The page is an executable pharmacology protocol generator, not a descriptive
or review-only surface. It calculates an androgen total from the selected
population and FFM, splits it across selected compounds, renders dose/frequency
cards, and saves each invocation through `_saveRun`.

The canonical VDSEN generator is a separate boundary: its API tests confirm
pharmacology is removed from model payloads and plan/client writes. The PEDS
page does not share that boundary.

## Deterministic audit matrix

| Case | Evidence | Classification | Result |
| --- | --- | --- | --- |
| Valid adult form with an androgen-enabled population | `generarProtocolo()` computes `totalMg`, `dosisC1mg`, `dosisC2mg` and renders an active card | FACT | FAIL — automatic pharmacology selection/calculation exists |
| Required laboratory data omitted | laboratory inputs are explicitly optional; missing values are not appended to `bloqueantes` | FACT | FAIL — no fail-closed missing-data gate |
| STOP or URGENCIA biomarker classification | status is rendered in the biomarker table but does not add to `bloqueantes` | FACT | FAIL — a critical signal can coexist with drug-card rendering |
| AINE collision | UI copy and `getTrazDesc('M9')` call it a hard block, while code only adds an `informativos` item | FACT | FAIL — comment/code contradiction |
| Peak-week water gate | missing `agua_validada` adds a blocking entry before drug cards | FACT | PASS — narrow gate only |
| Pregnancy/lactation gate | adds a blocking entry before drug cards | FACT | PASS — narrow gate only |
| Persisted audit trail | `_saveRun` stores inputs and summary, but no normalized decision object, rule outcomes, rendered-output hash, or source-version snapshot | FACT | PARTIAL — not reproducible traceability |
| Official VDSEN generator/API | `api/vdsen-contracts.test.js`, `api/vdsen-d.test.js`, `api/vdsen-generate.test.js` | FACT | PASS — 288 assertions reported by the component suites; pharmacology is excluded from generation/activation paths |

## Output classification contract

| Output type | Required classification | Current implementation |
| --- | --- | --- |
| Raw form values and saved input snapshot | FACT | Present, but not versioned as a clinical decision artifact |
| Biomarker threshold result, FFM calculation, phase/population mapping | SIGNAL | Rendered as if sufficient to drive cards; must not be a prescription authority |
| Consent, symptoms, history, clinician assessment, eligibility | REVIEW_REQUIRED | Checkbox/field inputs are treated as sufficient gates in several paths |
| Missing mandatory clinical data, conflicting data, critical/urgent signal, contraindication | BLOCKED | Only selected contraindications block; missing data and critical biomarker states do not reliably block |

## Proven contradictions and gaps

1. `COMP_HEALTH_AUDIT` says automatic androgen dosing should be disabled, while
   `generarProtocolo()` calculates and renders it.
2. M9 is described as a hard block but implemented as informational.
3. Critical biomarker states are displayed, not propagated into the blocking
   decision.
4. The reconstitution table is rendered after the blocking branch, so a
   non-emittable protocol still exposes operational preparation information.
5. The page persists `full_inputs` but not a typed decision trace. A later
   reviewer cannot deterministically distinguish a fact, signal, review, or
   block that produced the stored output.
6. Static-host exposure of `/peds/` is `UNKNOWN`; `vercel.json` has no explicit
   route for it, but a deployment inspection is required to establish serving
   status.

## Scientific consistency boundary

The code's research/clinical labels are not a sufficient safety mechanism for
automatic protocol generation. For example, FDA states that retatrutide is not
an approved drug and cannot be used in compounding; elamipretide's accelerated
approval is limited to Barth syndrome, not athletic use. These sources support
`BLOCKED` classification for automatic selection of those paths, not a dosing
rule.

- FDA: [retatrutide concerns and regulatory status](https://www.fda.gov/drugs/drug-alerts-and-statements/fdas-concerns-unapproved-glp-1-drugs-used-weight-loss)
- FDA: [Forzinity/elamipretide approval scope](https://www.fda.gov/news-events/press-announcements/fda-grants-accelerated-approval-first-treatment-barth-syndrome)

## Required next step before any runtime integration

Keep the engine out of runtime integration. Replace automatic selection and
calculation with a non-prescriptive evidence/review model, make missing or
critical clinical evidence fail closed, and persist a typed, versioned decision
trace before considering any further implementation.
