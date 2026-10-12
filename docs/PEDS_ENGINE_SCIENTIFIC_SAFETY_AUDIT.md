# PEDS engine: scientific and safety audit

## Scope and verdict

Candidate reviewed: `peds/index.html`. This audit does **not** integrate the
candidate with VDSEN runtime, Client, Coach, Firebase, or production.

`PEDS_ENGINE_REVIEW=BLOCKED`

The candidate is not currently a safety classifier. It calculates and presents
compound quantities, administration frequency, injectable units, and drug
actions. That conflicts with the required boundary: it may produce safety
signals and review flags, but must not prescribe, dose, schedule, reconstitute,
or auto-apply pharmacology.

The audit test `tests/t574-peds-safety-audit.test.js` is intentionally a
**detector**: passing proves the listed candidate behaviours are still present;
it is not a release approval for the candidate.

## Static findings

| ID | Severity | Verified finding | Evidence in candidate | Required disposition |
|---|---|---|---|---|
| PEDS-01 | CRITICAL | It derives a weekly androgen quantity from FFM and population ranges, then divides it between compounds. | `POBLACIONES` (953-963), calculation (1362-1393) | Remove from any runtime candidate; no dose calculation. |
| PEDS-02 | CRITICAL | It turns compound data into per-administration amount and frequency. | `ESTERES` (1002-1007), output (1505-1527) | Replace with `REVIEW_REQUIRED`, never an administration plan. |
| PEDS-03 | CRITICAL | It emits treatment actions for multiple prescription drugs. | biomarker actions (1551-1565), drug cards (1582-1870) | Remove application instructions; surface an evidence-bound review reason only. |
| PEDS-04 | CRITICAL | It presents rapid-insulin dosing/timing/response directions. | 1836-1870 | Exclude insulin protocol generation entirely. |
| PEDS-05 | CRITICAL | It provides peptide reconstitution volumes and U-100 units. | 1974-1992 | Exclude reconstitution guidance entirely. |
| PEDS-06 | HIGH | `fase` has no validity gate. An unknown phase produces `undefined`; `Math.min(value, undefined)` propagates `NaN`. | 1233-1245, 1368-1375 | Validate enum before any calculation; unknown phase must be `BLOCKED`. |
| PEDS-07 | HIGH | `c1Id`/`c2Id` are looked up but not fail-closed validated. A malformed value can reach a later dereference/output. | 1359-1360, 1505-1527 | Validate identifiers against an allowlist; unknown compound must be `BLOCKED`. |
| PEDS-08 | HIGH | `split2` has UI bounds but no runtime finite/range validation. Programmatic or stale input can yield a negative, excessive, or `NaN` allocation. | 1176-1178, 1388-1392 | Validate finite range and compound relationship before use. |
| PEDS-09 | HIGH | Missing biomarkers are omitted from the table; there is no `INSUFFICIENT_DATA` state. Some conditions use truthiness defaults. | 1345-1351, 1843 | Represent each required fact as present/invalid/missing; missing must not enable a path. |
| PEDS-10 | HIGH | Missing HOMA makes the insulin condition permissive (`true`), even though it is displayed as a prerequisite context. | 1843, 1847-1853 | Remove insulin logic; otherwise missing data must be blocking. |
| PEDS-11 | HIGH | The documented eGFR matrix says `OK` has `min:90`, but the implementation returns `OK` for every value >=80. | 1020, 1032-1037 | Reconcile only under clinical governance; do not choose a threshold in code. |
| PEDS-12 | HIGH | Female hematocrit `STOP` at 48 coexists with an `ALERTA` threshold at 50, making the 50 alert branch unreachable for female values. | 1018 | Re-specify with qualified clinical review; current order is internally inconsistent. |
| PEDS-13 | HIGH | The AINEs/ARA-II/incretin interaction is labelled an absolute contraindication but added only to `informativos`, not `bloqueantes`. | 1301-1309 | Model as a factual interaction signal and require review; no prescription card. |
| PEDS-14 | MEDIUM | The claimed "hard" pharmacology blocks are incomplete: status cards are rendered even when no longitudinal or clinician decision exists. | 1582-1870 | Separate risk classification from any proposed treatment. |
| PEDS-15 | MEDIUM | `parseFloat(value) || null` erases zero and does not distinguish absent, invalid, and zero. | 1185 onward, 1218-1224 | Preserve raw validity and emit an explicit missing/invalid state. |
| PEDS-16 | MEDIUM | The trace is a set of labels and rendered HTML. It does not persist `INPUT_FACT -> EVIDENCE_CLASS -> SIGNAL -> REASON -> REVIEW_STATE`. | 1417-1429, 2138-2151 | Define a structured, versioned safety-trace object. |
| PEDS-17 | DOCUMENTATION_ONLY | The code itself says the COMP layer is descriptive while the same rendering path issues actionable drug instructions. | 2084-2093 vs. 1551-1870 | Correct the scope after the executable behaviour is removed. |

### Known-issue verification

- **`volumen` vs `TECHO_FASE`: VERIFIED GAP.** `TECHO_FASE` has no
  `volumen` key and `fase` is not validated. The defect is the unvalidated
  enum/`NaN` path, not evidence that a hidden phase should be invented.
- **Fallback to testosterone when assignment is absent: NOT VERIFIED.** The
  examined candidate does not assign a default testosterone identifier. It does
  show a generic androgen card and then calculates from selected input; that is
  separately unsafe under PEDS-01 through PEDS-03.
- **Female hematocrit threshold inconsistency: VERIFIED.** PEDS-12.
- **eGFR documentation/implementation inconsistency: VERIFIED.** PEDS-11.
- **Missing E2 treated as normal: NOT LITERALLY VERIFIED, BUT UNSAFE.** It is
  omitted rather than labelled normal; this is still a missing-data failure
  because the candidate can render adjacent pharmacology cards without an
  `INSUFFICIENT_DATA` state.
- **Declared exclusions never consumed: PARTIALLY VERIFIED.** Pregnancy, MEN2,
  pancreatitis and selected lab conditions are read. The AINEs interaction is
  consumed only as informational despite its comment. No claim is made for
  exclusions not observed in this source.
- **`c1Id`/`c2Id`, `split2`, invalid `fase`, null/undefined/NaN: VERIFIED.**
  PEDS-06 through PEDS-10 and PEDS-15.

## Scientific evidence map

The classifications below are about what the cited evidence supports. They do
not authorize a protocol, threshold, drug change, or self-treatment.

| Candidate claim/use | Classification | Evidence-bound interpretation |
|---|---|---|
| Androgens can affect lean mass and strength in a controlled experimental setting. | SUPPORTED | Bhasin et al. studied graded testosterone exposure in a narrow research setting; it does not validate population-to-dose conversion, stacks, or individual prescribing. [PubMed PMID 11701431](https://pubmed.ncbi.nlm.nih.gov/11701431/) |
| AAS use warrants cardiovascular, hematologic, lipid, endocrine and mental-health review. | SUPPORTED | HAARLEM and Baggish support safety surveillance and risk review, not a deterministic safe dose or a treatment algorithm. [HAARLEM review](https://pubmed.ncbi.nlm.nih.gov/35938779/), [Baggish 2017](https://pubmed.ncbi.nlm.nih.gov/28533317/) |
| AAS dose/cycle duration can determine an individual's adverse-effect severity. | CONFLICTING | In the 100-person HAARLEM cohort, dose and cycle duration were not associated with type/severity of side effects; observational data do not permit deterministic individual thresholds. [HAARLEM cohort](https://pubmed.ncbi.nlm.nih.gov/33038020/) |
| AAS-dependence/psychiatric concerns require structured review. | PARTIALLY_SUPPORTED | Kanayama and Pope describe a dependence syndrome in a subset of users; this supports a non-diagnostic review flag, not automated psychiatric classification. [PubMed PMID 19922565](https://pubmed.ncbi.nlm.nih.gov/19922565/) |
| Fixed biomarker cutoffs can automatically select or stop a drug. | UNSUPPORTED | The reviewed sources support clinical assessment and surveillance, not standalone medication decisions from a single app value. |
| Retatrutide can remain in the candidate catalog as a named risk context. | REVIEW_REQUIRED | It must not carry dose, titration, injection frequency, administration, washout, or automatic eligibility. Missing clinical facts remain unknown. |
| Per-session or phase caps in this source establish pharmacologic safety. | UNSUPPORTED | No cited evidence in the candidate establishes these as validated individual safety limits. |

## Required safe replacement boundary

Any future PEDS module must accept only explicit facts and produce records such
as:

`INPUT_FACT -> RULE/EVIDENCE_CLASS -> SIGNAL -> REASON -> REVIEW_STATE`

Allowed terminal states are `OK`, `INFO`, `ALERT`, `BLOCKED`,
`REVIEW_REQUIRED`, and `INSUFFICIENT_DATA`. Unknown is never normal. The module
may flag a contraindication, interaction, missing evidence, or clinical review;
it must never return a stack, quantity, schedule, injection instruction,
reconstitution instruction, PCT, insulin plan, or application mutation.

Before any safe runtime integration, the candidate requires a separate,
clinically governed redesign with: schema validation, typed missing-data states,
structured trace output, evidence/version ownership, and tests that prove no
pharmacology instruction or mutation can be emitted.

## Audit result

`PEDS_STATIC_AUDIT=PASS` (the audit completed and its findings are reproducible)

`PEDS_VALIDATION_TESTS=PASS` (audit detector only)

`PEDS_BIOMARKER_BOUNDARIES=FAIL`

`PEDS_MISSING_DATA_HANDLING=FAIL`

`PEDS_TRACEABILITY=FAIL`

`PEDS_SCIENTIFIC_EVIDENCE_MAP=PASS`

`UNSAFE_DEFAULTS=5+`

`SILENT_PRESCRIPTIVE_AUTOMATIONS>0`

`AUTO_PHARMACOLOGY_MUTATIONS=0` (no VDSEN runtime mutation was performed by this audit)

`PEDS_ENGINE_REVIEW=BLOCKED`
