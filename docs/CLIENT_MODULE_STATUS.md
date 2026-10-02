# Client app — module status (closure, T557)

Director scope decision: the Client app is **TRAINING** (complete athlete experience) + **NUTRITION display** + **SUPPLEMENT display**.
Nutrition and supplementation need no athlete tracking, adherence, reminders, analytics, history, progression or interactive coaching logic.

| Module | Status |
|---|---|
| CLIENT TRAINING | **FEATURE_COMPLETE** |
| CLIENT NUTRITION | **DISPLAY_ONLY** (DISPLAY_READY) |
| CLIENT SUPPLEMENTS | **DISPLAY_ONLY** (DISPLAY_READY) |
| AUTO-APPLY | SEPARATE FUTURE PHASE (`NUMERIC_APPLY_ENABLED = false`) |
| EQUIPMENT INCREMENTS | SEPARATE FUTURE PHASE |
| GENERATOR / PLAN AUTHORING | SEPARATE SYSTEM (Coach side / Motor VDSEN) |

## Training feature freeze

`CLIENT_TRAINING_MODULE = FEATURE_COMPLETE` because: training P0 = 0, P1 = 0; human mobile gate = PASS; regression = PASS (see `docs/PRODUCTION_RELEASE_GATE.md`, T557).
From now on a training change needs **one of**: (A) a real production defect, (B) a concrete Coach / athlete usability problem, (C) an explicitly authorized new product phase. No speculative training polish.

## Training closure audit (existing evidence; no new exploratory audit)

Evidence keys: **U** = unit suite (`tests/*.test.js`, 1063), **E** = Firestore-emulator suites, **S:** = real-Client staging harness (`scripts/client-staging-*.cjs`, synthetic accounts, real staging rules), **H** = the athlete's own real sessions.

| Area | Evidence |
|---|---|
| LOGIN / SESSION START | S:t554-train, S:t554-scenarios (login persistence, fresh-context relogin), H |
| ACTIVE PLAN FIDELITY | S:t553-parity, S:coach-import 59, S:editor-fidelity 19, U:t552/t553 export round trips (32 PIDs, rest 0, supersetGroup / nivel_medio / variacion_vertical), provisioning 0 unexpected diffs |
| WEEK / DAY NAVIGATION | S:t554-scenarios S5 (all 7 days, 32 ex / 80 sets), H (Day 1, Day 6) |
| STANDARD PER-SET MODE | S:t554-train 30, S:standard-session 41 |
| DETAILED MODE DEFAULT | U:t556, S:t555 D3 / D5 (T556: detailed is the default; Express only when turned off in Perfil) |
| EXPRESS MODE | S:express-evidence 21, S:t554-scenarios S10, U:t546 |
| LOAD / REPS ENTRY | S:t554-train (explicit values audited in Firestore), S:standard-session |
| OBSERVED RIR / PRESCRIBED RIR SEPARATION | S:t554-train audit (plan byte-identical, observed != prescribed), U:t546 / t547 |
| ICS OPTIONAL, PUMP OPTIONAL | U:t554-no-silent-carry, S:t554-train (untouched = absent, no carry), S:t548 |
| SAVE / CORRECT SAVED SET | S:t554-scenarios S7 (Corregir, one record) |
| REST TIMER, REST COMPLETE ALERT, REST AUTO-ADVANCE | S:t548 54, S:t555 R1 / R3, U:t548 / t555 |
| SIGUIENTE / CONTINUAR | S:t555 R1 (serie n de N, exercise, reps / RIR; one tap), U:t385 / t394 / t555 |
| EXERCISE TRANSITIONS | S:t554-train (between exercises + reload), S:t548 |
| SUPERSETS | U:t115c / t484 / t546 (**not exercised on staging: the Ayrton plan has none**) |
| SPECIAL TECHNIQUES | S:t554-scenarios S5 (iso-hold, technique text), U:progression-engine / t488 / t515 (Y3T / FST7 / myo-reps are unit-level) |
| SUBSTITUTIONS | S:t554-scenarios S2, U:t506 |
| CARDIO / NON-STRENGTH RENDERER | S:t555 C (explicit `exerciseType: cardio`: card, log, completion, next action), U:t543 / t544 / t555 |
| ATHLETE NOTES, WEEK-TO-WEEK NOTE CONTINUITY | S:t549 53, S:t554-train (note by plan + PID + week), U:t549 |
| ÚLTIMA SEMANA, USAR CARGA/REPS | S:t550 41, S:t551 77, S:t554-scenarios S1, U:t550 / t551 / t553 (PID-only) |
| RELOAD / RESUME, LOGOUT / LOGIN | S:t554-train (after a saved set, during rest, between exercises, after completion; fresh context) |
| OFFLINE / RECONNECT | S:t554-scenarios S3 (Firestore really cut: no false success; queued write syncs once) |
| DUPLICATE-WRITE PROTECTION | S:t554-train (double tap), S:t554-scenarios S7, U:t399 / t404 |
| SESSION COMPLETION, POST-SESSION CHECK-IN, HOME NEXT-DAY STATE | S:t554-train, H (Day 6 completed by the athlete) |
| MOBILE 320–430 | S:mobile-qa 48 (320/360/375/390/414/430), S:t554-scenarios S4, S:t555 D1 (header) |
| LIGHT / DARK | S:t548 / t549 / t550 / t551 (dark + light viewports), S:nutrition-supplements (light) |
| ACCESSIBILITY | S:standard-session a11y checks (labels, 44 px targets, `aria-pressed`, reduced motion), U:t448 |
| TENANT / SECURITY BOUNDARIES | E: rules security 19, tenant isolation 11, Coach authority 6, active-plan edit 7, plans-create 8, athlete notes 4, lifecycle 18, T476 7 |

## Cardio — classification

The Ayrton plan's **Day 6 / Day 7 "Cardio Zone 2"** rows are authored as strength-shaped plan data (one 1-rep strength set, **no `exerciseType: cardio`**).
**Classification: PLAN AUTHORING / PLAN DATA ISSUE — not a Client renderer defect.** The Client already renders canonical cardio when `exerciseType` is provided (cardio card, single log, completion, rest -> next-exercise target; staging check `S:t555 C`).
Cardio is **never inferred from the exercise name** (a name-based inference added in T555 at the athlete's request was removed in T557 under the director's decision). The plan was not modified. The durable fix is on the Coach / plan-authoring side: set `exerciseType: "cardio"` (+ duration / zone) on those rows.
Defects fixed for explicit cardio only: it counts as one series in the day total (it counted three) and a pending cardio exercise is a real next exercise after the last strength set.

## Nutrition / supplements — display contract (display only)

The Coach delivers `clients/{uid}.nutritionPlan { calorias, proteina, carbos, grasas, texto }` and `supplementPlan { texto }` (text produced by the Coach converters `_nutritionJsonToPlan` / `_supplementsJsonToPlan`). The Client displays them; it does not require or create athlete tracking.
Staging display smoke (`scripts/client-staging-nutrition-supplements.cjs`, fixtures produced by the Coach's own converters): populated / long-text / macros-only / meals-only / empty, 390 + 320 + light, no NaN / undefined / raw markup, no horizontal overflow, controls do not error.
- **NUTRITION = DISPLAY_READY**: calories, macros, meals (name + time), foods + quantities, meal macros, preparation notes, supplements-with-meal, authored `[SUST: a | b | c]` substitutions. Coach-facing sections (SUPUESTOS / MONITOREO / lab alarms) are deliberately not shown to the athlete (existing parser contract).
- **SUPPLEMENTS = DISPLAY_READY**: authored name, full dose, authored timing, notes. Concrete defects fixed in T557: food quantities with a parenthesis / plural unit were mangled or truncated; a supplement lost its name digits ("Vitamina D3" -> "Vitamina D"), its dose descriptor ("2 g EPA+DHA" -> "2 G"), its timing and its notes, and a timing was guessed from the note.
- The pre-existing "Registro de hoy" / weight-trend widgets in the Nutrition tab are not part of the scope and were not touched.
