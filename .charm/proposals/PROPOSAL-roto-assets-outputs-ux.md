# Proposal: Roto Assets & Outputs UX Improvements

**Status: DRAFT**

---

## Context

The rotoscoping workspace has two side panels — Project Assets (top-right) and Rotoscope Outputs (bottom-right) — that together cover the file management side of the roto workflow. Both panels were built incrementally across several bug-bash sprints and have accumulated interaction inconsistencies, layout quirks, and missing affordances. This proposal documents a batch of 11 targeted improvements identified from direct observation of the panels in use.

The changes fall into four categories: interaction polish (double-click, selection state), UX cleanup (toolbar layout, icon language, search behavior), feature gaps (grid view for videos, grid view for outputs, right-click menus), and a new capability (model size selection).

---

## Problems

### 1. No double-click to load

Every other media panel in the app (Remotion preview, comparison player) responds to double-click as the primary activation gesture. The Project Assets panel does not — users must target a small "Load" button on the right edge of the row. For a row that represents a file the user explicitly wants to activate, double-click should work.

### 2. No selection state on single click

Single-clicking a video row produces no visible feedback. The row does not highlight, no state changes. Users have no visual anchor for "which item am I about to act on" before they choose an action. Every other list in the app (outputs rows, editor file tree) shows a hover/selection state.

### 3. Loaded video path not persisted across restarts

After a restart, the `rotoStore.video` is cleared because the store is in-memory only. The list of registered project videos is fetched correctly from the backend on load (`list_project_videos`), but no attempt is made to restore the previously-loaded video. The "Clear" affordance appears on no row and the setup pane shows no source. The user has to manually re-click Load.

This is a session-continuity regression: the backend persists the video registry, the frontend does not restore the active selection from it.

### 4. Toolbar layout is backwards and the search bar is too narrow

The bottom toolbar of the Assets panel puts the search input first and the Sort button second. The request is the reverse: Sort A-Z first (a discrete action), then a wide search bar that fills the remaining space to the left of the List/Grid buttons. The current fixed-width `110px` search input wastes the available toolbar width.

### 5. Grid view does not apply to videos

The List/Grid toggle in the Assets panel switches the rendering mode of image assets but has no effect on the video list above it. Video rows always render as a flat list regardless of view mode. The toggle label "Grid" implies it applies to the whole panel, not just images.

### 6. No grid/list toggle for outputs

The Outputs panel has no view toggle at all. Every output is always rendered as a wide list row with a thumbnail on the left. A grid view (square thumbnail cards) would be more scannable when there are many outputs and the user is comparing thumbnails rather than reading metadata.

### 7. Right-click produces no menu in either panel

Right-clicking a row in either panel does nothing. All actions are only reachable via the visible buttons inline in each row. This is inconsistent with how every file management UI works. Users who right-click instinctively get no feedback.

### 8. Outputs row is too cluttered; Open folder / Open video / Export as... should move to right-click

The outputs row currently shows up to five action buttons inline (Open folder, Compare, Open video, Export as..., Delete). "Open folder" and "Open video" are low-frequency actions; "Export as..." requires a second format-picker step. All three make the row wide and push Compare (a high-frequency action) to the right edge where it is easy to miss. Cleaning these out of the inline row and putting them in a right-click context menu reduces visual noise without removing capability.

### 9. X icon (assets) should be a trash icon

The remove button on video rows shows the text "x". Every other destructive action in the app (delete output, future remove actions) either uses a red "Delete" label or should use a trash icon. The "x" is ambiguous — it reads as "dismiss" or "close" rather than "permanently remove from project". It should be a trash icon to match the destructive semantics.

### 10. Search bar filters on full path instead of filename

The Assets panel search filters on the full filesystem path (`v.path.toLowerCase().includes(q)`), meaning a user searching "recording" will miss a file if the project directory itself doesn't contain that substring — and will incorrectly surface files if the path prefix contains it. The filter should match only on the filename component (what `basename()` returns), which is what the user sees in the list and what they will type.

### 11. No model size selector

SAM2 ships in multiple model sizes (tiny, small, base_plus, large) with different accuracy/speed/VRAM tradeoffs. Users doing a rough cut want speed (tiny); users doing a final mask want accuracy (large). There is no way to choose from the app.

**Correction to the original framing (verified against the microservice code).** The original draft of this proposal assumed the SAM2 service "already parses a `model_size` form field (it falls back to `base_plus` when absent)." That is not true, and the gap is architectural, not a missing parse:

- `/rotoscope` parses only `video`, `points`, `job_id`, and `frame_skip` (`microservices/rotoscoping/main.py`). There is no `model_size` field and no fallback logic.
- The service loads **one** model at startup (`sam2_engine.load_predictor()` in the FastAPI lifespan), caches it in a module-global `_predictor`, keeps it warm in VRAM, and every job reuses it. There is no per-job model selection path at all.
- Which model loads is chosen by environment variables **at launch** — `ROTO_SAM2_CHECKPOINT`, `ROTO_SAM2_CONFIG`, `ROTO_SAM2_CHECKPOINT_URL` (`config.py`). These three move in lockstep and only one triple is wired today (base_plus). Note the config name uses the short size code (`b+`) while the checkpoint uses the long name (`base_plus`), so a size->assets mapping is not a trivial string substitution.
- Only one checkpoint is provisioned: `_ensure_weights()` downloads the single configured checkpoint on first run. The other three sizes are not present on disk.

Consequence: if we ship a frontend "Tiny | Small | Base+ | Large" selector plus a Rust passthrough as the original draft described, **the service silently ignores the field**. Every job still runs whatever model the service launched with, while the UI claims the user picked something else. That is a lying control — worse than having no control. The honest options are spelled out under Proposed Changes below.

---

## Proposed Changes

### Assets panel

**Double-click to load.** Add `onDoubleClick` to each video `<li>`. If the row is already the loaded source, the double-click is a no-op. Otherwise it calls `loadVideo({ path: v.path })` — the same call the Load button makes.

**Single-click selection state.** Track `selectedVideoPath: string | null` in local component state. A single click on a row sets it as selected. The selected row gets a distinct background (a shade lighter than the default row background, consistent with how the loaded row is highlighted) and a left accent border. Selection is purely visual — it does not trigger any action. Clicking off a row (clicking the empty list area) clears selection.

**Restore loaded video on mount.** On `refresh()` completion, check localStorage for a per-project `roto:loadedVideo:<slug>` key. If the stored path is present in the refreshed `projectVideos` list, call `loadVideo({ path })` to rehydrate the session. Write the key whenever `loadVideo` is called with a path; clear it on `resetRoto`. This makes restart behavior predictable: the last-used video is re-selected automatically, matching how every other editor panel restores its last state.

**Toolbar: Sort A-Z first, search fills remaining width.** Move the Sort button to the leftmost position in the left side of the toolbar. Change the search input from `width: 110px` to `flex: 1 1 auto; min-width: 80px` so it fills the gap between the Sort button and the List/Grid buttons on the right.

**Grid view applies to videos.** In grid mode, render video rows as square cards instead of the wide list row. Each card shows the purple VIDEO badge centered over a dark background (no thumbnail is available, so the badge serves as the visual), with the filename below in small text. On hover, a Load/Clear button appears overlaid at the bottom of the card. The remove (trash) icon appears at the top-right corner on hover. This makes the grid toggle meaningful for the primary content in the panel.

**Trash icon for remove.** Replace the "x" text in the remove button with an SVG trash icon matching the icon conventions used elsewhere in the app. Keep the red hover color. Tooltip: "Remove from project".

**Search by filename only.** Change the filter from `v.path.toLowerCase().includes(q)` to `basename(v.path).toLowerCase().includes(q)`. The `basename` helper already exists in the file.

**Right-click context menu.** On `onContextMenu` on any video row, open a small positioned menu with: Load (or Clear if already loaded), separator, Remove. The menu dismisses on Escape, on outside click, and on any action. It is a local `<div>` rendered into a portal so it escapes the panel's `overflow: hidden`.

### Outputs panel

**Grid/list toggle.** Add `view: "list" | "grid"` state with localStorage persistence (key `claude-motion:rotoOutputsView`). Add a List/Grid button pair in a new toolbar row pinned to the bottom of the panel — same layout as the Assets toolbar. In grid mode, render each output as a square card: thumbnail fills the card, name + frame count shown below, actions accessible via right-click only (no inline buttons in grid mode). In list mode, the current row layout is preserved, minus the buttons moved to right-click (see below).

**Outputs row cleanup.** Remove "Open folder", "Open video", and "Export as..." from the inline row actions. The visible inline actions in list mode become: Compare (conditional on source existing), Edit, Copy, and a trash icon delete. This reduces the row to four actions maximum, all of which are high-frequency or destructive.

**Right-click context menu for outputs.** On `onContextMenu` on any output row, open a context menu with the full action set: Play | Compare | separator | Open folder | Open video | Export as... | separator | Edit | Copy name | separator | Delete. Export as... in the context menu opens the same format-picker inline (GIF / MP4 / MOV). This preserves all existing capabilities while keeping the row clean.

**Trash icon for delete.** Replace the "Delete" text button (red) with an SVG trash icon. The inline confirmation prompt (showing "Delete? This removes all frames..." + confirm/cancel) is retained — the trash icon just triggers it. Tooltip: "Delete output".

### Controls panel

**Model size selector.** This item is materially larger than the other ten because the service architecture (single model loaded at startup, see Problem 11) does not support per-job selection today. There are three honest ways to deliver it; they are not equivalent in scope. Pick one before ticketing — the recommendation is Option A.

**Option A — Defer item 11 to its own proposal (recommended).** Ship the ten frontend UX items in this batch and split model-size selection into a dedicated proposal that designs the service-side swap properly. Rationale: the ten UX items are all-frontend, independent, and low-risk; bolting a GPU-hot-path change onto them mixes a quick UX pass with a microservice redesign and gates the whole batch on the harder, riskier piece. This keeps this proposal's "no new backend behavior" property intact.

**Option B — Full per-job model swap (the real feature).** Deliver the selector end to end. Work required on the service:
- Add a `MODEL_SIZES` map: `size -> (checkpoint_name, config_name, download_url)` for tiny/small/base_plus/large, respecting the `b+`-vs-`base_plus` naming split and the lockstep rule. Keep env vars as an override of the default size.
- Parse `model_size` in `/rotoscope` (default to the launched size when absent, preserving existing clients).
- Swap only when the size actually changes. If the requested size equals the resident model's size, reuse the warm `_predictor` as-is — no teardown, no reload, no download. The offload path runs ONLY when the requested size differs from what is currently loaded (this keeps the common case — repeated jobs at the same size — exactly as fast as today).
- On a job whose requested size differs from the resident model: download that checkpoint if missing (one-time; roughly hundreds of MB up to ~2.5 GB for large), tear down `_predictor`, free VRAM (`torch.cuda.empty_cache()`), and rebuild via `load_predictor()` for the new triple. This is a cold swap costing seconds to tens of seconds, paid only on the first job after a size change.
- Guard the swap against the single-instance job model: the engine processes one job at a time against the shared global `_predictor`, so a swap must never happen while a job is in flight (serialize the swap ahead of job start, or reject/queue concurrent size changes). Surface swap/download state through `roto://progress` (e.g. a "loading model" stage) so the UI does not look hung during a multi-second rebuild.
- Frontend + Rust as the original draft described (store field, `RotoControls` segmented group, `useRotoJobQueue` -> `rotoscope_video` -> `build_multipart` `field("model_size", ...)`), but now the field is actually honored.

This touches the GPU path, the weights-provisioning path, and the job concurrency model — a separate effort from the UX batch and best done as its own proposal regardless of whether it lands now or later.

**Option C — Surface the loaded model read-only (smallest honest option).** No per-job picking. `/health` already reports the loaded model via `MODEL_LABEL` and VRAM stats. Add a read-only line to `RotoControls.tsx` showing "Model: base_plus" (and optionally VRAM headroom) sourced from the existing health poll. Changing the model still means relaunching the service with different `ROTO_SAM2_*` env vars — which is the current reality — but at least the UI stops being silent about which model is running. No store field, no `model_size` passthrough, no microservice logic change.

Whichever option is chosen, do **not** ship the frontend selector + Rust passthrough alone (the original draft's plan): that produces the lying control described in Problem 11.

**Reporting model-swap progress — no new pattern needed.** The job lifecycle already uses the strongest of the three request/response shapes, so the swap reuses it rather than inventing anything:

- *Short-polling* (client GETs a status endpoint on a loop until done) is simple and proxy-proof but chatty, with completion latency bounded by the poll interval.
- *Long-polling* (one request; the server holds the connection open and answers only when the job finishes) needs just one request, but it pins a server worker for the whole job (minutes here), is the classic victim of idle-timeout kills (proxies / load balancers / client read timeouts), and gives no mid-flight progress on its own — which is precisely why it forces a *separate* progress endpoint.
- *SSE streaming* — what this service already does — is one request held open like long-poll, except the server pushes a stream of incremental `{stage, progress, frames_done, frames_total}` events and closes on the terminal event. It gets long-poll's single-request efficiency AND live percentage in one channel (`X-Accel-Buffering: no` is already set to defeat proxy buffering). The current flow is: `POST /rotoscope` -> 202 + `job_id` immediately; `GET /rotoscope/{job_id}/progress` -> SSE stream (consumed by `run_progress_stream` in `rotoscoping.rs`, re-emitted as the `roto://progress` Tauri event); `GET /rotoscope/{job_id}/result` -> the ZIP; `DELETE` -> cancel. The "separate endpoint to gauge completion %" already exists — it is the progress SSE, distinct from result.

Because the download + predictor swap happen INSIDE the GPU job (after the 202, serialized behind the GPU lock), their progress rides this existing stream as new stage values ahead of the frame stages: `downloading_model` (with `progress` = download fraction) then `loading_model`. The Rust consumer forwards them unchanged; the frontend only needs to recognize the new `stage` labels and render a "loading model..." state. A job queued behind an in-flight swap simply reports `queued` -> the UI shows "waiting / loading model" rather than a frozen bar. No new endpoint, no new pattern, no change to the 202 + SSE + result contract.

---

## Files touched

| File | Changes |
|---|---|
| `src/components/RotoPanel/RotoAssetsPanel.tsx` | Double-click, selection state, restart persistence, toolbar reorder, grid for videos, trash icon, filename-only search, right-click menu |
| `src/components/RotoPanel/RotoOutputsPanel.tsx` | Grid/list toggle + toolbar, row cleanup, right-click menu, trash icon |
| `src/components/icons.tsx` | Trash icon SVG (if not already present) |

The following rows apply **only to item 11** and depend on which option is chosen (see Controls panel above). Under the recommended Option A they move to a separate proposal; under Option C only `RotoControls.tsx` is touched (read-only display, no store/Rust/service changes).

| File | Changes (item 11) |
|---|---|
| `src/components/RotoPanel/RotoControls.tsx` | Model size selector row (Option B) or read-only loaded-model line (Option C) |
| `src/store/rotoStore.ts` | `modelSize` field + `setModelSize` action (Option B only) |
| `src/hooks/useRotoJobQueue.ts` | Thread `modelSize` into `rotoscope_video` invoke (Option B only) |
| `src-tauri/src/commands/rotoscoping.rs` | Accept + pass through `model_size` (Option B only) |
| `microservices/rotoscoping/{main,config,sam2_engine}.py` | Size->assets map, `model_size` parse, on-demand checkpoint download, predictor swap with in-flight guard (Option B only) |

---

## What is not changing

The underlying data model (persisted videos, output folder structure, job queue) is unchanged. No new Tauri commands are needed for the interaction changes — all selection state, view mode, and context menus are purely frontend.

For items 1-10 there is **no backend change at all**. Item 11 is the only thing that reaches past the frontend, and how far it reaches depends on the option chosen (see Controls panel): Option A and C touch no Rust and no microservice; only Option B threads `model_size` through `rotoscope_video` and adds the service-side swap. The original draft's claim that "the backend default handles the absent case" was wrong — the service has no `model_size` handling today (see Problem 11).

---

## Delivery

Items 1-10 are independent of each other and can be delivered in one frontend pass across the two panel files (plus the shared trash icon). The right-click menu component can be written once as a shared utility and reused by both panels. Recommended sequencing: assets panel changes first (most numerous), then outputs panel changes.

Item 11 is deliberately separated out. Under the recommended Option A it is **not** part of this batch — it becomes its own proposal so the GPU-path/weights/concurrency work (Option B) gets designed on its own terms rather than riding along with a frontend UX pass. If instead Option C is chosen, item 11 collapses to a small read-only addition in `RotoControls.tsx` and can ship alongside items 1-10. Do not pick the original "frontend selector + passthrough only" plan under any option — see Problem 11 for why it produces a control that lies to the user.
