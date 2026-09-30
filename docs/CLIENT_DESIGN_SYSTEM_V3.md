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

## Residual visual debt
Performance-type exercise cards (cardio / calistenia / estación / circuito), the Coach-authored technique `detail` HTML, the body-map /
volume widgets, the InBody chart and the PDF export still carry legacy inline styling; they inherit the tokens where they use them.
