# T554 — TRAIN-READY (staging Client for a real training session)

Scope: the **staging** Client preview (`vdsen-ecosistema-staging`) used for a real workout. Production is untouched and not deployed. `NUMERIC_APPLY_ENABLED = false`.

## Contract (the athlete path that must work)

login -> real plan loads -> correct week / day -> open session -> open first exercise -> Coach prescription clearly visible -> load -> reps -> observed RIR ->
save set -> rest timer -> advance -> notes -> previous-week reference (safe) -> USAR CARGA/REPS (safe) -> complete all exercises -> session completes ->
Home / Today updates -> hard reload -> state persists -> logout / login -> data still there -> prescription never overwritten -> no duplicate logs -> no false success.

Automated evidence (real Client UI, real staging rules, synthetic **automation** athlete; the human-training account is never used for automation):

| Harness | What it proves |
|---|---|
| `scripts/client-staging-t554-train.cjs` | Week 1 Day 1 (5 ex / 12 sets) per-set, explicit load / reps / observed RIR; double-tap Save; reload after a saved set / during rest / between exercises; rest at zero; notes; completion; logout / login in a fresh context; Firestore truth audit (PID / week / day / set, no fabricated ICS / Pump, no Express flags, prescription byte-identical, root mirror plan-bound) |
| `scripts/client-staging-t554-scenarios.cjs` | S1 Week 2 reference + USAR CARGA/REPS (same PID; Express-only; same-position wrong PID; no write before an explicit save; RIR / ICS / Pump / note never copied) - S2 substitution - S3 offline (Firestore really cut; no false success; the queued write syncs by itself exactly once) - S4 six phone widths - S5 all 7 days (32 ex / 80 sets, technique, iso-hold) - S6 long-session leaks - S7 rapid taps / navigate-after-save / Corregir - S8 no NaN / undefined text in any tab - S9 KG/LB - S10 full Express Day 1 (the app default entry path) |
| `scripts/staging-train-provision.cjs` | provisions the clean human-training account and the automation account (credentials only to a file outside the repo) |

## Defects found and fixed in T554

1. **ICS / Pump silently carried to the next set.** An untouched ICS / Pump on set N+1 was pre-filled with the previous set's value and saved as an observation. Now untouched = absent; the explicit "=" copy remains the only carry. ICS and Pump are visibly "opcional"; the Home hint for missing ICS is a quiet info line.
2. **GUARDAR SERIE / COMPLETAR EJERCICIO below the fold.** The primary action is now sticky above the bottom nav inside the current set card (per-set and Express), 320..430 px, dark and light.
3. **"NaN kcal / DÍA"** on the Nutrition tab when the athlete has no nutrition plan.
4. Service worker cache `vdsen-v11 -> vdsen-v12` (HTML stays network-first).

## Operating notes (verified)

- Express is the default entry path (a device that never touched Perfil -> Modo detallado). Both paths were run end to end. Express stores S1..S(n-1) as "done, no observation" and the last set as the representative evidence; "Modo detallado" gives every set its own load / reps / RIR.
- Merely opening / browsing the Client (login, tabs, day, exercise, reload) writes nothing to Firestore (client, logs, meso and plan `updateTime` unchanged).
- Offline: the "SIN CONEXIÓN" banner is shown, a set is not reported as saved and no rest timer starts for it; the queued write syncs by itself within seconds of reconnecting.
- A hard reload mid-rest restores the app cleanly; a saved set is never lost or duplicated.

## Known non-blocking items (not changed)

Coach root-log legacy / unbound display strategy; `EXERCISE_HISTORY` surviving plan switches; dead `buildBoostcampExercise`; staging API Admin runtime; equipment increments; auto-apply activation; production deployment. Plan data: day 6 / 7 "Cardio Zone 2" rows are authored as 1x1 strength-shaped sets (no `exerciseType: cardio`) - a Coach data decision, the prescription was not touched.
