# Spike: Instagram Reel -> Motion Language Pipeline

**Goal:** de-risk `PROPOSAL-instagram-pipeline.md` by running the riskiest stages
end-to-end against a real public reel before committing to a build.

**Test URL:** `https://www.instagram.com/reel/DYsvvtAhLUQ/`
**Date:** 2026-06-06
**Verdict:** Pipeline is feasible end-to-end. Two proposal assumptions were wrong
and must be corrected before ticketing (see Findings 1 and 3).

---

## What was run

The full proposal flow, by hand, with the real toolchain:

1. Download reel via `yt-dlp`
2. Probe + clip to 30s via `ffmpeg`
3. Extract candidate frames at 2fps
4. Score + filter frames (delta + Laplacian sharpness + color entropy)
5. Extract a motion-language brief from the surviving frames via the `claude` CLI

All five stages completed. The produced brief correctly identified the reel's
actual structure (a day-vs-night "entrepreneurs working" contrast piece with
handheld camera, hard cuts, and burned-in subtitles) and distilled it into motion
vocabulary rather than a literal description — exactly the intended output.

Artifacts captured in `/tmp/ig-spike/` (source.mp4, clip.mp4, frames/, brief.json,
score.py, claude_out.json). Scratch only — not checked in.

---

## Findings

### 1. (!) Instagram download did NOT require cookies

The proposal's single biggest risk — "Instagram requires cookies, user must do a
one-time browser-cookie export" — did not hold for this public reel. `yt-dlp`
(version 2026.03.17) downloaded it on the **first attempt with no auth**:

```
yt-dlp --format mp4 -o source.mp4 <reel-url>   # exit 0, 1.01 MiB
```

yt-dlp now sets up a guest session and pulls public reel JSON metadata without
login. The proposal's "attempt without cookies first, fall back to cookies on a
login-required error" logic is still the right shape — but the cookie fallback is
the *exception path*, not the default. We should not build cookie-export UX as a
required first-run step. Build the no-auth path first; add cookie fallback only
when we hit a private/age-gated/rate-limited reel.

Caveat: one public reel is not a guarantee. Private accounts, age-gated content,
and IP rate-limiting will still need cookies. But the common case (public reel
URL) works zero-config, which materially improves the demo and onboarding story.

### 2. ffmpeg stages work exactly as specified

- Probe: 8.3s, 720x1280, 30fps reel.
- Clip to 30s (`-t 30 -c copy`): instant no-op for a sub-30s source, as designed.
- Extract at 2fps + scale 960: produced 17 candidate JPEGs (~1.8 MB total).

No surprises. The bundled-ffmpeg requirement (don't assume PATH) still stands for
the shipped app; the spike used Homebrew ffmpeg 7.1.1.

### 3. (!) The `claude -p --image <path>` flag DOES NOT EXIST

The proposal's extraction command is:

```
claude -p "<prompt>" --model claude-sonnet-4-6 --image frame_0001.jpg ... --output-format json
```

There is **no `--image` flag** in the Claude CLI (verified against 2.1.167).
`--file file_id:relative_path` is for downloading remote file resources at
startup, not attaching local images. This is the proposal's core mechanism and it
is not real as written.

**What actually works** (verified): reference the frame paths *in the prompt text*
and let the agent read them with its own Read tool, which is multimodal:

```
echo "$PROMPT_WITH_ABSOLUTE_FRAME_PATHS" | \
  claude -p --model claude-sonnet-4-6 --allowedTools "Read" --output-format json
```

The agent issued one Read per frame and returned the brief as the `.result`
field of the JSON envelope. This is still a non-interactive subprocess and frames
still never touch the PTY context — so the proposal's isolation guarantee holds.
Only the invocation changes.

The Architecture Notes and Motion Language Extraction sections of the proposal
must be rewritten around this `--allowedTools "Read"` + paths-in-prompt mechanism.

### 4. Frame scoring needs no OpenCV

The proposal floats "Python + OpenCV" for sharpness/entropy. OpenCV has no wheels
for Python 3.14 yet (the system interpreter here). The full scoring math —
Laplacian variance for sharpness, mean-absolute pixel delta for change, RGB
histogram entropy for color fullness — runs fine on **numpy + Pillow** alone, or
on Node's sharp/jimp as the proposal's alternative. Drop OpenCV from the design;
it's a dependency-weight liability with no upside here.

Filter behavior on the real reel (thresholds: delta < 8 reject, sharpness < 50
reject): 17 candidates -> 11 kept, 6 rejected. Rejections were correct — static
holds (delta ~1-6) and the blurry tail frames. Sharpness ranged 48-194. The
proposal's default thresholds produced sensible results with no tuning.

### 5. Cost and latency are real and worth budgeting

One extraction with `claude-sonnet-4-6`:

- **~41 seconds** wall time
- **~$0.21** per extraction
- **12 turns** (the agent Read each of the 11 frames in a separate turn)

The multi-turn Read pattern means latency and cost scale roughly linearly with
frame count. 11 frames is fine; capping kept-frames lower (e.g. top 8) would trim
both. The UI's progress bar should expect ~40-60s for the analysis stage, not a
couple seconds.

**Optimization to evaluate, not blocking:** `--input-format stream-json` lets you
send a single user message containing inline image content blocks, which would
collapse 11 Read round-trips into one multimodal turn — likely faster and cheaper.
Worth a follow-up spike; the Read-tool path already works and is simpler to ship.

---

## Impact on the proposal

| Proposal claim | Spike result | Action |
| --- | --- | --- |
| Instagram needs cookies (one-time export) up front | Public reel downloaded with zero auth | Make no-auth the default path; cookies = fallback only |
| `claude -p --image <path>` extracts the brief | No `--image` flag exists | Rewrite to `--allowedTools "Read"` + frame paths in prompt |
| Scoring via Python+OpenCV | OpenCV unavailable on 3.14; numpy+Pillow works | Drop OpenCV; use numpy+Pillow or Node sharp/jimp |
| 2fps + delta + sharpness frame selection | 17 -> 11, correct rejections, no tuning | Ship defaults as-is |
| Brief quality | Accurately captured day/night structure + motion feel | Approach validated |
| (unstated) analysis latency/cost | ~41s, ~$0.21, 12 turns per extraction | Set UI/cost expectations; consider stream-json optimization |

**Bottom line:** the concept is sound and the output is good enough to build on.
The two corrections (no-cookie default, Read-tool extraction mechanism) are
straightforward and actually *simplify* the build. Ready to move to ticketing
once the proposal is patched.
