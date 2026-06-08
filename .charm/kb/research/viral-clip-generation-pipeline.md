---
id: viral-clip-generation-pipeline
root: research
type: architecture
status: current
summary: "Design proposal for an automated long-form → viral clip pipeline: Whisper transcription, scored region selection, Claude clip-picking, ffmpeg cutting, and intelligent subtitle placement that avoids blocking active content."
related:
  - research/claude-skills-podcast-clipper
  - research/mcp-tool-surface-design
created: 2026-06-07
updated: 2026-06-07
---

# Viral Clip Generation Pipeline

## Goal

Given a long-form video (Twitch VOD, game playthrough, podcast, etc.), automatically:
1. Identify the highest-potential viral moments as (start, end) time tuples
2. Cut those clips from the source video
3. Generate word-level subtitles for each clip
4. Place subtitles in a region that does not block active content
5. Produce final render-ready vertical (9:16) clips

The output is social-media-ready clips for platforms like TikTok, Instagram Reels, and YouTube Shorts — not a motion brief.

## What Already Exists (build on this)

`scripts/ig-pipeline/` handles the short-form side:
- `download.ts` — yt-dlp wrapper (URL or local file)
- `clip.ts` — ffmpeg clip trimmer
- `frames.ts` — frame extraction at N fps
- `score.ts` — frame quality gate (sharpness, delta, entropy)
- `analyze.ts` — Claude CLI print-mode analysis over frames (motion language)
- `store.ts` — extraction folder writer

The new pipeline reuses the download stage and the frame scoring logic but diverges significantly: it operates on the full duration, must transcribe audio, and produces cut video files with burned-in subtitles rather than a text brief.

The brain model interpreter repo (`2026-05-31_video-to-brain-model-interpreter`) is planned as an additional virality signal — it maps video regions to brain activity proxies (arousal, attention) that correlate with viewer engagement. It is not yet built; the pipeline should be designed so this slots in as one more scorer alongside the others.

## Pipeline Stages

### Stage 1: Ingest

Input: URL (Twitch VOD, YouTube, local file path) + output directory.

Use existing `download.ts`. For Twitch VODs specifically, yt-dlp supports chapter metadata — if available, use chapter boundaries as candidate clip windows to pre-partition the search space before scoring.

Output: `source.mp4`, duration, metadata.

### Stage 2: Transcription (words.json)

Run OpenAI Whisper (local, no API cost) at the word level to produce a `.words.json` file. The per-word timestamp format maps cleanly to the Weftly `.words.json` schema (see `mcp-tool-surface-design.md`) — compatible if we adopt the same schema, enabling skills reuse.

Key decision: **local Whisper via whisper.cpp or faster-whisper** (ggml backend, runs on Apple Silicon via Metal). Not the hosted API — a 2-hour VOD at $0.006/min = ~$0.72 per run which adds up; local is free after first download.

Whisper `large-v3-turbo` on Apple M-series hits ~30-40x realtime — a 2-hour VOD transcribes in ~3-4 minutes.

Output: `transcript.words.json` (word, start, end, confidence per entry).

### Stage 3: Region Scoring

Divide the video into overlapping windows (e.g. 30-90s windows, 15s stride). Score each window on multiple signals:

**Signal A: Audio Energy**
- RMS energy per frame from the audio track
- Peaks = exciting moments (reactions, kills, clutch plays)
- Valleys = downtime, loading screens

**Signal B: Transcript Excitement**
- Run the transcript words through a simple classifier or prompt:
  exclamations, profanity, game-specific highlight keywords (clutch, insane, wtf, pog, let's go), etc.
- Can be done locally (keyword density + capitalization patterns) or via Claude batch analysis
- Weight: density of high-energy words within a window

**Signal C: Visual Motion / Frame Delta**
- Extend existing `score.ts` delta metric to temporal windows
- High inter-frame delta = fast action, cuts, reactions
- Low delta = static, idle, menu

**Signal D: Twitch Chat Density (optional)**
- If the VOD has a chat replay (yt-dlp can download Twitch chat JSON), chat messages/second is one of the strongest virality proxies
- Spike in chat rate = something notable just happened
- This is Twitch-specific; skip for other sources

**Signal E: Brain Model Score (future)**
- Once `video-to-brain-model-interpreter` is built, plug its arousal/attention output in here as an additional signal per window
- Design the scoring pipeline with a pluggable signal interface from the start

**Combined Score**: weighted sum of signals, normalized to [0,1]. Weights are tuning knobs (env-overridable, same pattern as `ig-pipeline/lib/constants.ts`).

Output: `regions.json` — array of `{start, end, score, signals: {...}}`.

### Stage 4: Clip Selection (Claude)

Claude's job: given the `regions.json` + the full transcript, pick the best N clips and define their exact cut points. This is the identify step (pure reasoning, no file mutation).

Prompt Claude with:
- The top-K scored regions (e.g. top 20 by combined score)
- The transcript text for each candidate region
- Constraints: max clip duration (30-90s), no overlapping clips, prefer self-contained moments (don't start mid-sentence)

Claude returns a JSON array: `[{start, end, title, hook, platform_notes}]`.

This is where the "viral" judgment lives — Claude can recognize narrative arcs, punchlines, reaction peaks, and beginnings/endings in a way signal math alone cannot. The signals pre-filter from potentially thousands of windows down to a manageable candidate set.

Implementation: `claude -p --output-format json` (same pattern as `analyze.ts`). The prompt lists the candidate windows with their transcripts and signals; Claude outputs the clip list.

Output: `clips.json` — the selected clip list.

### Stage 5: Clip Cutting

ffmpeg trim per clip: `ffmpeg -ss <start> -to <end> -i source.mp4 -c copy clip_NNN.mp4`.

Use `-c copy` (stream copy) for speed. For subtitle burn-in later we re-encode anyway, so precise keyframe alignment at the cut point matters — use `-ss` BEFORE `-i` (input seeking, frame-accurate for encoded content, faster than output seeking for long files).

Output: `clips/clip_001.mp4`, `clips/clip_002.mp4`, ...

### Stage 6: Subtitle Slicing

For each clip `(start, end)`, extract the words from `transcript.words.json` whose timestamps fall within `[start, end]`. Adjust timestamps to be clip-relative (subtract `start`).

Group words into subtitle lines by pause detection and max-chars-per-line rules (e.g. 32 chars per line, split on pauses > 0.3s). Generate an `.srt` or `.ass` subtitle file per clip.

Styling: bold, high-contrast, word-by-word highlight (karaoke style) is more engaging than static line-by-line. This is configurable.

Output: `clips/clip_001.srt`, etc.

### Stage 7: Subtitle Placement

The hard problem: where to put the subtitles so they don't block action.

**Approach: Active Region Detection via Frame Sampling**

For each clip:
1. Sample frames at ~2fps (same as ig-pipeline's frame stage)
2. Divide each frame into a grid (e.g. top-third / middle-third / bottom-third)
3. Measure per-region activity: frame delta between consecutive samples in each grid zone
4. Average over the clip: the region with the LOWEST average delta is the "safest" zone for subtitles
5. Fallback: if no low-delta zone exists (everything is active), default to bottom with a semi-transparent background

For 9:16 vertical content (the standard short-form format), the practical options are:
- **Top zone**: safe for most gaming content (bottom usually has HUD/action)
- **Bottom zone**: safe for most IRL/podcast content (face is usually center-upper)
- **Center lower-third**: always-on but riskiest for gaming

This gives a per-clip placement decision: `{zone: "top"|"bottom"|"center", y_offset_pct: number}`.

**Alternative (more accurate)**: run a lightweight face/body detector (MediaPipe or OpenCV Haar cascades) to locate the subject, then place subtitles in the zone farthest from the detected bounding box. Heavier dependency but better for IRL content.

Output: `clips/clip_001_placement.json` — `{zone, y_offset_pct, confidence}`.

### Stage 8: Final Render

ffmpeg re-encode with subtitle burn-in:

For `.srt` subtitles with positional override:
```
ffmpeg -i clip_001.mp4 -vf "subtitles=clip_001.srt:force_style='...'" -c:a copy out_001.mp4
```

For `.ass` (more flexible styling — karaoke, position, font):
```
ffmpeg -i clip_001.mp4 -vf "ass=clip_001.ass" -c:a copy out_001.mp4
```

Vertical crop: if the source is 16:9 (most VODs), crop to 9:16 for short-form.
`crop=ih*(9/16):ih:(iw-ih*(9/16))/2:0` — center crop.

Output: `out/clip_001.mp4`, `out/clip_002.mp4`, ... — final deliverables.

## Tool Design (for Claude Code skill)

Following the Weftly lesson: do NOT expose each stage as a separate MCP tool. Pre-build the tools, expose a small surface:

| Tool | What it does |
|---|---|
| `transcribe(video_path)` | Runs Whisper, returns transcript.words.json path |
| `score_regions(video_path, transcript_path)` | Runs all signal scorers, returns regions.json path |
| `select_clips(regions_path, transcript_path, n)` | Claude selects N clips, returns clips.json |
| `cut_and_render(video_path, clips_path, transcript_path)` | Cuts, places subtitles, renders finals |

The identify/execute split maps cleanly to `select_clips` (pure reasoning) and `cut_and_render` (file mutation). Claude can iterate on clip selection (change N, adjust constraints, re-run) without re-cutting anything.

## Resolved Technical Decisions (from research)

All open questions resolved by parallel research agents. See individual notes for detail and code examples.

### Transcription backend: mlx-whisper + WhisperX alignment

Use **mlx-whisper** with `large-v3-turbo` as the transcription engine — it is the fastest Python-native ASR on Apple Silicon (Metal GPU, ~10-18x realtime on M2+). A 2-hour VOD transcribes in ~6-8 minutes. faster-whisper has NO Metal backend (CPU INT8 only, ~3-6x realtime on Mac) — do not use it as the primary engine.

For subtitle use, follow with a **WhisperX forced-alignment pass** to refine word timestamps from ±200ms (mlx-whisper native) to ±50ms. This is a fast alignment-only pass on top of the mlx-whisper transcript.

Word timestamp fields (both backends): `start: float`, `end: float`, `word: str`, `probability: float`.

See: `research-whisper-backends.md`

### Subtitle format: ASS with \kf karaoke tags, generated via pysubs2

**SRT cannot do karaoke** — it has no per-word timing mechanism. Use ASS exclusively.

The `\kf<cs>` tag (sweep fill, duration in centiseconds) is the right karaoke tag — smoother than `\k` (instant flip). Generate ASS programmatically using **pysubs2** for full positional control, or **stable-ts** if you want a single-library pipeline (transcribe + stabilize timestamps + emit ASS in one call).

Default style for 1080x1920 vertical social:
```
Style: Default,Montserrat,80,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,2,2,20,20,300,1
```
- White text, yellow pre-highlight, 80px font, 4px black outline, bottom-center, 300px from bottom.

ffmpeg burn-in: `ffmpeg -i clip.mp4 -vf "ass=clip.ass" -c:a copy out.mp4`

Per-line positional override: `{\an8\pos(540,80)}` for top, `{\an2\pos(540,1840)}` for bottom.

See: `research-subtitle-formats.md`

### Subtitle placement: two-stage MediaPipe + frame-delta

No existing open-source tool does content-aware subtitle placement — this is a gap we fill.

Recommended two-stage approach (adds ~100ms per clip):
1. Sample 10 frames, run MediaPipe `FaceDetection(model_selection=0)`. MediaPipe ships native arm64 wheels for Apple Silicon since v0.9.3.
2. If ≥2 faces detected: place subtitles opposite the face centroid (face in bottom half → `\an8` top; face in top half → `\an2` bottom).
3. If 0 faces (gaming content): run frame-delta energy on top/bottom bands via `cv2.absdiff`; place in lower-energy band.
4. Fallback: `\an2` bottom-center (MarginV 300) if both bands are high-motion.

For gaming-specific content: static safe-zone rules by genre are the fastest option (zero per-video cost). HUDs cluster in corners; center strip 15-25% from top is reliably safe for FPS/MOBA.

See: `research-subtitle-placement.md`

### Twitch chat: TwitchDownloaderCLI, not yt-dlp

**yt-dlp Twitch chat is broken** — the `--sub-langs rechat` path has been dead since ~2023 (confirmed broken as of Feb 2025 in yt-dlp issue #12437).

Use **TwitchDownloaderCLI** (lay295/TwitchDownloader): native arm64 macOS binary, no .NET install needed (self-contained release), no OAuth required for public VODs.

Command: `TwitchDownloaderCLI chatdownload --id <VOD_ID> -o chat.json`

Key message field: `content_offset_seconds` (float) — the primary timestamp for density windowing.

Virality signal: bucket messages into 30s windows, compute messages/second, normalize to [0,1] via 5th-95th percentile. Exclude known bots (nightbot, streamelements). Emote-only message density is a complementary hyper-excitement signal.

See: `research-twitch-chat-tools.md`

### Virality scoring: audio-first, four-signal composite

Recommended signal weights (evidence-backed):

| Signal | Tool | Weight | Window |
|---|---|---|---|
| Audio RMS energy | librosa / pydub | 0.35 | 1s / 0.5s stride |
| Chat density | TwitchDownloaderCLI | 0.30 | 30s / 5s stride |
| Transcript excitement | keyword density | 0.20 | 10s / 2s stride |
| Frame delta | opencv | 0.15 | 2s / 1s stride |

Efficiency strategy for a 2-hour VOD:
1. Run audio RMS + chat density over full VOD (seconds total).
2. Retain windows above 85th percentile as candidates (~15-20% of duration).
3. Run transcript excitement and frame delta only on candidates.
4. Smooth composite with `gaussian_filter1d(sigma=3)` to merge adjacent peaks into clip-length regions.
5. Hand top-N candidates to Claude for final selection.

Normalize each signal with 5th-95th percentile clipping (more robust than min-max for VODs with outlier moments).

Brain model integration: plug its scalar-per-window output directly into the weighted sum as a 5th signal. Default weight 0.0 until calibrated.

See: `research-virality-signals.md`

### Crop strategy for 16:9 → 9:16

Simple center crop as baseline:
```
ffmpeg -i input.mp4 -vf "crop=ih*(9/16):ih:(iw-ih*(9/16))/2:0,scale=1080:1920" output.mp4
```

Smart crop (optional upgrade): **Autocrop-vertical** (kamilstanuch/Autocrop-vertical on GitHub) uses YOLOv8 to detect people and crops to follow them. Only add this if center crop consistently misses the subject — it adds a ~100MB model dependency and is overkill for most gaming content where the subject is centered.

### Brain model integration interface

Design Stage 3 as a pluggable scorer interface: each scorer is a callable `(video_path: str, window_start: float, window_end: float) -> float`. The brain model interpreter should expose this interface when ready. Default weight 0.0 until it's calibrated against real virality ground truth.
