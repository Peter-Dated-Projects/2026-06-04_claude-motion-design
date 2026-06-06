# Proposal: Rotoscoping Microservice

## Overview

An optional Windows-based microservice that runs SAM2 on a local GPU to
rotoscope user-provided video — extracting a subject frame-by-frame as a
transparent PNG sequence. The Tauri app detects the service at startup; if it's
not running, the rotoscoping workspace is hidden and the rest of the app works
normally.

## Hardware

- OS: Windows 11
- GPU: RTX 5060 Ti, 16GB VRAM, Blackwell (sm_120)
- SAM2 model: Large (224M params, fits in 16GB)
- CUDA: 12.8 required for sm_120 support
- PyTorch: 2.7+ installed via cu128 wheel (not default pip)

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
```

## Repository Location

```
microservices/
  rotoscoping/
    main.py
    pyproject.toml
    .python-version    <- 3.11
    README.md
    logs/              <- text log files only, no database
```

Python 3.11 — stable, fully supported by PyTorch 2.7 + CUDA 12.8.
Use `uv` for all package management and running.

## API Surface

Two endpoints only.

### GET /health

Returns service status and loaded model info. This is what the Tauri app polls
at startup to decide whether to show the rotoscoping workspace.

```json
{
  "status": "ok",
  "model": "sam2_hiera_large",
  "vram_used_gb": 14.2,
  "vram_total_gb": 16.0
}
```

If the service is not reachable, the app treats that as unavailable — no error
shown to the user, the workspace just does not appear.

### POST /rotoscope

Accepts a multipart upload: the clipped video file + parameters. The client
clips the video to the user's chosen start frame before sending — the microservice
always treats frame 0 of the received video as the reference frame for point
placement. Streams SSE progress during processing. Returns a ZIP of PNG frames
on completion.

```
Content-Type: multipart/form-data

Fields:
  video:        <binary video file, pre-clipped to start frame>
  points:       JSON array of {x, y, label} — label 1=foreground, 0=background
  frame_skip:   int, default 3 (process every Nth frame: skip=3 = every 4th)
```

Response on completion: `application/zip` containing `frame_0001.png`, `frame_0004.png`, ...

### DELETE /rotoscope/{job_id}

Cancels an in-progress job. The microservice stops propagation, resets SAM2
state, cleans up temp files, and returns 200. Partial PNG output is discarded.
The Tauri app calls this when the user clicks Cancel.

### GET /rotoscope/{job_id}/progress

SSE stream for live progress updates:
```
data: {"stage": "loading", "progress": 0.05}
data: {"stage": "segmenting", "progress": 0.42, "frames_done": 18, "frames_total": 45}
data: {"stage": "done", "progress": 1.0}
```

The Tauri app listens to this and drives the UI progress bar.

## Output Format: PNG

PNG only — not JPEG. Rotoscoped frames have transparent backgrounds (alpha
channel), which JPEG does not support. PNG with alpha is the standard for
compositing and what Remotion expects for sprite assets.

## Frame Rate / Skip

The user controls how many frames to skip between each processed frame.
Estimates below assume a 30fps source video.

| Skip | Process every | Effective fps | 10s clip | 30s clip | 60s clip |
|------|--------------|---------------|----------|----------|----------|
| 0    | every frame  | 30 fps        | 300      | 900      | 1800     |
| 1    | 2nd frame    | 15 fps        | 150      | 450      | 900      |
| 2    | 3rd frame    | 10 fps        | 100      | 300      | 600      |
| 3*   | 4th frame    | 7.5 fps       | 75       | 225      | 450      |
| 4    | 5th frame    | 6 fps         | 60       | 180      | 360      |
| 5    | 6th frame    | 5 fps         | 50       | 150      | 300      |
| 7    | 8th frame    | ~3.75 fps     | 37       | 112      | 225      |
| 10   | 11th frame   | ~2.7 fps      | 27       | 82       | 163      |

(* = default)

The UI shows a live frame estimate next to the skip selector, computed
programmatically from the video metadata (no LLM involved):

```ts
// from ffprobe output
const outputFrames = Math.ceil((duration * fps) / (frameSkip + 1))
```

ffprobe is called once when the video loads, duration and fps are cached, and the
estimate updates instantly as the user adjusts the skip slider.

Cap at skip=10 — beyond this the stop-motion playback becomes too choppy to read.

## Video Compression (Optional, User-Controlled)

Sending video from the Mac/PC app to the Windows microservice over LAN can be
large. The user can optionally compress before sending.

**UI flow:** modal appears after clicking "Rotoscope":

> "Compress video before sending? Smaller file = faster transfer."
> [Toggle: off by default] [Quality: 80%] [Accept]

- Default: compression OFF
- If on: ffmpeg compresses locally before upload
- Quality default: 80% (CRF 23)
- **Global setting** — saved across all projects, not per-project

```bash
ffmpeg -i input.mp4 -vcodec libx264 -crf 23 -preset fast compressed.mp4
```

## SAM2 Multi-Point Prompting

SAM2VideoPredictor supports multiple point prompts. The user is not limited to
one click — they can place multiple foreground points and background exclusion
points to define the subject precisely.

```python
predictor.add_new_points_or_box(
    state,
    frame_idx=0,
    points=[[x1, y1], [x2, y2], [x3, y3]],
    labels=[1, 1, 0]  # 1=foreground, 0=background
)
```

All placed points are collected in the UI before submission and sent as a JSON
array in the multipart request.

## SAM2 Implementation

```python
import torch
from sam2.build_sam import build_sam2_video_predictor

predictor = build_sam2_video_predictor(
    "sam2_hiera_large.yaml",
    checkpoint_path,
    device="cuda"
)

with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
    state = predictor.init_state(video_path)

    predictor.add_new_points_or_box(
        state,
        frame_idx=0,
        points=[[p["x"], p["y"]] for p in points],
        labels=[p["label"] for p in points]
    )

    for frame_idx, obj_ids, masks in predictor.propagate_in_video(state):
        if frame_idx % (frame_skip + 1) != 0:
            continue
        save_transparent_png(frame_idx, masks, output_dir)
        yield progress_event(frame_idx, total_frames)

    predictor.reset_state(state)  # prevents VRAM accumulation
```

`bfloat16` reduces VRAM ~40%. `reset_state` after every job is critical —
without it VRAM grows unboundedly and eventually OOMs.

## VRAM Management

- `torch.autocast("cuda", dtype=torch.bfloat16)` on all inference
- `predictor.reset_state(state)` called after every job without exception
- Cap input video to 60 seconds before processing; reject longer with a clear error
- On OOM: catch exception, reset state, return 500 with message suggesting shorter
  video or higher frame skip

## Storage

User-provided source videos are **not copied**. Only their paths are tracked in
project metadata. The app references them in place wherever they live.

Generated rotoscope frames are stored under the project's assets folder:

```
<project>/
  assets/
    rotoscope_<source_filename>/
      frame_0001.png
      frame_0004.png    <- frame_skip=3, every 4th frame
      frame_0007.png
      ...
      meta.json
```

`meta.json` records the job parameters for future reference:
```json
{
  "source": "/absolute/path/to/source.mp4",
  "frame_skip": 3,
  "points": [{"x": 540, "y": 960, "label": 1}],
  "model": "sam2_hiera_large",
  "generated_at": "2026-06-05T14:32:00Z",
  "frame_count": 45
}
```

## Workspace UI

Rotoscoping is its own workspace stage. If the microservice is unavailable at
app startup, this workspace is hidden entirely — no error state, just absent.

### Layout (three panes)

```
+---------------------------+---------------------------+
|  Video Preview (left)     |  Project Assets (top-right)|
|                           |                           |
|  [video player]           |  source_clip.mp4          |
|                           |  intro_footage.mp4        |
|  [point prompt overlay]   |  background.jpg           |
|  L-click = foreground (o) |  ...                      |
|  R-click = background (x) +---------------------------+
|                           |  Rotoscope Outputs        |
|  Frame skip: 0 1 2 [3] …  |  (bottom-right)           |
|  [Generate Rotoscope]     |                           |
|                           |  rotoscope_clip/          |
|  [progress bar + stage]   |  rotoscope_intro/         |
+---------------------------+---------------------------+
```

### Project Assets pane (top-right)

Lists all videos and images tracked in the current project. Double-clicking a
video loads it into the Video Preview pane on the left.

### Video Preview pane (left)

**Empty state:** "Double-click a video from the panel on the right."

**Video loaded:**
- Standard video player with scrubber
- User scrubs to the frame where the subject first clearly appears
- "Set Start Frame" button locks that as the reference frame (highlighted in scrubber)
- Frame skip selector: `Skip: [0][1][2][3*][4][5][6][7][8][9][10]`
- "Generate Rotoscope" button

**Point placement** (active after setting start frame):
- Canvas overlay on the locked reference frame
- Left-click: foreground point (green dot)
- Right-click: background exclusion point (red dot)
- Multiple points of each type supported
- "Clear Points" link to reset

On submit: the app uses ffmpeg to clip the video from the start frame to the
end, then sends that clip. The microservice always treats its frame 0 as the
reference — no frame index needs to be sent.

**Compression modal** (on clicking Generate Rotoscope):
> "Compress video before sending? Smaller file = faster transfer."
> [Toggle off/on] Quality: [80%]
> [Cancel] [Rotoscope]

**Processing view:** progress bar + stage label + frame counter + Cancel button.
`Uploading (2.3 MB)... / Segmenting (18 / 45 frames)... / Packaging...`
Cancel calls `DELETE /rotoscope/{job_id}` and returns to the point placement view.

### Rotoscope Outputs pane (bottom-right)

Lists completed rotoscope jobs for this project, each named
`rotoscope_<source_filename>`. Double-clicking a result loads its PNG sequence
into the Video Preview pane as a looping stop-motion playback at the effective
output frame rate.

## Service Discovery

Tauri backend pings `GET http://{host}:7080/health` on app launch.

```rust
// commands/rotoscoping.rs
#[tauri::command]
async fn check_rotoscoping_service(host: String) -> RotoscopingStatus {
    match reqwest::get(format!("http://{}:7080/health", host)).await {
        Ok(r) if r.status().is_success() => RotoscopingStatus::Available,
        _ => RotoscopingStatus::Unavailable,
    }
}
```

Host is configurable in Settings (default: `localhost`). Port is fixed at 7080.
Setting the host to a LAN IP allows the service to run on the Windows workstation
while the app runs on a different machine.

## Deployment

Standalone Python process. No installer. User starts it manually.

```bat
REM start.bat
uv run main.py
```

SAM2 Large weights (~900MB) are downloaded on first run to `microservices/rotoscoping/models/`.
Log output goes to `microservices/rotoscoping/logs/rotoscoping.log` (text, no database).
No persistent state stored — the service is stateless between runs.

## ffmpeg Dependency

The microservice uses ffmpeg for any pre-processing (frame extraction, clipping).

- **Windows (microservice):** on startup, check if ffmpeg is on PATH via
  `shutil.which("ffmpeg")`. If not found, download the static Windows binary
  via curl into `microservices/rotoscoping/bin/ffmpeg.exe` and use that path
  directly. Never require a global install.
- **Mac/Linux (Tauri app side):** the render toolchain already bundles ffmpeg
  (`dist-toolchain/`). Reference that binary for all client-side ffmpeg calls
  (clipping to start frame, compression). Do not assume ffmpeg is on PATH.

## Development Notes

Developed on Mac, cannot be tested until moved to the Windows workstation
(no CUDA on Mac). Aim for a clean one-shot implementation.

- Use `pathlib.Path` throughout — no hardcoded path separators
- All paths relative inside the microservice directory
- CUDA device check on startup: if CUDA unavailable, log a clear error and refuse
  to start rather than silently falling back to CPU

## Connection to the Instagram Pipeline

The rotoscoped PNG sequences in `assets/rotoscope_<name>/` are sprite assets
that Claude can use when generating Remotion compositions. The intended combined
flow is:

1. Extract motion language from a reference reel (Instagram pipeline) -> brief
2. Rotoscope a subject from user-provided video -> PNG sequence in assets
3. In the Claude terminal: inject the brief + reference the rotoscoped asset ->
   Claude generates a Remotion composition that moves like the reference reel
   and features the rotoscoped subject

For Claude to use the PNG sequence, the project's asset listing passed to Claude
should include all PNGs in `assets/rotoscope_*/`. Video files are excluded from
what Claude sees — sprite PNG sequences only. Handling video assets as Claude
context is a design skill concern, not part of this pipeline.

## Open Questions

- Should the host IP be user-configurable in Settings, or hardcoded to localhost
  for v1 with a manual config file on Windows?
- Box prompt support in addition to multi-point: out of scope for v1?
- SAM2 weights: download in `setup.py` script, or on first `/health` request?
