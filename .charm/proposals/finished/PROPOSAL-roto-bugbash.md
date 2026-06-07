# Rotoscoping Bug Bash + Feature Proposal

Covers all items from the June 6 bug bash notes. Organized by layer: server fixes
first (they unblock everything else), then client UX, then the pre-submit review
overhaul, then post-job output.

---

## 1. Server: memory logging + leak fix

**Problem.** Memory climbs fast during frame extraction. No per-step visibility
into what is consuming it or when it peaks.

**Root cause (suspected).** `ffmpeg_helper.extract_frames` writes every frame of
the full source video as full-resolution JPEGs to the work_dir before SAM2 ever
starts. For a 30fps, 30s clip that is ~900 JPEG files all held on disk simultaneously;
SAM2's `init_state` then loads them all into a frame cache in VRAM. The combination
means peak memory = all frames on disk + all frames in VRAM at once, rather than
streamed frame-by-frame.

**Fixes.**

- Add `tracemalloc` + `torch.cuda.memory_allocated()` / `torch.cuda.memory_reserved()`
  snapshots at each stage boundary in `_run_job_blocking` and `run_job` (after
  `extract_frames`, after `init_state`, after `add_new_points_or_box`, every N
  propagation frames, after `reset_state`). Log these at INFO level via the existing
  `logger` so they appear in the service output without a separate log config.

- After propagation finishes, delete the `frames_dir` JPEGs immediately (before
  zipping output) rather than at the `_cleanup` call after the client downloads
  the result. The frames are no longer needed once propagation is done; holding them
  doubles scratch usage during the zip step.

- Optionally: pipe ffmpeg with `-vf scale` at extraction time to cap JPEG width at
  the user's chosen output resolution (see section 6). This is the single highest-
  leverage memory reduction: extracting at 720p instead of 4K cuts per-frame size
  by ~6x before SAM2 ever touches the data.

- Pass three additional flags to `predictor.init_state` to move the bulk of VRAM
  usage to CPU RAM:

  ```python
  state = predictor.init_state(
      str(frames_dir),
      offload_video_to_cpu=True,   # raw frame tensors stay in CPU RAM, not VRAM
      offload_state_to_cpu=True,   # per-frame memory bank stays in CPU RAM
      async_loading_frames=True,   # background thread loads next batch while GPU runs
  )
  ```

  `offload_state_to_cpu=True` is the most impactful: SAM2 accumulates a per-frame
  memory bank as it propagates that grows linearly with clip length and lives in VRAM
  by default. Offloading it to CPU RAM is what makes 60s clips viable on a 16GB card.
  `offload_video_to_cpu=True` moves raw frame pixel tensors off VRAM as well.
  `async_loading_frames=True` is essentially free -- it overlaps disk I/O with GPU
  compute so propagation does not stall waiting on the next frame. The tradeoff is
  slightly slower propagation due to PCIe round-trips; acceptable given the VRAM
  savings. These are SAM2 v1.0 API flags -- no SAM2 source changes required.

**File:** `microservices/rotoscoping/ffmpeg_helper.py` (extract_frames),
`microservices/rotoscoping/main.py` (_run_job_blocking),
`microservices/rotoscoping/sam2_engine.py` (run_job, init_state call).

---

## 2. Server: instant cancel when request is cancelled

**Problem.** The cancel flag is checked once per propagation frame, so on a large
clip the job can run for several seconds after `DELETE /rotoscope/{job_id}` before
noticing.

**Fix.** The client's HTTP request cancel (Tauri abort) does not automatically
reach the Python worker -- the cancel endpoint already sets `job.cancelled = True`
correctly. The gap is that SAM2's `propagate_in_video` holds the GIL inside its
C++ extension for stretches longer than one frame. Two options, in order of
invasiveness:

- Option A (safe): add `if job.cancelled: raise RotoscopeCancelled(...)` at the
  top of each iteration in `run_job` (already done) AND after `init_state` and
  `add_new_points_or_box` (currently missing). This is not instant but cuts the
  worst-case lag to one frame's processing time.

- Option B (robust): wrap each propagation iteration in a `concurrent.futures`
  future with a short timeout; on cancel, set the flag and let the future return
  early. More complex but gives sub-second response.

Recommend Option A for now as it is low-risk and the per-frame latency is
typically <100ms.

**File:** `microservices/rotoscoping/sam2_engine.py` (run_job).

---

## 3. Client: fix stage label mapping

**Three distinct issues.**

### 3a. "Extracting Frames" stage missing

When the server is in `extracting` stage (set at `job.update(stage="extracting")`
in `_run_job_blocking`), `ProcessingView`'s `stageLabel` falls through to the
default verbatim case (`Extracting...`), which is fine -- but the client stays on
`"Loading model..."` if the last emitted SSE tick still shows `loading`. The real
issue is that the server does not emit a tick during `extracting`; `_run_job_blocking`
calls `job.update(stage="extracting", progress=0.02)` but the SSE stream only polls
at 250ms intervals, so a fast extraction may never emit that tick to the client.

Fix: make `ProcessingView.stageLabel` map `"extracting"` explicitly:
```
case "extracting": return "Extracting Frames...";
```

### 3b. No UI update when model is loading

`sam2_engine.run_job` sets `stage="loading"` immediately before `init_state`, but
if the model is already loaded (it is -- `load_predictor` runs at startup) this
tick is still emitted. The problem is the SSE poll deduplicate-on-equal-payload
check in `main.py:progress`: the `loading` tick emitted at the start of every job
has identical payload to the one emitted if the previous job just finished in
`loading`. This means no new event fires.

Fix: include the `job_id` in every SSE payload so consecutive-equal deduplication
never suppresses a real new-job tick. Also add the explicit label in `stageLabel`:
```
case "loading": return "Loading Model...";
```

### 3c. "Segmenting" -> "Rotoscoping"

`stageLabel` in `ProcessingView.tsx:76` returns `"Segmenting ..."` for the
`segmenting` stage. Change to `"Rotoscoping"`:
```
case "segmenting":
  if (progress?.framesTotal != null) {
    return `Rotoscoping (${progress.framesDone ?? 0} / ${progress.framesTotal} frames)...`;
  }
  return "Rotoscoping...";
```

**Files:** `src/components/RotoPanel/ProcessingView.tsx`,
`microservices/rotoscoping/main.py` (SSE payload).

---

## 4. Client: video clip selection before upload

**Problem.** The entire source video is sent to the service. Users should be able
to trim a start/end time range so only the relevant clip is uploaded.

**Proposed UX.** In `RotoVideoPanel`, add a clip-range UI below the video
scrubber: two time inputs (start / end), editable as `MM:SS.f` or seconds, with
"Set Start" and "Set End" buttons that stamp the current scrub position. The range
is previewed on the scrub track as a highlighted region.

When the user submits, the Tauri backend (or a local ffmpeg call via the existing
`ffmpeg_helper`-equivalent in the Rust commands layer) trims the video to the
selected range before upload. This replaces the current behavior of sending the
full file.

**60s cap enforcement.** The service already rejects clips longer than 60 seconds
(`MAX_VIDEO_SECONDS = 60` in `config.py`). The clip-selection UI must enforce this
client-side too: if `clipEnd - clipStart > 60` (or if no clip range is set and the
full video duration exceeds 60s), show an inline warning and disable the Generate
button. The trim control is the right place for this -- it prevents a useless
upload that the server will reject anyway.

**Store change.** Add `clipStart: number | null` and `clipEnd: number | null` to
`rotoStore`. Reset them on `loadVideo` / `reset`.

**Backend.** New Rust command `trim_video(path, start_secs, end_secs) -> tmp_path`
that shells out to the bundled ffmpeg with `-ss` / `-to` and returns the trimmed
file path. The rotoscope submit flow uses the trimmed path if clip bounds are set,
the original path otherwise.

**Files:** `src/components/RotoPanel/RotoVideoPanel.tsx`,
`src/store/rotoStore.ts`, `src-tauri/src/commands/roto_media.rs`.

---

## 5. Client: replace frame-skip buttons with FPS text input

**Problem.** The current frame-skip button row (`0`..`10`) is opaque -- users have
to mentally convert skip count to effective fps. They should be able to just type
a target output fps.

**Proposed UX.** Replace `RotoControls`' skip button row with a single text input
labeled "Output FPS". Accepts positive floats only (validate: `> 0`, reject
negative or zero). The store still tracks `frameSkip` as an integer (it is what
the server accepts), but the displayed value and user input is in fps terms.

Conversion:
```
frameSkip = Math.max(0, Math.round(sourceFps / targetFps) - 1)
```

When source fps is unknown (video not yet probed), disable the input with a
placeholder of `"Load video first"`.

Show the estimated output frame count below the input as before.

**Files:** `src/components/RotoPanel/RotoControls.tsx`, `src/store/rotoStore.ts`.

---

## 6. Client: resolution + quality configuration

Replace the compression modal entirely. These settings move into the main controls
area (or a dedicated Settings section of `RotoControls`) so the user configures
them before hitting Generate, not in a post-click modal.

### 6a. Output resolution

A segmented control with presets:

| Label | Value |
| --- | --- |
| 360p | 640x360 |
| 720p | 1280x720 |
| 1080p | 1920x1080 |
| Custom | user-typed width + height |

For "Custom", show two number inputs (width, height) and an "Maintain aspect ratio"
toggle. When the toggle is on, changing one dimension auto-fills the other from the
source video's aspect ratio.

This resolution is passed to `ffmpeg_helper.extract_frames` as a `-vf scale=W:H`
filter, reducing VRAM load proportionally (see section 1).

### 6b. Quality / compression presets

Replace the raw percentage slider with four named presets:

| Preset | Compression | CRF equivalent (H.264) |
| --- | --- | --- |
| Original | 0% | no re-encode (copy source) |
| High | 10% | CRF ~18 |
| Fast | 20% | CRF ~23 |
| Low | 40% | CRF ~28 |

"Original" skips the pre-upload ffmpeg re-encode entirely. Any other preset
triggers a lossy re-encode of the (possibly trimmed) clip before upload. This makes
the "Compress with ffmpeg before upload" checkbox redundant -- remove it.

**Store change.** Add `resolution: { preset: "360p"|"720p"|"1080p"|"custom", width: number, height: number, maintainAspect: boolean }` and `quality: "original"|"high"|"fast"|"low"` to `rotoStore`.

**Files:** `src/components/RotoPanel/RotoControls.tsx`,
`src/components/RotoPanel/CompressionModal.tsx` (delete or repurpose as ReviewModal),
`src/store/rotoStore.ts`,
`microservices/rotoscoping/ffmpeg_helper.py` (add scale param to extract_frames).

---

## 7. Pre-submit review page

**Problem.** Clicking "Generate Rotoscope" currently opens `CompressionModal` which
conflates a settings choice with a confirmation step. The new flow should show a
read-only summary of all configured settings before the job starts.

**Proposed UX.** Replace `CompressionModal` with a `ReviewModal` that shows:

- Clip range (if set): `00:04.2 - 00:18.6 (14.4s)`
- Output FPS: `15 fps (every 2nd frame)`
- Output resolution: `720p (1280x720)`
- Quality: `Fast (20% compression)`
- Estimated output frames: `216`
- Point count: `3 foreground, 1 background`

Two actions: "Edit" (dismiss back to setup) and "Start Rotoscoping" (submit the job).

The "Compress with ffmpeg before upload" checkbox is removed entirely; compression
now happens automatically whenever quality != "Original".

**Files:** `src/components/RotoPanel/CompressionModal.tsx` -> rename to
`ReviewModal.tsx`, `src/components/RotoPanel/RotoVideoPanel.tsx` (wiring).

---

## 8. Post-job: extract clip as a video file

**Problem.** After rotoscoping completes, the output is a PNG sequence. There is
no video artifact -- users have to reconstruct it themselves. The source clip is
also not archived separately; only the original full video is referenced.

**Proposed behavior.** After `_finalize` zips the PNG frames, run a second ffmpeg
pass to compose the PNG sequence back into a video (transparent WebM or MP4 with
alpha via libvpx-vp9 / ProRes 4444) and save it alongside the ZIP in the job's
output directory. The ZIP still contains the individual PNGs. Both artifacts are
linked from the `RotoOutputsPanel` entry.

Additionally, if a clip range was set (section 4), save the trimmed source clip
as a `source_clip.mp4` in the same output directory so the user has the segment
that was actually processed, not just the frames.

This requires:
- `ffmpeg_helper.compose_video(frames_dir, output_path, fps)` -- new function.
- `_finalize` to call it after `_zip_output`.
- `RotoOutputsPanel` to show a "Open video" button alongside "Open folder" when
  the composed file is present.
- A new Tauri command `get_rotoscope_output_files(dir)` that returns which
  artifacts are present (zip, video, source clip) so the panel knows what to show.

**Files:** `microservices/rotoscoping/ffmpeg_helper.py`,
`microservices/rotoscoping/main.py` (_finalize),
`src/components/RotoPanel/RotoOutputsPanel.tsx`,
`src-tauri/src/commands/roto_media.rs`.

---

## Implementation order

These are mostly independent but have one dependency chain:

1. **Section 1 + 2** (memory logging + cancel) -- pure server fixes, no client
   changes. Low risk, high diagnostic value. Do first. The three `init_state`
   offload flags in section 1 are a one-diff change inside `run_job` and should
   land in this pass.

2. **Section 3** (stage label fixes) -- pure client string changes. Trivial.

3. **Sections 5 + 6** (FPS input + resolution/quality controls) -- these must land
   together because the review page (section 7) depends on them being committed UX.
   Also drives the server-side scale param (section 1 memory fix).

4. **Section 7** (review modal) -- depends on 5 + 6 having stable store fields.

5. **Section 4** (clip selection) -- can be done in parallel with 5/6 but the
   review page should include it.

6. **Section 8** (post-job video export) -- isolated server + client feature, can
   land anytime after section 1.
