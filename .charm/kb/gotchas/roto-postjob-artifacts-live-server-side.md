---
id: roto-postjob-artifacts-live-server-side
root: gotchas
type: gotcha
status: current
summary: "T-016's composed output.webm + source_clip.mp4 are written into the microservice's server-side work_dir and reaped after /result serves the PNG zip; the client bridge (rotoscoping.rs) only extracts the PNGs into assets/rotoscope_*/, so get_rotoscope_output_files returns null for video/sourceClip until that bridge is taught to pull them across. Also: compose_video uses the concat demuxer (not -pattern_type glob) for Windows portability, and VP9 alpha shows as pix_fmt=yuv420p + TAG:alpha_mode=1 (alpha is a side layer), not yuva420p."
created: 2026-06-06
updated: 2026-06-06
---

T-016 added post-job artifacts to the rotoscoping microservice: after `_zip_output`,
`_finalize` now composes the PNG sequence into a transparent `work_dir/output.webm`
and copies the uploaded clip to `output_dir/source_clip.mp4` (both best-effort, wrapped
so a failure never flips the job to error -- the PNG zip stays the primary artifact).

The CROSS-STAGE GAP: both new files live in the microservice's **server-side**
`config.WORK_DIR/<job_id>/` tree, which `/result`'s `BackgroundTask(_cleanup)` rmtrees
the moment it finishes streaming the zip. The client bridge (`commands/rotoscoping.rs`,
which fetches `/result` and unpacks the zip) currently extracts **only the PNGs** into
`<project>/assets/rotoscope_*/`. So the read-side command `get_rotoscope_output_files(dir)`
(roto_media.rs) returns `video: null` / `sourceClip: null` for those folders, and the
RotoOutputsPanel "Open video" button never shows -- until rotoscoping.rs is taught to
also pull `output.webm` / `source_clip.mp4` across before the work_dir is reaped (out of
T-016's scope). The command + button are the contract that wiring will satisfy; they are
correct as-is, just waiting on the bridge. (The `result.zip` similarly is never copied
into assets/, so `zip` is also null there today -- only the unpacked PNGs land.)

Two ffmpeg facts worth keeping (verified on the Mac dev box, ffmpeg 7 / libvpx-vp9):

1. **Use the concat demuxer, NOT `-pattern_type glob`.** The output PNGs are decimated
   by frame_skip, so their indices are GAPPED (`frame_0001.png`, `frame_0005.png`, ...
   for skip=3 -- naming is `frame_{frame_idx+1:04d}.png`, see
   [[roto-frameskip-is-output-only-not-propagation]]); no sequential `frame_%04d.png`
   pattern fits. glob would work but is omitted from many Windows static ffmpeg builds,
   and this service only runs on Windows/CUDA in production. `compose_video` instead
   writes a temp concat list (`file '<abs path>'` + `duration 1/fps` per frame, last
   frame repeated for the documented concat last-duration quirk) and feeds it with
   `-f concat -safe 0`. NOTE: the concat demuxer resolves relative `file` paths against
   the LIST FILE's directory, not cwd -- prod paths are absolute (under WORK_DIR) so it's
   fine, but a relative frames_dir in a test will double the path and fail.

2. **VP9 alpha probes as `pix_fmt=yuv420p` with `TAG:alpha_mode=1`, not `yuva420p`.**
   Encode flags that matter: `-pix_fmt yuva420p -auto-alt-ref 0` (alt-ref frames drop
   the alpha plane otherwise). ffprobe reports the primary plane as yuv420p because VP9
   stores alpha as a separate coded layer flagged by the `alpha_mode=1` stream tag;
   decoding a frame back yields an RGBA (color_type 6) PNG. WebM/VP9 was chosen over
   ProRes 4444 MOV specifically because WebM alpha video plays inside the Chromium
   webview (the app's preview surface) and ProRes would not.

The effective output fps passed to compose_video is `source_fps / (frame_skip + 1)`;
`source_fps` comes from the `probe_video` call the POST already makes (it used to discard
it as `_fps`) and is threaded through `_finalize`. The microservice receives NO explicit
clip-range flag -- the uploaded `video` is always the frame-accurately clipped source the
client submitted (rotoscoping.rs always runs `clip_video`; T-015 adds a pre-trim on top),
so archiving it as source_clip.mp4 is unconditional and real, not a placeholder.
