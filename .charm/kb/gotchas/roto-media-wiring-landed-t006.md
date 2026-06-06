---
id: roto-media-wiring-landed-t006
root: gotchas
type: gotcha
status: current
summary: "T-006 wired roto media: source videos enter via a file picker (no backend list; reuses rotoStore.loadVideo, NOT a new loadedVideoPath setter); list_rotoscope_outputs enumerates assets/rotoscope_*/ PNGs; output stop-motion playback fps is computed as 30/(frameSkip+1) because meta.json records frame_skip but NOT the source fps."
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

2. **Effective playback fps assumes a 30fps source.** `meta.json`
   (rotoscoping.rs::RotoMeta) records `frame_skip` but NOT the source video's fps.
   So stop-motion playback fps is derived as `30 / (frameSkip + 1)` (ASSUMED_FPS
   in RotoOutputsPanel, matching RotoVideoPanel's ASSUMED_FPS and the proposal's
   30fps estimate table). If a source was not 30fps the playback speed is
   approximate -- fixing it properly means recording source fps in meta.json on
   the microservice side. `frameSkip` is null when meta.json is absent/malformed;
   the panel falls back to the proposal default skip=3 (7.5fps).

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
