---
id: roto-video-duration-fps-never-probed
root: gotchas
type: gotcha
status: current
summary: "The roto store's LoadedVideo.durationSeconds and .fps are never populated -- there is NO video-probe command anywhere, and RotoAssetsPanel calls loadVideo({path}) with no metadata. So ComparisonPlayer's effectiveDuration is ~always 0, making its shared-timeline scrub degenerate in every path (play still animates via rAF; only the seek bar is dead)."
created: 2026-06-06
updated: 2026-06-06
---

`RotoAssetsPanel.pickVideo` calls `loadVideo({ path: selected })` with no
`durationSeconds`/`fps`, and there is no Tauri command anywhere that probes a
source video for the frontend (grep `probe`/`durationSeconds` across `src/` and
`src-tauri/` -- nothing populates them). So on the roto `video`:

- `durationSeconds` is `undefined` -> `RotoVideoPanel.duration` is null ->
  `effectiveDuration` is null -> `ComparisonPlayer` receives `0`.
- `fps` is `undefined` -> falls back to `ASSUMED_FPS = 30` everywhere.

Effect on `ComparisonPlayer`: the shared timeline's track/seek math divides by
`effectiveDuration`, so with 0 the playhead never moves, the readout shows
`00:00 / 00:00`, and click/drag-to-seek is stuck at 0. Play/pause still works
(the rAF loop reads `videoRef.current.currentTime` directly and derives the
sequence frame independent of `effectiveDuration`).

This is PRE-EXISTING and affects every comparison path equally -- the T-005
controls "Compare" button (load output sequence + archived `source_clip.mp4`)
inherits it, it does not introduce it. The proposal scoped section 5 to "nothing
changes in ComparisonPlayer," so the fix was deferred. Real fix needs either a
probe command feeding `durationSeconds` into the store, or teaching
`ComparisonPlayer` to read the source `<video>` element's own `duration` on
`loadedmetadata`. RotoControls/ReviewModal already degrade to "unprobed" for the
same reason.
