# Rotoscoping Bug Bash 2 — Proposal

Six improvements across memory, UX, and output management. Organized from
server-side (the memory fix, which is the hardest) to client-side features.

---

## 1. Server: cap RAM growth during propagation (batched chunking)

**Problem.** RAM grows monotonically as propagation processes more frames.
`offload_state_to_cpu=True` (already in `sam2_engine.py:204`) moved the
per-frame memory bank from VRAM to CPU RAM but did not cap its size -- the bank
is append-only as SAM2 walks forward through the clip, so it grows linearly with
clip length regardless of where it lives. A 60s source at 30fps produces ~1800
frames, and each frame's memory entry accumulates in the state dict for the
lifetime of the `propagate_in_video` call. That is the leak.

**Root cause in code.** `run_job` calls:

```python
state = predictor.init_state(str(frames_dir), ...)  # loads all frames
predictor.add_new_points_or_box(state, frame_idx=0, ...)
for frame_idx, _ids, mask_logits in predictor.propagate_in_video(state):
    ...  # state["output_dict"] grows a new entry per frame
```

`state["output_dict"]` (SAM2 internals) stores one mask-logit tensor per
visited frame on CPU. After frame 1800 it holds ~1800 tensors. Nothing shrinks
it mid-loop.

**Fix: batch/chunk propagation.**

Process the clip in segments of `CHUNK_SIZE` frames (proposed default: 150,
roughly a 5-second window at 30fps). Between chunks, call `predictor.reset_state`
to free the accumulated memory bank, then reinitialize `init_state` on only the
next chunk's frames. Thread the mask forward between chunks by saving the last
frame's mask logits and re-prompting the new state with
`add_new_mask` (or equivalent -- see below).

Concretely, in `sam2_engine.py`:

1. After `extract_frames`, calculate `num_chunks = ceil(total_frames / CHUNK_SIZE)`.
2. Maintain two counters outside the chunk loop: `global_frame_idx = 0` (tracks
   the source-relative frame number for output naming) and
   `global_frames_processed = 0` (tracks progress across all chunks).
3. For `chunk_idx` in `0..num_chunks`:
   - `chunk_start = chunk_idx * CHUNK_SIZE`
   - `chunk_end = min(chunk_start + CHUNK_SIZE, total_frames)`
   - Build a sub-directory containing only
     `frames_dir/{chunk_start:05d}.jpg` .. `frames_dir/{chunk_end-1:05d}.jpg`,
     re-named as `00000.jpg..` so SAM2's `init_state` sees a contiguous sequence.
   - Call `predictor.init_state` on the sub-dir.
   - For chunk 0: prompt with the original points via `add_new_points_or_box`.
   - For chunks 1+: prompt with the saved `carry_mask` from the previous chunk's
     last frame via `predictor.add_new_mask(state, frame_idx=0, obj_id=OBJ_ID, mask=carry_mask)`.
   - Run `propagate_in_video`. For each yielded `(chunk_local_idx, ...)`:
     - Compute `source_frame_idx = chunk_start + chunk_local_idx`.
     - If `source_frame_idx % (frame_skip + 1) == 0`, call
       `_save_transparent_png(source_frame_idx, mask_logits, frames_dir, output_dir)`
       so output filenames are globally unique (`frame_0001.png`, `frame_0005.png`, ...).
     - Increment `global_frames_processed`; update progress as
       `0.1 + 0.85 * (global_frames_processed / total_frames)`.
   - Save the last propagated mask as `carry_mask` (a CPU numpy bool array).
   - Call `predictor.reset_state(state)` + `torch.cuda.empty_cache()`.
   - Delete the chunk sub-dir (inside a `finally` block so it is cleaned up even
     on cancel or error).

This bounds peak RAM to ~one chunk's worth of SAM2 state instead of the full
clip's worth. RAM stays flat after the first chunk settles.

**Tradeoffs.**

- Chunk boundaries may produce a slight mask jitter at the seam because the
  new chunk's init_state re-reads that frame's pixels afresh and the memory bank
  is reset. In practice, re-prompting with the carry mask from the prior chunk's
  last frame gives SAM2 a strong initialization and the seam is typically
  invisible. Test with a moving subject across a chunk boundary to verify.
- Frame re-numbering for sub-dirs means some extra filesystem ops (creating
  a per-chunk temp dir and symlinking or copying the relevant JPEGs). On Linux
  symlinking is free; on Windows NTFS symlinks require elevated permissions so
  the fallback is a shallow copy. Detect at runtime and branch.
- The chunk sub-dir approach keeps `frames_dir` as the source of truth; only
  the chunk's sub-dir is created and deleted per iteration, so peak disk usage
  does not increase.

**`add_new_mask` availability note.** SAM2's Python API does expose
`add_new_mask` on the video predictor, but its exact signature differs between
SAM2 v1.0 and v1.1. Before using the keyword form, verify the installed
version's signature (the existing engine calls `add_new_points_or_box`
positionally, not as `inference_state=`). Use positional args as a safe default:

```python
predictor.add_new_mask(
    state,   # positional, not inference_state=
    0,       # frame_idx
    _OBJ_ID,
    carry_mask_bool_2d,  # np.ndarray(H, W, dtype=bool)
)
```

Wrap in a try/except `AttributeError` and fall back to `add_new_points_or_box`
with the original points if the method is absent. The fallback loses cross-chunk
continuity but degrades gracefully rather than erroring.

**Chunk cleanup on cancel.** The chunk sub-dir must be deleted in a `finally`
block, not just on normal completion. The existing `run_job` finally already
calls `reset_state` and `empty_cache`; add chunk sub-dir cleanup there so a
`RotoscopeCancelled` or OOM mid-chunk does not leave orphaned temp directories.

**Config.** Add `CHUNK_SIZE: int = 150` to `config.py` so it can be tuned
without touching the engine. Expose it via the `/health` response so the client
can display it (optional but useful for debugging).

**Files:** `microservices/rotoscoping/sam2_engine.py` (run_job),
`microservices/rotoscoping/config.py` (CHUNK_SIZE).

---

## 2. Client: show loaded video in Project Assets panel

**Problem.** Clicking "Load video..." loads the file into the left pane but the
Project Assets panel shows nothing -- it only calls `list_assets`, which returns
image assets from `assets/`. Source videos are referenced in-place and never
registered anywhere, so the panel is silent after a load.

**Root cause.** `RotoAssetsPanel` has no awareness of the rotoStore's `video`
field; it is a pure Tauri-query component that knows nothing about what is
loaded.

**Fix.** Subscribe to `rotoStore.video` inside `RotoAssetsPanel` and render the
loaded video as a pinned entry at the top of the panel, above the image grid:

```tsx
const video = useRotoStore((s) => s.video);
// Render a dedicated "Source video" row when a video is loaded, above the
// existing image grid. This is a local display only -- no backend call needed
// since the path is already in the store.
```

The row should show:
- A video-file icon (or a dark placeholder thumbnail -- no need to render a real
  frame just for the icon row).
- The filename (basename of `video.path`).
- The probed duration (`video.durationSeconds`) and resolution if available.
- A "Clear" button that calls `rotoStore.reset()` to unload it. Note:
  `loadVideo` is typed `(video: LoadedVideo) => void` -- passing `null` is a
  compile error. `reset()` is the correct call; it clears the video, points,
  start frame, and clip bounds together. If clearing only the video without
  wiping the point placement is ever needed, add a dedicated `clearVideo()`
  action to the store.

No backend change is needed; the path is already in the store. The panel header
label can read "Project Assets" unchanged -- the video entry just sits above the
image grid with a subtle type badge ("VIDEO") so the distinction is clear.

When a video is loaded but the image grid is empty, the "No image assets yet."
hint must be suppressed -- the video row alone satisfies the non-empty state. The
existing empty-state branch checks `assets.length === 0`; gate it on
`assets.length === 0 && !video` instead.

**File:** `src/components/RotoPanel/RotoAssetsPanel.tsx`.

---

## 3. Client + server: export rotoscoped output in additional formats

**Problem.** The outputs panel has "Open video" when a `.webm` is present, but
users may need the output as a GIF (for sharing), an MP4 with alpha (ProRes
4444), or a plain MOV. There is no format conversion option anywhere.

**Proposed UX.** Add an "Export as..." dropdown or secondary button to each row
in `RotoOutputsPanel`. Clicking it opens a small inline picker:

| Format | Notes |
| --- | --- |
| WebM (VP9, transparent) | default -- already composed at job end |
| GIF | palette-quantized via ffmpeg; 256-color; lossy for large outputs |
| MP4 (H.264) | no alpha; black or white matte fill for background |
| MOV (ProRes 4444) | lossless alpha; large files; best for compositing |

The user picks a format and a save location (native dialog), and the app runs
an ffmpeg pass from the existing `output.webm` (or the PNG sequence if the
webm is missing) into the chosen container.

**Implementation.**

Server side: no changes needed -- the PNG sequence and existing webm are the
source material for all conversions.

Backend: new Rust command `export_roto_output(dir, format, dest_path)` where
`format` is an enum `"gif" | "mp4" | "mov"`. It shells out to the bundled ffmpeg:

- GIF (two-pass palettegen; filter parameters must match across both passes):
  ```
  ffmpeg -i output.webm -vf "fps=N,scale=W:-1:flags=lanczos,palettegen" /tmp/palette.png
  ffmpeg -i output.webm -i /tmp/palette.png \
    -lavfi "fps=N,scale=W:-1:flags=lanczos [x]; [x][1:v] paletteuse" out.gif
  ```
  `N` is the effective fps from `meta.json`'s `frame_skip`
  (`source_fps / (frame_skip + 1)`). `W` is the output width from the WebM
  stream (probe with ffprobe). The palette temp file is written alongside the
  destination and deleted after the second pass regardless of success or failure.

- MP4: `ffmpeg -i output.webm -c:v libx264 -pix_fmt yuv420p out.mp4`
  (alpha discarded, composited against black)

- MOV: `ffmpeg -i output.webm -c:v prores_ks -profile:v 4 out.mov`
  (`-profile:v 4` is the integer for ProRes 4444; the string form `"4444"` is
  not reliably accepted across ffmpeg builds)

**PNG sequence fallback.** If `output.webm` is absent (older jobs that predate
the compose step), fall back to the PNG sequence as source:
`ffmpeg -framerate N -i frame_%04d.png ...`. The frame glob pattern
`frame_%04d.png` matches the 1-based naming written by `_save_transparent_png`.

Stream `export://progress` lines so the UI can show a spinner.

Frontend: the "Export as..." button in `RotoOutputsPanel` opens a format picker,
then calls `save_file_dialog` for the path, then invokes `export_roto_output`.
Show progress inline in the row (replacing the button with a "Exporting..." state),
then reset to the button on completion.

**Files:** `src/components/RotoPanel/RotoOutputsPanel.tsx`,
`src-tauri/src/commands/roto_media.rs`.

---

## 4. Client: side-by-side comparison of original and rotoscoped output

**Problem.** The source video and rotoscoped output are mutually exclusive states
in `RotoVideoPanel` -- `loadedSequence` replaces the video player entirely. Users
have no way to compare the cut-out against the original without closing one to
open the other.

**Proposed UX.** Add a comparison toggle in the outputs panel or the sequence
player toolbar. When active, split the Video pane vertically (default) or
horizontally (user-selectable -- see section 5) so the left half shows the
source `<video>` and the right half shows the PNG sequence, both locked to the
same playhead position.

The layout options (section 5) are: side-by-side (source left, roto right) or
stacked (source top, roto bottom). A small toggle button cycles between the two.

Comparison mode is available only when:
- A source video is loaded (`rotoStore.video != null`).
- A sequence is loaded (`rotoStore.loadedSequence != null`).

When the toggle is off, the sequence player occupies the full pane (current
behavior). When toggled on, both halves render simultaneously.

**Implementation.** The `SequencePlayer` component already tracks `frame` in
state and advances it on a `setInterval`. The source `<video>` exposes
`currentTime`. To sync them:

- Convert the sequence frame index to a source timestamp:
  `sourceTime = frame / loadedSequence.fps`.
  Each sequence frame represents exactly `1 / effectiveFps` seconds of real
  time (the sequence is a decimated view of the source, so this is exact, not
  approximate).
- When the user scrubs the source video (`onTimeUpdate`), compute the nearest
  sequence frame: `frame = round(currentTime * sourceFps / (frameSkip + 1))`.
  Update the displayed frame directly. This is one-way (source drives the
  sequence) since the video element's `currentTime` is the truth.

Comparison mode is available only when both `rotoStore.video != null` and
`rotoStore.loadedSequence != null`. The toggle button must be disabled (not
merely hidden) when either condition is unmet, to prevent rendering with
undefined sources.

State addition: `comparisonActive: boolean` in the Video panel's local state
(not the store -- it is ephemeral display preference, not a job parameter).

**File:** `src/components/RotoPanel/RotoVideoPanel.tsx` (SequencePlayer,
RotoVideoPanel).

---

## 5. Client: comparison layout toggle (side-by-side vs. stacked)

**Problem.** A fixed split direction for the comparison view (section 4) will
not fit all desktop layouts. A tall narrow window wants stacked; a wide window
wants side-by-side.

**Proposed UX.** A small two-icon toggle button in the comparison toolbar (when
`comparisonActive` is true) switches between:

- Side-by-side: source on the left, roto on the right, a vertical divider.
- Stacked: source on top, roto on bottom, a horizontal divider.

The divider is a fixed 50/50 split (no drag handle needed for the initial
version -- the user can resize the outer panels instead). The toggle persists
in `localStorage` under `claude-motion:rotoCompareLayout` so it survives
navigation and restarts.

**File:** `src/components/RotoPanel/RotoVideoPanel.tsx`.

---

## 6. Client: rename rotoscoped output

**Problem.** Output folders are named `rotoscope_<source_basename>` by the
backend. Users accumulate multiple outputs from the same source (different point
placements, different fps settings) and have no way to distinguish them beyond
the frame count. There is no rename UI anywhere.

**Proposed UX: hover edit button.** On hover over an output row in
`RotoOutputsPanel`, show a small pencil icon button to the left of the existing
action buttons. Clicking it swaps the `roto-outputs__name` span for an inline
`<input>` pre-filled with the current name. On Enter or blur, commit the rename;
on Escape, discard.

Right-click rename is also acceptable but is harder to discover and conflicts
with OS context menus on some platforms. The hover button is preferred.

**What "rename" means technically.** The output folder name is the directory
basename (e.g. `rotoscope_clip`); renaming it means moving the folder on disk.
`meta.json` inside the folder does not currently store the output name
separately, so no meta update is needed -- the name displayed is always derived
from the folder basename.

**Backend.** New Rust command `rename_rotoscope_output(old_dir, new_name) -> String`
(returns the new absolute dir path). It:
1. Validates `new_name`: non-empty, does not equal `.` or `..` as the full
   string, contains no `/`, `\`, or null bytes. Dots within the name (e.g.
   `v2.1`, `subject.run2`) are valid and must not be rejected.
2. Computes `new_dir = parent(old_dir) / new_name`.
3. Errors if `new_dir` already exists.
4. Calls `std::fs::rename(old_dir, new_dir)`.
5. Returns `new_dir` so the frontend can update its local state without a full
   re-enumerate.

**Frontend.** On successful rename:
- Update the matching entry in local `outputs` state (swap `dir` and `name`).
- Update the matching entry in `files` map (re-key from old dir to new dir).
- No full `refresh()` call needed -- the local patch is sufficient and avoids a
  flash.

**File:** `src/components/RotoPanel/RotoOutputsPanel.tsx`,
`src-tauri/src/commands/roto_media.rs`.

---

## 7. Client + server: synced media timeline (shared scrubber)

**Problem.** When comparison mode is active (section 4), there is no unified
timeline control. The source video has its own `<video controls>` native bar and
the sequence player advances on an interval timer. They drift the moment you
scrub one independently.

**Proposed UX.** Below the comparison split, add a shared timeline bar:

- A progress track spanning the full clip duration (source time, seconds).
- A single draggable playhead that scrubs both halves simultaneously.
- Play / Pause button that controls both (pauses the interval + video.pause()).
- A time readout: `current / total` (formatted as `MM:SS`).
- Frame counter for the sequence side: `frame N / total`.

The original video's native controls (`controls` attribute) are replaced by this
shared bar to avoid two competing scrubbers. In non-comparison mode (sequence
player only, or source video only) the existing individual controls are
preserved; the shared bar is comparison-mode-exclusive.

Sync logic:
- **Playing:** source video drives time. `requestAnimationFrame` is the sole
  clock -- there is no `setInterval` running alongside it. On each rAF tick,
  read `video.currentTime`, derive the sequence frame as
  `round(currentTime * sourceFps / (frameSkip + 1))`, update the displayed
  frame, and schedule the next tick. When paused, cancel the rAF handle.
- **Scrubbing / seek:** when the user drags the shared playhead, pause both
  (cancel the rAF loop + `video.pause()`), set `video.currentTime = seekTime`,
  derive and set the sequence frame, then resume both if they were playing.
- **Frame cadence mismatch:** the sequence fps is lower than the source fps, so
  the sequence frame will hold for multiple source ticks. This is expected and
  correct -- it reflects the actual frame-skip. The sequence side looks like a
  stop-motion overlay of the smooth source video.

State: `sharedTime`, `playing`, `scrubbing` as local state in a new
`ComparisonPlayer` sub-component that wraps both halves. The rotoStore is not
involved -- this is display-layer state only.

**Duration prop.** `ComparisonPlayer` receives `effectiveDuration` as a prop
rather than reading the store directly. When a clip range was set before the
job ran (T-015), the effective duration is `clipEnd - clipStart`, not the full
source video length. The parent (`RotoVideoPanel`) already computes
`effectiveDuration` from the store and must pass it down.

**File:** `src/components/RotoPanel/RotoVideoPanel.tsx` (new `ComparisonPlayer`
component, or extracted `src/components/RotoPanel/ComparisonPlayer.tsx`).

---

## Implementation order

Dependencies shape the order:

1. **Section 1** (server-side batched chunking) -- pure server change
   (`sam2_engine.py`, `config.py`), no client deps. Do first; it unblocks
   testing longer outputs without the RAM wall.

2. **Section 2** (video in assets panel) -- isolated client change, no backend
   needed. Low complexity; do alongside section 1.

3. **Section 6** (rename) -- isolated backend + frontend change, no deps. Can
   land in parallel with sections 1-2.

4. **Section 3** (export formats) -- needs a new backend command. Do after the
   simpler items are confirmed working.

5. **Sections 4 + 5** (comparison + layout toggle) -- do together; section 5's
   toggle is meaningless without section 4's split view. These are the most
   involved client changes.

6. **Section 7** (shared scrubber) -- depends on sections 4 + 5 being stable
   (needs the comparison split to exist before it makes sense). Do last.
