---
id: research-subtitle-placement
root: research
type: domain
status: current
summary: "Methods to automatically determine subtitle placement (top/middle/bottom) without occluding faces or active content, covering frame-delta grid sampling, MediaPipe face detection on Apple Silicon, ASS Y-position encoding, gaming HUD alternatives, and existing tools."
created: 2026-06-07
updated: 2026-06-07
---

# Research: Subtitle Safe Zone Detection

## Q1: Frame-delta grid sampling for safe zone detection

The core idea is to divide each frame into horizontal bands (typically top ~20%, middle ~60%, bottom ~20%), compute the mean absolute pixel difference between consecutive frames per band, and label the band with the lowest accumulated motion energy as the "safe zone" for subtitle placement.

**OpenCV implementation pattern:**

```python
import cv2
import numpy as np

def sample_motion_energy(video_path, sample_step=5):
    cap = cv2.VideoCapture(video_path)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))

    # Define band slices (top 20%, bottom 20%)
    bands = {
        "top":    (0,          int(h * 0.20)),
        "middle": (int(h * 0.40), int(h * 0.60)),
        "bottom": (int(h * 0.80), h),
    }
    energy = {k: 0.0 for k in bands}
    count = 0

    ret, prev = cap.read()
    prev_gray = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY)
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_idx += 1
        if frame_idx % sample_step != 0:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        diff = cv2.absdiff(gray, prev_gray)
        for name, (y0, y1) in bands.items():
            energy[name] += diff[y0:y1, :].mean()
        prev_gray = gray
        count += 1

    cap.release()
    if count == 0:
        return "bottom"

    # Normalize by sample count
    avg = {k: v / count for k, v in energy.items()}
    return min(avg, key=avg.get)  # returns "top", "middle", or "bottom"
```

Key tuning parameters:
- `sample_step`: sample every N frames (5-10 is fine for most clips; drop to 1 for very short clips)
- Band widths: the top and bottom "candidate" bands should be ~15-25% of frame height
- Threshold: if the winning band's energy is still high (e.g., > 30 mean pixel diff), you may want to fall back to a hardcoded bottom-safe rule

This approach has zero ML dependencies and runs in pure OpenCV/NumPy. For a 30-second 1080p clip sampled at every 5 frames it typically completes in under 2 seconds on a modern CPU.


## Q2: MediaPipe Face Detection on Apple Silicon

**Apple Silicon compatibility**: As of MediaPipe 0.9.3+, the official `mediapipe` package ships universal2 wheels that include arm64, so it installs and runs natively on M-series Macs without Rosetta. For older Python versions (3.8-3.11) or if the standard package fails, the community package `mediapipe-silicon` (by cansik on PyPI) provides pre-built arm64 wheels targeting macOS 12+ ARM64.

Install:
```bash
pip install mediapipe           # works on M-series since 0.9.3+
# or if that fails:
pip install mediapipe-silicon   # arm64-only drop-in replacement
```

**Python API for face bounding boxes:**

```python
import cv2
import mediapipe as mp

mp_face = mp.solutions.face_detection

with mp_face.FaceDetection(
    model_selection=0,          # 0=short-range (<2m), 1=full-range (<5m)
    min_detection_confidence=0.5
) as detector:
    frame = cv2.imread("frame.jpg")
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = detector.process(rgb)

    if results.detections:
        h, w = frame.shape[:2]
        for det in results.detections:
            bb = det.location_data.relative_bounding_box
            # All values are normalized [0,1]
            x = int(bb.xmin * w)
            y = int(bb.ymin * h)
            bw = int(bb.width * w)
            bh = int(bb.height * h)
            print(f"Face at y={y}, height={bh}")
```

The model returns 6 keypoints (eyes, nose tip, mouth, ear tragions) in addition to the bounding box.

**Performance**: BlazeFace (the underlying model) is described as "ultrafast" — benchmarks cite 180-200 FPS on mobile hardware. On Apple Silicon M-series with native arm64 wheels this is comfortably real-time; running on sampled frames (e.g., every 10th frame) is more than enough for subtitle placement decisions.

**Safe zone decision from face bounding boxes**: After getting face bounding boxes, determine which vertical band each face occupies. If faces are concentrated in the bottom half, prefer top placement; if faces are near the top, prefer bottom. A simple heuristic: compute the Y centroid of all detected face centers across sampled frames; if centroid > 0.5 (lower half), place subtitles in the top band.


## Q3: Lightweight alternatives for gaming content

For gaming footage, full face detection is often unnecessary because content layout follows predictable conventions.

**Static safe zone rules** (zero compute, recommended first pass):
- FPS games: HUD elements (health bar, ammo, minimap) cluster in the four corners and bottom strip. The horizontal center strip at 15-25% from top is reliably clear.
- MOBA/RTS: interface bars at top and bottom; safest zone is usually 15-30% from top, horizontally centered.
- Rule: for a given game genre, hard-code a "never-place" exclusion rectangle for each corner and use the remaining center bands.

**Region energy sampling** (lightweight, no ML):
Instead of frame-delta, compute per-band pixel variance or high-frequency energy (edge density) on single frames:
```python
gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
edges = cv2.Canny(gray, 100, 200)
top_energy    = edges[0:int(h*0.2), :].sum()
bottom_energy = edges[int(h*0.8):, :].sum()
# Place subtitle in whichever band has fewer edges
```
High edge density indicates text/HUD elements or complex backgrounds. This is faster than frame-delta because it operates on a single frame.

**Spectral residual saliency** (moderate complexity):
OpenCV's `cv2.saliency.StaticSaliencySpectralResidual_create()` produces a saliency map on a single frame without ML. Average the saliency map per horizontal band and place the subtitle in the lowest-saliency band. This generalizes across game genres without needing genre-specific rules.

```python
saliency = cv2.saliency.StaticSaliencySpectralResidual_create()
_, saliency_map = saliency.computeSaliency(frame)
top_sal    = saliency_map[0:int(h*0.2), :].mean()
bottom_sal = saliency_map[int(h*0.8):, :].mean()
zone = "top" if top_sal < bottom_sal else "bottom"
```

**YOLOv8 person detection**: Overkill for this use case. Adds ~100MB model weight and GPU dependency. Only justified if the pipeline already has YOLO running for other reasons.


## Q4: ASS subtitle Y-position encoding for ffmpeg

ASS ("Advanced SubStation Alpha") is the subtitle format that gives the most precise per-line positioning control when burning subs with ffmpeg.

**Two mechanisms for vertical placement:**

### 1. Style-level MarginV
In the `[V4+ Styles]` section, `MarginV` sets the vertical margin in pixels (distance from the edge determined by the alignment). Create separate styles for top vs. bottom placement:

```
[V4+ Styles]
Format: Name, Fontname, Fontsize, ..., Alignment, MarginL, MarginR, MarginV, ...
Style:  SubBottom,Arial,48,...,2,20,20,80,...   ; \an2 = bottom-center, 80px from bottom
Style:  SubTop,Arial,48,...,8,20,20,80,...      ; \an8 = top-center, 80px from top
```

Then in `[Events]`, set `Style: SubTop` or `Style: SubBottom` per subtitle line.

### 2. Per-event override tags (most flexible)
Inside each dialogue event text, use override tags:

```
{\an8\pos(540,80)}Top-center subtitle at Y=80
{\an2\pos(540,1840)}Bottom-center subtitle at Y=1840
```

- `\an<n>`: alignment anchor using numpad layout. `\an8` = top-center, `\an2` = bottom-center.
- `\pos(x,y)`: absolute pixel position in script resolution. The `\an` tag determines which point of the subtitle box aligns to (x,y). With `\an8`, (x,y) is the top-center; with `\an2`, it's the bottom-center.
- Coordinates are in script resolution (set in `[Script Info]`); for 1080x1920 vertical video, use those pixel values directly.

**ffmpeg burn-in command:**
```bash
ffmpeg -i input.mp4 -vf "ass=subtitles.ass" output.mp4
```

No special flags needed — ffmpeg renders all `\pos` and `\an` overrides as-is.

**For top placement (1080x1920 vertical video):**
```
{\an8\pos(540,80)}Word word word
```
Places subtitle top-center, 80px from the top edge.

**For bottom placement:**
```
{\an2\pos(540,1840)}Word word word
```
Places subtitle bottom-center, 80px from the bottom edge (1920 - 80 = 1840).

To generate ASS from code, build the file as a string — the format is straightforward text and there is no need for an ASS library. The pysubs2 Python library can also serialize ASS with full override tag support.


## Q5: Existing open-source tools

No production-ready open-source tool was found that specifically does content-aware subtitle placement (i.e., analyzes the video to pick top vs. bottom based on face or motion data).

Closest adjacent tools:
- **auto-subtitle** (github.com/m1guelpf/auto-subtitle): Whisper transcription + ffmpeg burn-in, but no smart positioning.
- **pycaps** (github.com/francozanardi/pycaps): Animated subtitle overlays via Python + ffmpeg, no positioning analysis.
- **subsai** (github.com/absadiki/subsai): Whisper + word-level timestamps + speaker diarization, no placement analysis.
- **Speaker-following Video Subtitles** (arxiv 1407.5145): Academic paper describing per-speaker placement based on saliency + speaker detection, but no released code found.

The gap is real: subtitle generation tools handle transcription and timing, but leave placement as a fixed style. Content-aware placement is a missing layer.


## Q6: Recommended minimum viable approach

**Recommendation: frame-delta grid sampling as the first pass, with optional MediaPipe upgrade.**

### Tier 1 — Pure frame-delta (no ML, fast, good enough for most content)

1. Sample every 5th frame, compute `cv2.absdiff` between consecutive samples.
2. Average the per-pixel diff in the top band (0-20% height) and bottom band (80-100% height).
3. Place subtitle in the band with lower average motion.
4. Fallback: if both bands have high motion (> threshold), default to bottom-center.

**Pros**: zero ML deps, ~2s for a 30s clip, predictable, works on any content.
**Cons**: motion in title cards or static gaming HUDs can confuse it; doesn't distinguish "static HUD text" from "safe clear region."

### Tier 2 — MediaPipe face detection (recommended if faces are the primary concern)

1. Sample every 10th frame, run `FaceDetection(model_selection=0)`.
2. Collect face bounding box Y-centroids across all sampled frames.
3. If median Y-centroid > 0.5 → place subtitles in top band; else → bottom band.
4. If no faces detected → fall back to frame-delta energy.

**Pros**: directly answers "where are the faces," highly accurate for talking-head clips.
**Cons**: adds `mediapipe` dependency (~50MB), slower per-frame than pure diff (~10ms/frame vs <1ms), overkill for gaming content.

### Tier 3 — Static rules for known game genres (fastest, zero per-video cost)

Maintain a small config mapping game genre → safe zone rectangle. If genre is known at clip-creation time, use the static rule directly.

### What to build first

For a viral clip generator, the likely content mix is talking-head commentary + gaming footage. A two-stage approach covers both:

1. Run MediaPipe on 10 sampled frames (fast, ~100ms total).
2. If ≥2 faces detected: use face-centroid method.
3. If 0 faces detected: use frame-delta energy method.
4. Encode the result as `\an8\pos(540,80)` (top) or `\an2\pos(540,1840)` (bottom) in the ASS output.

This covers the two main content types with one code path, adds ~100ms of analysis time, and requires only `mediapipe` + `opencv-python` as additional dependencies.


## Sources

- MediaPipe Face Detection Python API: https://mediapipe.readthedocs.io/en/latest/solutions/face_detection.html
- mediapipe-silicon (ARM64 wheels): https://pypi.org/project/mediapipe-silicon/ + https://github.com/cansik/mediapipe-silicon
- ASS override tags reference: https://aegisub.org/docs/latest/ass_tags/
- OpenCV motion detection grid forum: https://forum.opencv.org/t/motion-detection-by-means-of-roi-grid/547
- Speaker-following Video Subtitles (academic): https://arxiv.org/abs/1407.5145
- VideoHelp ASS subtitle positioning: https://forum.videohelp.com/threads/373652-Positioning-subtitle-in-video
