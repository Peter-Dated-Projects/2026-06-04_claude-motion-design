---
id: roto-media-wiring-landed-t006
root: gotchas
type: gotcha
status: current
summary: "T-006 wired roto media: source videos enter via a file picker (no backend list; reuses rotoStore.loadVideo, NOT a new loadedVideoPath setter); list_rotoscope_outputs enumerates assets/rotoscope_*/ PNGs; output stop-motion playback fps was 30/(frameSkip+1) because meta.json lacked source fps -- AS OF T-009 meta.json now records source_fps (threaded over the SSE snapshot), so the 30fps fallback only applies to old/missing meta."
created: 2026-06-06
updated: 2026-06-06
related:
  - roto-panels-media-wiring-deferred-t006
  - roto-output-under-assets-not-in-scope
---

T-006 closed the three deferred media gaps. Non-obvious calls a future agent
needs:

1. **Source video enters via a FILE PICKER, not a backend list.** Videos are
   referenced in place / never copied (proposal), so there is no project-video
   registry to enumerate. RotoAssetsPanel's "Load video..." button uses
   plugin-dialog `open` (video extension filters) and feeds the chosen absolute
   path straight to the store. It REUSES the existing `rotoStore.loadVideo({path})`
   -- the ticket text asked for a new `loadedVideoPath` setter, but that would
   duplicate `video.path` (two sources of truth for "the loaded video"), so it
   was intentionally not added. RotoVideoPanel already reads `video` +
   `convertFileSrc(video.path)`.

2. **Effective playback fps now uses the real source fps (T-009).** Originally
   `meta.json` recorded `frame_skip` but NOT the source fps, so playback was
   derived as `30 / (frameSkip + 1)` (ASSUMED_FPS). T-009 completed the writer:
   the microservice probes source fps in `POST /rotoscope` and stamps it on the
   `Job` so it rides EVERY SSE snapshot (`source_fps` key, set once at POST time,
   before the job launches). The Rust client captures the last-seen value in
   `run_progress_stream` (now returns a `StreamOutcome { stage, source_fps }`,
   not a bare stage String) and writes it into `meta.json` via
   `RotoMeta.source_fps`. The read-side (`roto_media.rs` `RotoMetaRead.source_fps`,
   `RotoOutputsPanel.effectiveFps`) then plays back at the real rate. The
   `30 / (frameSkip + 1)` fallback now applies ONLY to old outputs or
   absent/malformed meta. NON-OBVIOUS: source_fps travels over the SSE progress
   stream, NOT in the result ZIP or a separate fetch -- don't add an endpoint for
   it. `frameSkip` is still null when meta.json is absent/malformed; the panel
   falls back to the proposal default skip=3 (7.5fps).

3. **loadedSequence vs video are mutually exclusive in the UI.** rotoStore gained
   `loadedSequence` (ordered convertFileSrc PNG urls + fps) with
   `loadSequence`/`clearSequence`. When set, RotoVideoPanel's SequencePlayer
   branch takes priority over the empty/processing/setup source-video flow;
   `loadVideo` clears `loadedSequence`, and Close (`clearSequence`) returns to the
   source-video state underneath. The PNG sequence is played as an `<img>` cycled
   on a `setInterval`, NOT through `<video>` (which cannot play a PNG sequence);
   all urls are mounted hidden once so the browser caches them and the loop does
   not flicker after the first pass.

Backend: `list_rotoscope_outputs(app, slug)` in commands/roto_media.rs enumerates
`<project>/assets/rotoscope_*/`, sorts `frame_*.png` lexically (zero-padded ==
numeric order), takes the on-disk PNG count as authoritative (not meta's
recorded count), and reads meta.json best-effort (missing/malformed -> still
lists the folder). It duplicates the `project_dir` helper like every other
command module (see [[projects-root-resolved-in-four-places]] -- now SIX places).
RotoOutputsPanel re-fetches on slug change AND when `rotoStore.outputs.length`
changes, so a just-finished `jobComplete` refreshes the list with real
thumbnails.
