# COACH NEXT — FROZEN BASELINE

Status: **COACH NEXT CORE = COMPLETE**
Declared: 2026-10-09

## Canonical

```
COACH_NEXT_FINAL_CANONICAL = f06cc20c5b144524c59336b030ae017855ec602c
branch                     = codex/client-app-next
```

## Merge

```
PR #40                     MERGED
merge commit               = f06cc20c5b144524c59336b030ae017855ec602c
pre-merge head             = 47ed1ee1e712fd7298d204bf33bf08fea23343c3
pre-merge acceptance       = PASS
PR #42 (shell hotfix)      MERGED earlier
hotfix merge               = b51b43eb5a9fe6252e5b86f108e4bc7a61875542
```

## GitHub Actions evidence on the EXACT canonical SHA

```
VDSEN Coach Next acceptance   success   run 37874199014  sha=f06cc20c5b144524c59336b030ae017855ec602c
  EXPORTER_AUTHORIZATION_GATE = PASS
  EMULATOR                    = 11/11   (VDSEN_EXPORT_EMULATOR_COMPLETE tests=11 failures=0, sentinel observed)
  UNIT_RAW                    = 1283/0
  NEW_REGRESSIONS             = 0
  CRITICAL                    = []
  UNIT_GATE                   = PASS
VDSEN release check           success
VDSEN read-only OIDC validation success
```

## Browser evidence (foreground / unthrottled Chromium, on this branch)

```
mobile 390x844   23/23 PASS   MOBILE_ACCEPTANCE=PASS
desktop 1280x800 23/23 PASS   DESKTOP_ACCEPTANCE=PASS
10 sequential real-UI exports 10/10   A1/A2 alternating, exact client_id each time,
                                      zero duplicate, zero missing, zero cross-client contamination
real ZIP          PASS   36887 bytes (A1) / 27406 bytes (A2), valid structure, CRC valid,
                         20 entries, all JSON parse, 3 CSV non-empty
manifest          client_id and coach_id exact
same-name         PASS   A1 and A2 share a visible name; neither ZIP contains the other's sentinel
cross-coach       PASS   forced foreign id fails closed, zero ZIP
logout in flight  PASS   zero late download, zero late toast, dialog removed
network           PASS   0 production Firebase calls, 0 uploads, 0 remote media fetch
product exceptions 0
```

## Unchanged invariants

```
production runtime     8365410cf7f09427c79ead77aa4f769c16e9a803  (unchanged)
production deployment  dpl_4xAS5kXuny7APpaRjozGeNdPETMj         (unchanged)
production bytes       1092946  (identical)
main                   f6596ba5207dc158b8a9b01483cd0fe0ebeb274c  (unchanged)
firestore.rules        ba172a4f2e9831e55fb0a10c369b4a073193efb56eb5ea61245a0f178043e1e6  (unchanged)
CLIENT_APP_RELEASE_ENABLED=false
PRODUCTION_RELEASE_ENABLED=false
NUMERIC_APPLY_ENABLED=false
```

`READY_FOR_PRODUCTION_OWNER_GO = YES` — **not deployed**; no release workflow dispatched and no Vercel mutation.

## Product delta awaiting owner GO

```
12 files, +1522 / -6
  assets/client-export/{collect,derive,firestore-io,media,normalize,runner,security,serialize,ui,util,zip}.js
  vdsen-coach.html
No Firestore rules transition required.
```

## Closed diagnostics (do not reopen without new reproducible foreground evidence)

* `PLANS_CLIENTID_ONLY_DIAGNOSTIC = UNKNOWN_HTTP_500` — diagnostic only, never a PASS. The emulator's
  rules engine cannot evaluate the disjunctive `plans` rule for `clientId`-only queries. Rules are
  unchanged and the athlete read path is untouched. The original EM.7 assertion was invalid.
* Repeated-export "hang" — **refuted**. Root cause was background-tab `setTimeout` throttling in the
  acceptance browser (median 999 ms vs 0–4 ms foreground). With the same exporter and data: 10/10
  sequential exports, 97–115 ms each, `busy` false after every run. The acceptance workflow carries
  explicit anti-throttling flags so this is not rediscovered.
