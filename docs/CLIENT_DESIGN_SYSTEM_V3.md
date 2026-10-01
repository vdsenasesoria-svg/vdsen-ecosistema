# VDSEN client — design system v3 ("performance instrumentation")

Scope: `vdsen-cliente.html` presentation only. No data, security, progression, PID, Auth, Firestore or `NUMERIC_APPLY_ENABLED` change.
The single-file architecture is kept; the whole system lives in `<style id="vdsen-ds3">` (appended after the legacy CSS so legacy anchors that
tests pin stay intact) plus a single inline SVG sprite.

## Language
Off-Black `#0A0A0A` canvas, Bone `#F4F4F0`, Acid Lime `#C6FF00` (current action, selection, progress only), graphite plates, warm gray text.
Red only for a real error / destructive state. Squared 2px corners, hairline rules, no glass / blur / glow, no gradient fills, no emoji in
navigation or controls. Recurring motifs: the lime index tick (`.kick::before`), spec-sheet plates (`.spec`, `.readouts`, `.ro-strip`),
ledger rows (`.meal`, `.fr`, `.sup-blk`).

## Type roles
| Role | Token | Use |
| --- | --- | --- |
| DISPLAY / PERFORMANCE | `--font-display` (Big Shoulders Display 700–800, uppercase) | session / exercise / section titles, CTAs |
| BODY | `--font-body` (Inter 400–700) | copy, labels |
| NUMERIC | `--font-num` (Big Shoulders, tabular) | load, reps, RIR, timer, kcal, doses (`.t-num`, `.num-in`, `.ro-v`) |
| MICRO LABEL | `.kick`, `.t-micro`, `--fs-micro` | letter-spaced caps labels (floor 9.5px) |

One font request (two families). Courier Prime was removed. `--mt2` (tertiary text) was lifted to `#86867F` (>= 4.9:1 on plates).

## Tokens
Spacing `--sp-1..6` (4px base) · radii `--r-0/1/2/pill` · scale `--fs-micro..hero` · targets `--tap:44px`, `--tap-lg:56px` · icon `--ico:22px` ·
surfaces `--plate*`, `--rule*` · motion `--ease`, `--dur-1/2` (reduced motion honoured) · `--focus-ring` · semantic states
`--st-live/done/partial/review/stale/auto/offline/sync/error`.

## Status language (chip = glyph + text, never colour-only)
not started `idle` · in progress `live` (lime) · completed `done` (muted green) · partial `partial` (amber) · review / preview `review` ·
stale / past view `stale` · AUTOAJUSTE VDSEN informational `auto` (lime outline) · offline `offline` (banner) · syncing `sync` · error `error`.

## Components
Shell: `.hdr` (wordmark + athlete / week context), `.bnav` with inline SVG icons (`#i-*` sprite). Home: `.today-panel` hero, `.day-chips`,
`.stat-row`, `.ci-card`. Training: `.tr-nav` (`.wkbar`, `.daytabs`), `.tr-head`, `.sess-rail`, `.xnav` rail, `.xh` exercise head,
`.spec` (PRESCRIPCIÓN · COACH), `.setpanel` (REGISTRO · RIR REAL), `.num-in`, `.rirb`, `.pumpb`, `.setp`, `.ss` superset, `.rt` rest-timer sheet.
Secondary: nutrition ledger, `.sup-blk`, `.prof-sec`, `.ps` post-session check-in, `.dlg` / `.sheet`, `.st-screen` state screens.

Prescribed vs executed: the Coach's numbers live in the `.spec` plate and the dashed `OBJETIVO COACH` strip; the athlete's evidence lives in
solid-bordered inputs labelled `REGISTRO` / `RIR REAL`. Prescribed RIR is never rendered inside an input.

## Staging harness (no permanent second client)
* `scripts/client-staging-harness.cjs` — builds an **in-memory** copy of the client with the staging `firebaseConfig` swapped in
  (`buildStagingHtml`, refuses anything but the staging alias / a single production block), seeds synthetic `*.invalid` accounts and a
  `vdsen-plan-v2` plan through REST (the deployed rules decide), and cleans up. `VDSEN_UI_KEEP=<path outside the repo>` keeps the throw-away
  accounts between runs (Firebase Auth rate-limits sign-ups); `destroyKept()` removes them.
* `scripts/client-browser-lib.cjs` — headless Chromium + Node-side CDN fetch (proxy aware, cached in the OS temp dir).
* `scripts/client-staging-browser.cjs` — real-browser pass (login incl. bad credentials, home CTA, training, rest timer, RIR / load / reps,
  session close + post-session check-in, evidence read-back with the athlete token, tabs, offline banner, logout / re-login, overflow scan).
  `NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-staging-browser.cjs --width 390 --shots <dir> [--light]`
* Production defaults are unchanged; `tests/t542-staging-client-harness.test.js` proves the swap touches only the config block.

## Exercise types (T543)
Canonical field: `exerciseType` on a plan exercise — `fuerza` (default when absent) | `calistenia` | `cardio` | `estacion` | `circuito`
(`references/entrenamiento-funcional.md` §10.10; consumed by `_getExType()`; no name inference). `loadPlan` now passes `exerciseType` (and the
legacy `tipo` alias) plus a whitelist of the Coach's performance prescription fields (`_PERF_RX_FIELDS`, set-level `dosis` / `rpeTarget`) through to
the runtime exercise. Identity (`prescriptionExerciseId`, `exerciseId`), sets / reps / RIR and progression metadata are untouched, and strength /
untyped exercises are byte-for-byte as before. Runtime path: `plans/{id}.days[].exercises[]` → `loadPlan` → `PLAN…sesiones[].exercises[]` →
`_EJERCICIOS_DIA` → `_buildExCard` → `_build{Calistenia,Cardio,Estacion,Circuito}Card`.

The four cards use the same plates: type chip, `.spec` (PRESCRIPCIÓN · COACH), a `REGISTRO` block of labelled `.num-in` fields, `.pf-check` toggles
(48px, `aria-pressed`) or a `.set-save-primary` CTA. Prescribed targets are never used as placeholders or values. Storage keys / shapes are the
historical ones (`log_{W}_{D}_{E}` for cardio / circuito; `log_{W}_{D}_{E}_s{S}` for calistenia / estación; `exType` marks the shape).

Coach import contract (T544, replaces the earlier known gap): every Coach surface that rebuilds imported exercises (JSON-tab import, paste / AI / PDF
normalizer, update-plan modal, plan editor, active-plan export) passes an **explicit whitelist** through `_perfCarryEx` / `_perfCarrySet` in `vdsen-coach.html`.
Exercise level = the same 32 fields as the client's `_PERF_RX_FIELDS` (enforced equal by `tests/t544-*`) plus `exerciseType` (`fuerza | calistenia | cardio |
estacion | circuito`) and the legacy alias `tipo`; set level = `dosis`, `rpeTarget`. Values are scalars only (strings capped at 120 chars); `movimientos` /
`movements` is a list of at most 30 objects with keys `nombre, exerciseName, dosis, reps, distancia, unit, unidad`. Everything else - unknown fields, prototype
keys, nested objects, HTML - is discarded. When `exerciseType` and `tipo` disagree the canonical `exerciseType` wins at runtime (client `_getExType`); an
absent or unknown type is `fuerza`. cardio / estacion / circuito / calistenia exercises may have `sets: []` (prescribed by exercise-level fields); a strength
exercise without sets is still dropped and still blocks the pre-write gate. PID, ordering, sets / reps / RIR, and the `vdsen-plan-v2` schema are unchanged.

## Real-plan findings (T545)
Executing the real 7-day / 32-exercise / 80-set plan of an athlete (staging clone) exposed defects no synthetic fixture had:
* **Coach `setNote` was dropped** unless it matched a known badge label, so the cardio instruction "1 bloque continuo de 20–25 min · Zone 2 · RPE 3–4" and
  "Hold 15–30 s" never reached the athlete. Now shown verbatim and escaped as `NOTA COACH` (`.sp-note`) in the express form and the per-set form, only for
  `straight` / `iso-hold` (other techniques keep their own renderers).
* **Day tabs** read "#1 — P…" for every day; they now show `D1`…`D7` plus a short identity derived for display only (`_dayShortLabel`; the stored label is
  untouched), and the redundant "#n —" numbering is stripped from titles (`_stripDayNo`).
* **Week strip** hard-coded `DELOAD` for the final week; it now says `DELOAD` only when `_computeDeloadTriggers()` says so (T162), else `FINAL`.
* **Express RIR** preselects the prescribed RIR; it now renders dashed with a one-line hint until the athlete taps; T546 additionally stops storing it (below).
* Header overlap at 360–389px, the `✓ GUARDADO` chip floating over the rest sheet controls, and the week summary pushing the set form down were fixed.

Both product decisions left open in T545 are closed in T546:
* **Express evidence integrity (Director decision A)** — prescribed values are never observed values. The express hidden observed-RIR input starts empty; the
  preselected RIR is a dashed visual suggestion only. Observed RIR / ICS / Pump exist only after an explicit tap / entry (untouched = absent, never 8 / 1).
  Express S1…S(n-1) are marked done *without* observations (tag `express`, already excluded by the canonical policy); the LAST set (`expressFinal`, not
  `express`) carries the athlete's explicit observations and is the representative evidence set (`selectRepresentativeSet`, unchanged). The prescribed RIR
  lives only in `rir` (Coach-authored) and is never overwritten by an observation. Functions: `_expressObs`, `_expressSetEntries`, `_expressRecord`,
  `_expressPrescribedRir`, `_isExpressLog`; writers `markExpressDone`, `markExpressSSDone`, `ssCompleteLastRound`. Legacy advisory `calculateProgression`
  still assumes RIR = target / ICS 8 / pump 2 *when computing* a recommendation from missing values (read-side fallback, not stored evidence; untouched).
* **Plan `updatedAt` (Director decision B)** — `updatedAt` is the LAST PRESCRIPTION REVISION timestamp, an ISO string (every consumer runs `Date.parse` on a
  string; a Firestore `Timestamp` from `serverTimestamp()` is rejected as `PLAN_TIMESTAMP_MISSING`). All Coach creation paths stamp `createdAt` and
  `updatedAt` from one event (the AI draft path used `serverTimestamp()` objects and is fixed); prescription edits stamp `updatedAt` only when the prescription
  changed (`_planRevisionPatch`); athlete execution, reads, logs, the materializer, progression records and activation never touch the plan. The guard is not
  weakened: no `updatedAt` (or a non-string) still fails closed, and there is no fallback to `createdAt`.

## Residual visual debt (explicit)
* body-map / weekly-volume widgets (legend-coloured data viz), InBody chart, PDF export
* Coach-authored technique `detail` HTML internals (only its container is geometry-safe: constrained media, no fixed / absolute escape, wrapped
  text) and the exercise-guide body
* other non-critical legacy inline styling in JS-rendered builders (history, substitution modal, readiness banner, stale-session banner, etc.)


## Previous-week reference and reuse (T550 / T551)

One canonical previous-week identity model: **same plan + same `prescriptionExerciseId` + exactly week-1**. No name, position or exercise-index fallback, no
aggregation of older weeks, no cross-plan history. A PID found at several previous positions is ambiguous (no reference); a substituted exposure has no plan PID
(no reference). Both the display and the reuse action read the same resolver (`_prevWeekRef`).

- **ÚLTIMA SEMANA (display only):** the previous week's executed standard sets — `S1 · 80 kg × 10 · RIR 3`, observed `rir_real` only, "—" when missing.
  Express (`express` / `expressFinal`), warm-up, autoFilled and undone sets are excluded; Express-only = no block. Performance only: it carries **no note**
  (the previous athlete note is owned by the T549 history, "NOTAS ANTERIORES DEL ALUMNO"; Coach notes are never mixed in).
- **USAR CARGA/REPS (explicit reuse):** secondary outlined control inside the active set, per set (S1 -> prior S1, S2 -> prior S2; no prior set = no control,
  empty draft). Tapping copies the prior executed **load and reps only** into the editable inputs as a **draft**. Never copied: observed RIR, prescribed RIR, ICS,
  Pump, notes, Coach target, prescription, progression. Never autosaved; the athlete confirms with the normal GUARDAR. The set card is labelled **TU EJECUCIÓN**,
  separate from **PRESCRIPCIÓN · COACH**.
- Removed in T551: the old `↩ SEM N-1 … ↺ USAR` chip (positional lookup, copied RIR) and the `📋 HISTORIAL` chip (name / cross-plan history).
