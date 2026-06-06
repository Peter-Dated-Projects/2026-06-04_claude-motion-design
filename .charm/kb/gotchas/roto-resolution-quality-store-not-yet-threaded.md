---
id: roto-resolution-quality-store-not-yet-threaded
root: gotchas
type: gotcha
status: current
summary: "T-013 added rotoStore.resolution/quality as the single source of truth and an Output-FPS input (derived view over the canonical int frameSkip), but the submit path is NOT fully wired: resolution never reaches the server, and CompressionModal bridges quality->legacy (compress, quality%) via qualityToSubmitParams; ffmpeg_helper.extract_frames takes a scale param that nothing passes yet."
created: 2026-06-06
updated: 2026-06-06
---

After T-013 the rotoscoping setup controls (`RotoControls.tsx`) own three settings
backed by `rotoStore`: `frameSkip` (unchanged, canonical int), `resolution`
(`{preset, width, height, maintainAspect}`), and `quality`
(`"original"|"high"|"fast"|"low"`). Two things are deliberately half-wired and a
future ticket must finish them:

- **Output FPS is a derived view, not stored.** The "Output FPS" text input maps
  to/from the integer `frameSkip` using the probed source fps:
  `frameSkip = max(0, round(sourceFps / targetFps) - 1)`. There is no `fps` field
  in the store -- `frameSkip` stays canonical. The input is disabled until the
  video is probed (`video.fps` set) because the mapping needs the source rate.

- **Resolution never reaches the server.** `rotoStore.resolution` exists and the
  UI sets it, but `RotoVideoPanel.runJob` (out of T-013's scope -- owned by T-014)
  does not pass it to `rotoscope_video`, and `ffmpeg_helper.extract_frames` gained
  an optional `scale: tuple[int,int] | None` param (emits `-vf scale=W:H`) that
  **nothing calls with a value** -- `main.py` run_job still calls it with no scale.
  Threading resolution end-to-end (client invoke arg -> rotoscoping.rs ->
  microservice run_job -> extract_frames scale) is follow-up work; there's a
  `# VERIFY`/TODO in ffmpeg_helper marking the join point.

- **Quality is bridged, not native.** The backend submit path still speaks the old
  `(compress: bool, quality: number 1-100)` pair. `CompressionModal.tsx` exports
  `qualityToSubmitParams(preset)` which maps the preset to that pair
  (`original` -> `compress:false`; high/fast/low -> compress + 90/70/50). When the
  submit contract is rewritten to carry the preset/CRF directly, drop this bridge.

Also: `LoadedVideo` (src/types/roto.ts) carries only `path/durationSeconds/fps` --
**no width/height**, so the Custom-resolution "Maintain aspect ratio" toggle locks
to the *entered* W:H ratio, not the true source aspect. Real source-aspect would
need probe dims added to the Tauri bridge (`rotoscoping.rs`).
