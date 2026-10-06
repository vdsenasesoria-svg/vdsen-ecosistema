# Coach direct image upload — discovery and storage decision

**Result: `IMAGE_STORAGE_ARCHITECTURE_REQUIRED`** — no upload code was written. Base: `263084f397f7e81d8af67854d473788939755ebc` (frozen next-Coach candidate, verified as `origin/claude/coach-next-integration-v1`). Local branch `claude/coach-image-upload-v1`; docs only; not pushed.

## 1. Every Coach-facing image field (real model, nothing invented)
| | |
|---|---|
| screen / form | Coach → Catálogo → exercise row → **Metadata visual** (`openVisualMetadataEditor`, `vdsen-coach.html`), inputs `#vm-image` ("URL HTTPS") and `#vm-asset` ("Asset local") |
| document / record | `exercises/{exerciseId}` (one document per exercise per Coach, `coachId` = owner) |
| fields | `imageUrl` and `assetRef` (written together by `VDSEN_VISUAL_METADATA_EDITOR.buildPatch` → `updateDoc(exercises/{id}, patch)`) |
| value format | **URL only**: `imageUrl` = `https://…`; `assetRef` = `assets/<path>.(svg|png|jpg|jpeg|webp)` (a repo file). `mediaUrl()` **rejects anything else, including `data:` URIs** |
| rendering | Coach: no `<img>` (the editor only shows the text values). Athlete app: `_safeClientMediaUrl` (`vdsen-cliente.html:5763`) keeps only `https://`, `/…` and `assets/…`; a data URI would render **blank**. Built-in catalog (`assets/exercise-visual-catalog.js`) uses `imageUrl:null` + `assets/exercises/pending-license.svg` |
| how it saves | single `updateDoc` on `exercises/{id}` from the editor's Save button |
| document-size risk (single doc) | an exercise doc is a few KB; one processed image of ≤ 350 KB (≈ 470 KB as base64 text) would stay under the 1 MiB document limit, so the **per-document** risk is moderate, not the blocker |
No other Coach form stores or displays an image: the only other file inputs are PDFs (compendium, plan import) and a JSON/CSV importer; no client/progress photos, no avatars, no Firebase Storage SDK in either app. Client photos are exchanged outside the app (WhatsApp).

## 2. Why direct inline storage is unsafe here
The blocker is the **collection fan-out of `exercises/{id}.imageUrl`**, not the 1 MiB limit of one document:
1. **Every athlete downloads the whole collection on every plan load.** `loadPlan` (`vdsen-cliente.html:2799`) runs `getDocs(exercises where coachId == clientData.coachId)` and copies each `imageUrl` into `EXERCISE_CATALOG_ENTRIES` in memory. With inline images the payload per athlete session becomes *(number of exercises) × (image size)*: 100 exercises × 350 KB ≈ **35 MB** (≈ 47 MB as base64) per athlete, per load, on a phone, billed as reads/egress — even if the athlete never opens an exercise sheet.
2. **The Coach catalog also loads everything** (`loadExerciseCatalog` → `getDocs` + `_allExercises` in memory).
3. **Nothing can lazy-load or paginate it**: Firestore returns whole documents; there is no field-level fetch. Only a separate document/collection or object storage lets the image be read on demand.
4. **The current representation does not support it**: `mediaUrl` (Coach editor) and `_safeClientMediaUrl` (athlete app) both refuse `data:` URIs, so "reuse the existing representation" (CASE A) is not available; supporting it means changing the athlete app's sanitizer too (a Client rendering change, plus `exercises` is `allow read: if request.auth != null` — readable by any signed-in user).
Even a hard cap (e.g. 40 KB) leaves ≈ 4 MB per athlete load for 100 exercises and is far below the quality asked for (300–350 KB), so shrinking is not a fix.

## 3. Options (decision for Ayrton / a future session — none implemented)
* **A. Firebase Storage + keep `imageUrl` = HTTPS URL.** Fits the existing data model and both sanitizers unchanged; the editor uploads the processed JPEG/WebP and stores the download URL. Requires: a bucket, Storage rules (Coach may write only under their own prefix; athletes read), IAM/CORS, SDK load in the Coach app. *Out of scope for this task (forbidden here).*
* **B. Separate lazily-read collection** (e.g. `exerciseMedia/{exerciseId}` holding the data URI, `exercises.imageUrl` keeps a pointer). No new infrastructure, but needs `firestore.rules` for the new collection (forbidden here), a Coach-editor change and an athlete-app change to fetch it only when a sheet is opened.
* **C. Do nothing structural:** keep URL input (works today). The Coach can host an image anywhere (HTTPS) and paste the link.
Recommended: **A** (cleanest, scales, no per-session payload cost).

## 4. What is ready when the decision is made
The storage-agnostic part of the requested UX (validateImageFile / decode / resize to ≤1600 px / re-encode with quality steps / preview + object-URL cleanup / operation-token race guard / cleanup hooks on logout, coach switch, client switch, modal close, reusing the `_parkCoachShell` pattern of `263084f`) does not depend on where the bytes are stored and can be built, tested (unit + local browser E2E) and then wired to either Option A or B. Nothing of it was built, to avoid committing the product to an unapproved storage model.
