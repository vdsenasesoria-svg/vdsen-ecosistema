# Client real-athlete gate (one staging session)

Build under test: `codex/client-app-next` (client release candidate) against **Firebase staging** with an account and plan created by the Coach for this
purpose. Not production. Automation (`docs/client-staging-ui-results.json`, `docs/client-staging-performance-results.json`) proves the UI works; it
cannot mark this sheet PASS — only the athlete + the Coach observer can.

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

Optional (only if the plan contains them): a cardio / calistenia / estación / circuito exercise saved and re-opened correctly. Note: plans imported through
the Coach app do not carry `exerciseType` today (see `docs/CLIENT_DESIGN_SYSTEM_V3.md`), so these appear only if the Coach seeded them another way.

Blocking issues found (describe): ______________________________________________

**RESULT:** ☐ READY_FOR_REAL_ATHLETE (all 11 ticked, no blocking issue)  ☐ BLOCKED

Signed (athlete): ________  (Coach): ________
