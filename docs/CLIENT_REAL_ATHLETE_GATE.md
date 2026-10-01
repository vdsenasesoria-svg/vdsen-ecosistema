# Client real-athlete gate (one staging session)

Build under test: `codex/client-app-next` (client release candidate) against **Firebase staging** with an account and plan created by the Coach for this
purpose. Not production. Automation (`docs/client-staging-ui-results.json`, `docs/client-staging-performance-results.json`) proves the UI works; it
cannot mark this sheet PASS — only the athlete + the Coach observer can.

Automated dress rehearsal (T545, not a substitute for the human PASS): one complete session of the real cloned 7-day plan (day 1, 5 exercises, 12 sets) was
executed through the real Client UI on staging, persisted, reloaded and re-logged-in — `docs/client-staging-real-session-results.json`
(`scripts/client-staging-real-session.cjs`). The synthetic staging account and its session log are kept so the athlete can review the completed-session UI.
**That rehearsed day 1 is synthetic and does NOT count as the human session:** the athlete's session is the next uncompleted day (day 2, "Lower A").

Express mode (the default entry path) — observed values need an explicit athlete action (T546). A preselected RIR is only a dashed suggestion; if the athlete
does not tap an RIR, no observed RIR is stored. Untouched ICS / Pump are stored as nothing (never 8 / 1). Express S1…S(n-1) only mark the sets done; the
final set carries the observed RIR / ICS / Pump the athlete actually entered and is the representative evidence set. Verified by
`scripts/client-staging-express-evidence.cjs` (`docs/client-staging-express-evidence-results.json`). Row 4 below therefore means: tap the RIR you actually had.

## Human gate status (T548)

**FULL HUMAN SESSION = COMPLETED** — Ayrton VD executed one complete real session (Lower B) on staging. It counts as the human acceptance session.
**TARGETED RECHECK = REQUIRED** — HUMAN UX = PARTIAL / NEEDS FIX until Ayrton confirms the four items below. Do **not** mark HUMAN UX PASS before that.

Findings from the real session (all addressed in T548; automation: `scripts/client-staging-t548-rest.cjs`, `docs/client-staging-t548-rest-results.json`, `tests/t548-human-findings.test.js`):
1. ICS was not self-explanatory -> label "Calidad de la serie (ICS)", helper "¿Qué tan buena fue esta serie? 1 = muy mala · 10 = excelente", placeholder "1–10" (stored `ics`, 1–10 range and progression semantics unchanged).
2. At the end of a rest the app did not move on -> at 00:00 it scrolls to the next pending set, or opens the next exercise, or shows SESIÓN LISTA PARA CERRAR. **Navigation only** — it never saves a set, never closes the session, never writes anything, and it does not move an athlete who already navigated elsewhere, cancelled the rest, or is typing.
3. The rest-complete notice was too subtle -> solid lime DESCANSO TERMINADO banner (10 s, assertive live region announced once, short vibration + tone when the browser allows; silent fallback).

Targeted recheck (short — no new full workout):

| # | Recheck | OK | Note |
| --- | --- | --- | --- |
| R1 | ICS wording is immediately understandable | ☐ | |
| R2 | one rest period advances to the next set correctly | ☐ | |
| R3 | one exercise-boundary rest advances to the next exercise correctly | ☐ | |
| R4 | the rest-complete alert is obvious enough | ☐ | |

Athlete: ______________  Coach observer: ______________  Device / browser: ______________  Date: ______________

| # | Check (tick when true) | OK | Note |
| --- | --- | --- | --- |
| 1 | START SESSION — from Home, the primary button opens today's session without hunting | ☐ | |
| 2 | PLAN / EXERCISE MATCH — exercise names, sets, reps, RIR and rest equal what the Coach wrote | ☐ | |
| 3 | LOAD / REPS ENTRY — entering load and reps is quick with one hand; keyboard never hides the field | ☐ | |
| 4 | OBSERVED RIR — choosing the RIR you actually had is clear and separate from the prescribed RIR | ☐ | |
| 5 | REST TIMER — appears after a set, is readable, can be minimised / closed | ☐ | |
| 6 | NAVIGATION BETWEEN EXERCISES — moving to the next / previous exercise (incl. a superset, if planned) is obvious | ☐ | |
| 7 | SESSION CLOSE — finishing the session works and says what was saved | ☐ | |
| 8 | POST-SESSION CHECK-IN — questions are understandable and submit | ☐ | |
| 9 | DATA PRESENT AFTER RELOGIN — log out, log in again: sets, load, reps, RIR and the closed session are still there | ☐ | |
| 10 | NO CONFUSING COACH VS ATHLETE VALUES — at no point did a Coach number look like something you entered, or vice versa | ☐ | |
| 11 | NO BLOCKING UI ISSUE — nothing cut off, unreadable in the gym light, untappable, or stuck | ☐ | |

Optional (any plan type the Coach import supports - fuerza, cardio, calistenia, estacion, circuito; T544): a non-strength exercise imported through the Coach
app keeps its type and prescription, executes, and is saved and re-opened correctly. Verified end to end on staging by `scripts/client-staging-coach-import.cjs`.

Blocking issues found (describe): ______________________________________________

**RESULT:** ☐ READY_FOR_REAL_ATHLETE (all 11 ticked, no blocking issue)  ☐ BLOCKED

Signed (athlete): ________  (Coach): ________
