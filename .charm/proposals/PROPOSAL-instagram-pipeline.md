# Proposal: Instagram Reel -> Motion Language Extraction -> Animation Pipeline

## North Star

Extract the **motion language and motion theme** of an Instagram Reel so it can
be applied to original content. The output is not a copy of the source — it's a
distilled creative vocabulary (how things move, how they feel, how time is used)
that Claude can use to generate motion graphics with the same energy and character.

## Problem

Users want to reference an existing reel and have Claude generate a Remotion
animation that moves and feels like the source — without manually describing it,
and without copying it.

## Proposed Flow

```
User drops URL or local video file (mp4/mov/webm)
        |
[If URL: Download]
  yt-dlp -> local mp4
  Instagram: requires cookies (one-time user setup)
  YouTube / TikTok / Vimeo: no auth needed
        |
[Notify user if video > 30s]
  "We analyze the first 30 seconds. Make sure your best moments are up front."
        |
[Clip to 30s]
  ffmpeg -t 30 -c copy -> clip.mp4  (stream copy, instant)
        |
[Extract at 2fps]
  ffmpeg fps=2, scale=960:-1 -> up to 60 candidate JPEGs
        |
[Delta filter]
  Drop frames where pixel change from previous < threshold
  (removes static holds and near-duplicate frames)
        |
[Quality scoring]
  Sharpness (Laplacian variance) + histogram entropy per frame
  Discard below sharpness floor
  Take top 30 survivors
        |
[Motion language extraction]
  claude -p "<prompt>" --model claude-sonnet-4-6 --image frame_001.jpg ...
  Non-interactive subprocess — stdout captured as JSON brief
  (frames never enter the interactive PTY context)
        |
[UI: filmstrip of selected frames + editable brief]
  User reviews, edits if needed
  "Use as Style Reference" ->
        |
[terminal_input command]
  Types brief as text into the existing Claude terminal
  (same as user pasting it — no PTY changes)
        |
[Claude terminal session]
  Claude generates animation.tsx as original motion graphics
  using the extracted motion language as its creative vocabulary
        |
[File watcher -> live preview]
```

## Video Ingestion

### URL Drop

When a URL is dropped or pasted into the app, the backend triggers a download
pipeline before any frame work. yt-dlp handles the actual fetch:

```bash
yt-dlp --format "mp4" --output "/tmp/ref_%(id)s.mp4" <URL>
```

**Instagram-specific:** Requires cookies. The app should:
1. Attempt download without cookies first
2. If it gets a login-required error, prompt the user to export cookies from their
   browser (one-time setup) and store the path in Settings
3. Re-attempt with `--cookies <path>`

This makes Instagram work without being fully automated — user does the one-time
cookie export, the app handles the rest. yt-dlp supports Firefox and Chrome cookie
extraction via `--cookies-from-browser firefox`.

Non-Instagram URLs (YouTube, TikTok, Vimeo) work without auth.

### File Drop

User can drop any local mp4/mov/webm directly — skips the download stage entirely.
Hook into the existing native drag-drop event (`getCurrentWebview().onDragDropEvent()`)
and detect video MIME types. Route video files to the frame extraction pipeline
instead of the assets panel.

## 30-Second Cap

Only the first 30 seconds of any video are processed. The UI must communicate
this clearly when the user submits a video longer than 30 seconds:

> "We analyze the first 30 seconds of your video. Make sure your best moments
> are up front."

Enforce via ffmpeg's `-t 30` flag at extraction time. Don't silently truncate —
show the user the trimmed duration before the analysis starts so they can choose
a different clip if needed.

## Frame Selection

The goal is: **sharp, visually distinct frames that represent fully-rendered
moments in the video.** Static duplicate frames and transition frames are both
useless — we want frames where something new and clear is visible.

### Stage 0 — Clip to 30 Seconds

Before any frame extraction, hard-clip the video to a maximum of 30 seconds.
This produces a working copy regardless of the original length:

```bash
ffmpeg -i input.mp4 -t 30 -c copy clip.mp4
```

If the source is already <= 30 seconds, this is a no-op fast copy. The UI
notifies the user upfront when their video is longer than 30 seconds:

> "We analyze the first 30 seconds of your video. Make sure your best
> moments are up front."

All subsequent stages operate on `clip.mp4`, not the original.

### Stage 1 — Extract at 2fps (60 candidates max)

Sample two frames per second across the clipped 30 seconds:

```bash
ffmpeg -i clip.mp4 \
  -vf "fps=2,scale=960:-1" \
  -q:v 2 \
  frame_%04d.jpg
```

2fps across 30 seconds = 60 candidate frames. Enough temporal resolution to
catch fast text reveals and hold moments without over-sampling.

### Stage 2 — Reject Frames With Insufficient Pixel Change

Compare each frame to the previous one. Discard frames where the pixel delta is
below a threshold — these are static holds where nothing new has appeared.
At 2fps, consecutive frames are 0.5s apart; a low delta means the shot hasn't
changed meaningfully in that half-second.

```python
import cv2
import numpy as np

def pixel_delta(img_a, img_b):
    a = cv2.imread(img_a, cv2.IMREAD_GRAYSCALE).astype(np.float32)
    b = cv2.imread(img_b, cv2.IMREAD_GRAYSCALE).astype(np.float32)
    return np.mean(np.abs(a - b))  # mean absolute pixel difference

# Reject if delta < 8.0 (empirical — adjust based on testing)
# Removes near-duplicate frames from static holds and slow-evolving shots
```

Keep the first frame always (no previous to compare against).

### Stage 3 — Score Remaining Frames for Quality

From the frames that survived the delta filter, score each one:

**Sharpness (Laplacian variance)** — rejects motion-blurred and mid-transition
frames:

```python
def sharpness(path):
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    return cv2.Laplacian(img, cv2.CV_64F).var()
# < 50 = blurry/transitioning, > 300 = crisp
```

**Histogram fullness** — rejects solid-color flashes (black, white, brand color
holds with no content):

```python
def histogram_fullness(path):
    img = cv2.imread(path)
    hist = cv2.calcHist([img], [0,1,2], None, [8,8,8], [0,256]*3)
    hist = hist.flatten() / hist.sum()
    return -np.sum(hist[hist > 0] * np.log2(hist[hist > 0]))  # color entropy
```

Combined score: `sharpness * 0.7 + histogram_fullness_normalized * 0.3`

Discard any frame below the sharpness floor (< 50). From whatever remains,
take the top 30 by combined score. If fewer than 5 frames survive all filters,
warn the user: "This video may be too short or too fast-cut for reliable analysis."

### Why 1fps + Delta Filter Over Scene Detection

ffmpeg's scene filter selects the frame *of maximum change* — exactly the
mid-wipe or motion-smeared transition frame, which is the worst possible choice.
1fps sampling with a delta filter does the opposite: it keeps frames where change
has already happened and settled, giving us the fully-rendered state of each shot.
It's also simpler: no per-segment candidate extraction, no merge logic, just
30 candidates and a two-pass filter.

## Motion Language Extraction

The goal is to extract how the video **moves and feels** — not to catalog its
visual properties. We're building a motion vocabulary: the rhythm, the energy,
the way time is used, the kinetic signature. That vocabulary is what Claude
applies to original content.

### Claude CLI

The app only has access to the `claude` CLI — no direct Anthropic API calls.
All Claude interactions go through the same binary that powers the PTY terminal.

All invocations use `--model claude-sonnet-4-6`. This applies to both the
non-interactive analysis subprocess and the interactive PTY coding session.

The analysis step uses Claude CLI's **non-interactive print mode**, run as a
one-shot subprocess (separate from the interactive PTY session):

```bash
claude -p "<prompt>" \
  --model claude-sonnet-4-6 \
  --image /tmp/frames/frame_0001.jpg \
  --image /tmp/frames/frame_0002.jpg \
  ... \
  --output-format json
```

The Tauri backend spawns this as a `std::process::Command`, captures stdout,
and parses the JSON. Frames never enter the interactive PTY context window.

### Prompt

```
You are a motion design creative director. You've been given frames from a
short-form video. Your job is to extract its motion language — the way it moves,
the way it feels, the way it uses time — so that a motion designer can apply
that same language to completely original content.

Do NOT describe what's literally in the video. Extract the underlying motion
vocabulary: the rhythm, the kinetic energy, the pacing, the transitions, the
feeling of being inside this video.

Here are [N] frames from distinct moments in the video.

Return JSON:
{
  "motionLanguage": {
    "energy": "the overall kinetic quality — e.g. 'punchy and immediate', 'fluid and drifting', 'mechanical and precise', 'nervous and reactive'",
    "rhythm": "how the piece pulses through time — e.g. 'burst-and-hold', 'steady metronomic', 'accelerating to impact', 'call-and-response'",
    "pacing": "fast cuts / held frames / slow reveals / mixed — and how that creates feeling",
    "transitions": "how scenes and elements move between states — cut, dissolve, wipe, zoom, push, or something else",
    "signature": "the one motion idea that makes this feel like itself — the thing you'd steal first"
  },
  "motionTheme": "one sentence: the emotional and kinetic identity of this piece",
  "colorMood": "the feeling the color palette creates — not the colors themselves, what they communicate",
  "typographyMotion": "how text moves if present — or 'absent'",
  "applicationGuide": "2-3 sentences: how to apply this motion language to new content — what principles to carry over, what to interpret freely, what the new piece must feel like"
}
```

The `applicationGuide` field is the most important. It bridges extraction to
generation — it's Claude writing a note to itself about how to use this vocabulary
on something new.

## Brief -> Code Generation

When the user clicks "Use as Style Reference", the app calls the existing
`terminal_input` command to type the brief into the Claude terminal — exactly
as if the user had pasted it themselves. No changes to the PTY or terminal
infrastructure.

The text typed into the terminal:

```
Here is a motion language brief extracted from a reference video.
Use it to create a Remotion composition with the same motion energy and theme —
not a copy of the source, but something new that moves and feels the same way.

Brief: <JSON>
```

Claude then writes animation.tsx using its normal coding session. The file
watcher picks up the change and the preview updates live.

## Workspace UI

The IG pipeline is its own workspace stage — Instagram icon, label "IG". No
terminal in this workspace. Brief delivery to Claude happens in the main project
workspace via terminal_input; the IG workspace is purely for extraction and review.

### Layout

```
+------------------+---------------------------------------------------+
| Extraction list  |  Main area                                        |
| (mini sidebar)   |                                                   |
|                  |  +---------------------+  +--------------------+ |
| > reel_abc123    |  | Video Preview       |  | Extracted Frames   | |
|   reel_def456    |  |                     |  |                    | |
|                  |  | [URL input / video] |  | 001 002 003 004    | |
|                  |  |                     |  | 005 006 [X]008     | |
|                  |  | [progress bar]      |  | 009 010 ...        | |
|                  |  +---------------------+  +--------------------+ |
|                  |                                                   |
|                  |  +---------------------------------------------+ |
|                  |  | Motion Language Brief (JSON output)         | |
|                  |  | { "motionTheme": "...", ... }               | |
|                  |  +---------------------------------------------+ |
|                  |                                                   |
|                  |  [ Use as Style Reference ]                       |
+------------------+---------------------------------------------------+
```

### Extraction List (left sidebar)

VS Code file-tree style. One row per extraction, named by timestamp or source
short ID (e.g. `2026-06-05 reel_abc123`). Clicking a row loads that extraction's
video, frames, and brief into the main area. Active extraction is highlighted.

Empty state: "Drop a URL or video to get started."

### Video Preview (top-left of main area)

**Empty state:** a box with a URL text input and a drop zone. User pastes an
Instagram URL or drops a local video file. Pressing Enter or clicking the download
button starts the pipeline.

**Downloading:** progress bar with stage label (Downloading... / Clipping... /
Extracting frames... / Scoring... / Analyzing...). Show the source URL and
detected duration.

If video is longer than 30s, show inline notice:
> "Analyzing first 30 seconds. Make sure your best moments are up front."

**Done:** replace the input with a standard `<video>` player showing the clipped
30s source. User can scrub and replay.

### Extracted Frames (top-right of main area)

Grid of frame thumbnails, 5px gap between each. No filenames — zero-padded
indexes (001, 002, 003...) in small text below each thumbnail. Frames appear
progressively as extraction and scoring runs.

**Accepted frames:** normal display.

**Rejected frames** (failed delta filter or below sharpness floor): red semi-
transparent overlay + centered X mark. Still visible in the grid so the user
can see what was excluded. Tooltip on hover explains why: "Rejected: low
sharpness" / "Rejected: insufficient change".

Frame grid is scrollable if there are many candidates.

### Motion Language Brief (bottom panel)

Formatted JSON output from the `claude -p` analysis call. Displayed as a
read-only code block. Appears once the analysis step completes.

A secondary line shows the extraction file path so the user knows where it's saved.

### "Use as Style Reference" button

Appears once the brief is ready. Clicking it switches the user to the main project
workspace and types the brief into the Claude terminal via terminal_input.

## Storage

Each extraction gets its own folder inside the project:

```
<project>/
  extractions/
    2026-06-05_abc123/
      source.mp4          <- original downloaded file
      clip.mp4            <- 30s clipped version
      frames/
        frame_001.jpg     <- all candidates (accepted + rejected)
      brief.json          <- raw JSON from claude -p
      extraction.md       <- human-readable brief + metadata
```

`extraction.md` frontmatter: source URL, extracted timestamp, video duration,
frames analyzed, frames rejected, model used. Body is the brief rendered as
readable markdown.

## Connection to the Rotoscoping Pipeline

The motion language brief produced here is one half of the full creative flow.
The other half is a rotoscoped subject from user-provided video (see
`PROPOSAL-rotoscoping-microservice.md`). Together:

1. Brief (from this pipeline) — sets the motion vocabulary and energy
2. Rotoscoped PNG sequence (from rotoscoping pipeline) — provides the subject asset
3. Claude terminal — receives the brief + knows about the PNG sequence in assets,
   generates a Remotion composition that moves like the reference and features
   the user's own subject

Claude should have visibility into all PNG assets in the project, including
rotoscoped sequences. Video files are excluded from Claude's asset context.

## Architecture Notes

- Download: Rust `std::process::Command` calling yt-dlp (add to toolchain download)
- Frame extraction + scoring: Node script alongside render-mp4.mjs; uses the
  bundled ffmpeg binary from `dist-toolchain/` — do not assume ffmpeg on PATH
- Scoring: Laplacian variance via sharp/jimp in Node, or spawn a small Python
  script with OpenCV
- Brief extraction: `claude -p` subprocess from Rust backend, stdout captured
- Brief delivery: existing `terminal_input` Tauri command, no PTY changes
- Progress streaming: Tauri `emit` events to frontend, same pattern as render toolchain

## Open Questions

- Cookie management UX: one-time setup flow in Settings vs. prompting per Instagram URL?
- Should the user be able to manually un-reject a frame (click to override) before analysis runs?
- Should we expose scoring thresholds as advanced settings or hardcode defaults?
