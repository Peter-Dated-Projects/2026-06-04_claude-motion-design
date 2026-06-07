---
id: roto-meta-json-written-clientside-not-microservice
root: gotchas
type: gotcha
status: current
summary: "A rotoscope output's meta.json is written entirely by the Tauri client (rotoscoping.rs::RotoMeta), NOT by the Python microservice -- the service only zips frame_*.png + output.webm + source_clip.mp4. Any new meta enrichment (e.g. source_fps) must be written client-side; roto_media.rs reads it."
created: 2026-06-06
updated: 2026-06-06
---

The microservice (`microservices/rotoscoping/`) never writes `meta.json`. Its
`_zip_output` bundles only `frame_*.png`, `output.webm`, and `source_clip.mp4`.
The client bridge `src-tauri/src/commands/rotoscoping.rs` extracts those and then
writes `meta.json` itself from `RotoMeta` (source path, frame_skip, points, model,
generated_at, frame_count). `src-tauri/src/commands/roto_media.rs::read_meta`
reads that file back (`RotoMetaRead`).

Consequence for the controls bug-bash (section 4, "source fps in meta.json"): the
proposal said to write `source_fps` from the Python `_finalize`/`sam2_engine`.
That is impossible -- the Python side does not own the file, and changing
`extract_frames`/`run_job` return signatures breaks their `main.py` callers. The
write must happen in `rotoscoping.rs::RotoMeta` (which is in the T-007 backend
ticket's touches, not the controls ticket's), and the client must first obtain the
source fps (the service probes it via `ffmpeg_helper.probe_video` but does not
currently return it to the client).

In T-005 only the READ/CONSUME side was wired: `roto_media.rs` deserializes an
optional `source_fps`, and the frontend `effectiveFps(frameSkip, sourceFps)` uses
it. It stays null (-> 30fps fallback) until the client meta.json writer records it.

See also [[roto-client-async-job-flow]].
