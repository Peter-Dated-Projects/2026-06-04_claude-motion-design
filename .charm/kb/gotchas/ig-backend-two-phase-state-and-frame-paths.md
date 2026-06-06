---
id: ig-backend-two-phase-state-and-frame-paths
root: gotchas
type: gotcha
status: current
summary: "The IG Rust backend (ig_pipeline.rs) is stateless between Phase A and Phase B: Phase B's store needs ALL FOUR stage outputs, so the frontend must round-trip download/clip/scoreResult back into ig_extract_phase_b, not just the kept-frame list. Phase A frame paths live in <project>/.ig-work/<id>/frames/ and only MOVE into extractions/<date>_<id>/frames/ (3-digit names) when Phase B's store runs."
created: 2026-06-06
updated: 2026-06-06
---

`src-tauri/src/commands/ig_pipeline.rs` (T-025) splits the pipeline into two
separate Tauri commands so the UI can pause for review between the free Phase A
(download->clip->frames->score) and the ~$0.21 Phase B (analyze->store). The
backend keeps NO state between the two calls. Consequences for the frontend
(T-023 store) and the integration wiring (T-032):

- **Round-trip the Phase A results.** `store.ts` composes the extraction folder
  from the four-key blob `{download, clip, scoreResult, analyze}`. The backend
  only produces `analyze` in Phase B, so `ig_extract_phase_b` takes a
  `PhaseBInput { download, clip, scoreResult, keptFramePaths }` -- the frontend
  must persist the `PhaseAResult` it got back from `ig_extract_phase_a` (or off the
  `ig://score` event) and hand it all back. Passing only the kept-frame list is
  not enough; store would have nothing to write.

- **`keptFramePaths` is the analyze input, NOT the persisted set.** The user's
  override only changes which frames `analyze` reads. `scoreResult` (all scored
  frames) is what store persists, so pass the ORIGINAL scoreResult through
  unchanged alongside the overridden `keptFramePaths`.

- **Phase A frame paths are temporary.** clip/frames/score run into a throwaway
  `<project>/.ig-work/<id>/` working dir, so `ScoredFrame.path` in the Phase A
  result / `ig://score` event points at `<project>/.ig-work/<id>/frames/frame_NNNN.jpg`
  (ffmpeg's 4-digit candidate names; see [[ig-frames-4digit-vs-store-3digit]]).
  The review grid renders those. Phase B's `store` MOVES the media into the real
  `extractions/<date>_<id>/` folder (3-digit `frame_NNN.jpg`) and the backend then
  deletes `.ig-work/<id>`. So after Phase B the Phase-A frame paths are dead --
  a reload/list of a past extraction must read the extraction folder, never
  `.ig-work`. (This also means the asset-protocol scope must allow `.ig-work` for
  the live review grid AND the extraction folder for reloads.)

- **delta serializes as `null`, rejectReason is omitted.** `ScoredFrame.delta` is
  `Option<f64>` serialized WITHOUT `skip_serializing_if` (None -> JSON `null`),
  because the contract is `delta: number | null` and score.ts emits the key present.
  Omitting it would surface as `undefined` on the frontend = drift. Only
  `rejectReason` is skipped-when-None. (This intentionally departs from the T-025
  ticket prose, which grouped delta + rejectReason under one skip rule.)

- **TOOLCHAIN_MISSING sentinel is reused.** Missing bun OR any stage failing with
  the spawn wrapper's `not found on PATH` signature returns
  `render_toolchain::TOOLCHAIN_MISSING` (the same string export_mp4 returns), so
  the frontend branches to the install affordance; a real stage non-zero exit
  returns a stage-named message instead. The IG stage SCRIPTS are not bundled into
  the render-toolchain yet, so in practice the runner falls back to the repo
  `scripts/ig-pipeline/` + a `bun` on PATH (dev only).

Date threading caveat: this backend does NOT pin a single date across the two
phases (no chrono dependency; download.ts's CLI has no --date hook and store
defaults to today). download (Phase A) and store (Phase B) each use "today", so a
Phase A / Phase B split across midnight can land store in a different-date folder
than download created -- store's reconcile self-heals the media but leaves the old
folder behind. See [[ig-pipeline-date-threading]].
