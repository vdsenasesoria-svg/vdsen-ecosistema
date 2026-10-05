# VDSEN — Unified Engine Architecture

Status: Phase 1 — deterministic arbitration kernel in shadow/read-only mode

## Purpose

Unify M1 (Training & Physiology), N1/N1-DE (Nutrition Decision Engine) and S1 (Supplementation) without changing `vdsen-plan-v2`, Firestore collections, the frozen client Progression Engine, or the existing rule that numeric progression is not auto-applied.

The LLM is a proposal/interpretation layer. It is not the final authority for safety, mathematics, arbitration, contract validation, or commit.

## Canonical execution pipeline

```text
Ficha 360 / existing request sources
  -> READ / NORMALIZE / MAP
  -> Data & Contract Integrity
  -> Biological Safety authority
  -> Causal Context
  -> Signal Validity
  -> M1 / N1-DE / S1 proposals
  -> VDSEN Arbitration Kernel
  -> Deterministic domain validators
  -> Cross-Engine Validator
  -> Final Compiler / existing persistence boundary
  -> Decision Ledger / trace
  -> Learned Individual Posterior (only when learning gate allows)
```

Phase 1 does not create a new persistence path. `api/vdsen-arbitration.js` is pure and read-only.

## Non-negotiable ownership

- M1 owns training/physiology proposals and recovery constraints.
- N1/N1-DE owns nutrition adaptation proposals and longitudinal metabolic learning.
- S1 owns supplementation proposals and remains isolated from pharmacology.
- Higher-priority constraints may BLOCK or HOLD lower-priority proposals.
- No engine is authorized to mutate the final plan through the arbitration kernel.
- Existing plan persistence and explicit Coach approval remain the commit boundary.

## Priority routing

The routing namespace is independent from athlete/profile P0-P4 semantics.

```text
R0 Biological Safety
R1 Data / Contract Integrity
R2 Athlete Mode Constraints
R3 Recovery / Physiological Capacity
R4 N1-DE Nutrition Adaptation
R5 Training Progression
R6 S1 Supplementation
```

Rule: a higher-priority layer can block or modify a lower-priority proposal; a lower-priority layer never overrides a higher-priority constraint.

## Proposal contract

The kernel accepts categorical proposals. It does not calculate exercise volume, macros, doses, clinical thresholds, or progression magnitudes.

Minimum conceptual shape:

```json
{
  "id": "proposal-id",
  "domain": "TRAINING | NUTRITION | SUPPLEMENTATION",
  "decision": "domain-specific categorical action",
  "majorChange": false,
  "reasonCodes": []
}
```

Optional categorical metadata such as `tags: ["STIMULANT"]` may be supplied when already established by the owning engine.

## Causal context

Canonical Phase-1 event vocabulary:

- `TRAINING_LOAD_TRANSITION`
- `DELOAD_ACTIVE`
- `INJURY_EVENT`
- `ILLNESS_EVENT`
- `PHARMACOLOGY_TRANSITION`
- `CONTEST_MANIPULATION`
- `HYDRATION_INSTABILITY`
- `ADHERENCE_INVALID`
- `SLEEP_DISRUPTION`
- `GI_TOLERANCE_EVENT`

These events do not automatically mean the observation is false. They control whether an observation is valid for a particular inference.

Example:

```json
{
  "signal": "PERFORMANCE_TREND",
  "value": "DOWN",
  "validity": "INVALID_FOR_NUTRITION_INFERENCE",
  "reasonCodes": ["TRAINING_LOAD_TRANSITION"]
}
```

## N1-DE signal validity

Conceptually:

```text
S = [weight trend, adherence, performance trend, biofeedback]
S_valid = Q(S, causal context)
```

Phase 1 conservatively invalidates nutrition inference when known context contaminates attribution. It does not rewrite the raw observation.

## Posterior Learning Gate

Decision-making and learning are separate operations.

The system may make/review an operational decision while:

```text
posteriorUpdate = false
```

Learning is frozen when evidence is not attributable, including low/invalid adherence, critical/measurement-conflict data, insufficient observation window, or a causal event configured as a learning contaminant.

No contaminated window should be used to recalibrate the learned individual posterior.

## Cross-engine collisions

Canonical Phase-1 codes:

- `RECOVERY_ENERGY_CONFLICT`
- `TRAINING_ENERGY_AVAILABILITY_CONFLICT`
- `HEMODYNAMIC_STIMULANT_CONFLICT`
- `INVALID_TDEE_LEARNING_WINDOW`
- `TRAINING_TRANSITION_WEIGHT_CONFUSION`
- `LOW_ADHERENCE_INFERENCE_BLOCKED`
- `MULTIPLE_MAJOR_CHANGES`

These codes are deterministic categories. They are not free-text LLM judgments.

## Single-major-change policy

Default:

```text
singleMajorChangePreferred = true
```

When more than one major intervention is proposed in one evaluation cycle, the higher-priority proposal is retained and lower-priority major changes are held unless an explicit exception is supplied by an authorized context.

This is a causal-identifiability policy, not an absolute ban. Competitive/safety cases may require an explicit exception outside this kernel.

## Hysteresis

N1-DE continues to own its longitudinal evidence windows. The unified kernel must not create rapid reverse adjustments from short-term noise.

Future active integration should expose existing or canonical equivalents of:

- minimum evidence window
- decision cooldown
- reversal threshold
- prior decision context

No new numeric thresholds are introduced by Phase 1.

## OpenAI / ChatGPT boundary

OpenAI is the only LLM provider supported by the target architecture.

Appropriate LLM responsibilities:

- extract and normalize unstructured context;
- generate structured candidate proposals;
- explain already-authorized decisions;
- produce coach/client presentation text.

Not delegated solely to the LLM:

- safety precedence;
- macro arithmetic and ±3% validation;
- meal-count equality;
- schema validation;
- STOP/contract thresholds;
- priority routing;
- posterior learning eligibility;
- commit authorization.

## Compatibility constraints

Phase 1 intentionally does not modify:

- `vdsen-plan-v2`;
- Firestore collection names or shapes;
- set-log keys;
- `prescriptionExerciseId` semantics;
- frozen Progression Engine behavior;
- explicit Coach approval/persistence rules;
- pharmacology generation policy;
- `NUMERIC_APPLY_ENABLED=false` behavior.

## Phase-1 implementation files

- `api/vdsen-arbitration.js` — pure deterministic kernel.
- `tests/unified-arbitration-kernel.test.js` — unit coverage for precedence, causal validity, posterior freeze and collisions.

## Activation rule

The kernel must be integrated into the existing generation response path only as a shadow/validation layer before any future active numeric application. An arbitration result other than clean `ALLOW` must never authorize automatic numeric commit.

Active integration must preserve the existing public request/response contracts or introduce a separately reviewed versioned migration.
