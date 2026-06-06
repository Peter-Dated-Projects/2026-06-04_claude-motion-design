# ig-pipeline

Instagram-reel -> motion-language brief pipeline. Takes a reel URL (or a local
video), downloads and clips it, extracts and scores candidate frames, and runs
the `claude` CLI to distill a **motion-language brief** describing how the source
moves and feels.

**Runtime: Bun + TypeScript.** This is a standalone runtime island under
`scripts/ig-pipeline/`, separate from the repo's Node `scripts/*.mjs`. It does
not import them and does not add dependencies to the repo-root `package.json`.

> **CLI-only this session.** There is no UI and no Tauri/Rust wiring yet -- no IG
> workspace, no panels, no `terminal_input` brief delivery. Those are a follow-up
> once the command-line flow is proven. See `.charm/PROJECT.md` for scope.

## Prerequisites

Bun (>= 1.3) plus these external binaries, assumed present **on your PATH**:

| Binary | Used by | Notes |
|---|---|---|
| `yt-dlp` | download | Fetches the reel. Public reels need no auth; private/age-gated/rate-limited content falls back to browser cookies. |
| `ffmpeg` | clip, frames | Clips to 30s (`-t 30 -c copy`) and extracts frames (`fps=2,scale=960:-1`). |
| `ffprobe` | clip | Probes source duration/metadata. |
| `claude` | analyze | Runs the print-mode analysis (`claude -p --allowedTools "Read" --output-format json`). |

Install (macOS / Homebrew): `brew install yt-dlp ffmpeg` (ffmpeg ships
`ffprobe`); install the `claude` CLI per Anthropic's instructions.

Vendoring these binaries into the shipped app's render-toolchain is a later
integration concern, not part of this CLI build.

## Install

```bash
bun install
```

`sharp` (the image library used for frame scoring) is a native module. It loads
and runs correctly under Bun **when resolved from this project's local
`node_modules`** -- which is the normal case for the stage modules and tests
here. (A Bun script run from outside this tree resolves `sharp` from Bun's global
cache, whose layout breaks the native dylib lookup; keep scripts inside the tree.)

## Layout

```
scripts/ig-pipeline/
  package.json        all anticipated deps, declared up front
  tsconfig.json       strict TS
  bunfig.toml         bun test config
  types.ts            the stage I/O contract every module imports
  lib/
    constants.ts      tuning constants (env/param overridable)
    spawn.ts          typed Bun.spawn wrapper (typed binary-not-found errors)
    paths.ts          per-source output-folder layout + frame naming
  README.md
```

The stage modules (`download.ts`, `clip.ts`, `frames.ts`, `score.ts`,
`analyze.ts`, `store.ts`) and the `run.ts` orchestrator are added by later
tickets; they all compile against `types.ts` without amending it.

### Output layout (pinned)

Each extraction writes to its own folder:

```
<out>/extractions/<YYYY-MM-DD>_<sourceId>/
  source.mp4        original downloaded file
  clip.mp4          <=30s working copy
  frames/
    frame_001.jpg   candidates (1-based, zero-padded to 3 digits)
  brief.json        raw JSON from claude -p
  extraction.md     human-readable brief + metadata
```

## Run

Each stage module exposes its own CLI entry (added by later tickets); the typical
pattern is:

```bash
bun run scripts/ig-pipeline/<stage>.ts <args>     # one stage
bun run scripts/ig-pipeline/run.ts <reel-url>     # full pipeline (orchestrator)
```

## Tuning constants

Scoring/extraction defaults live in `lib/constants.ts` and are **overridable at
runtime** -- the spike's thresholds were measured on a single reel and will need
tuning. Override via environment variables (or programmatically with
`resolveConstants(overrides)`):

| Env var | Default | Meaning |
|---|---|---|
| `IG_FPS` | `2` | Frame sampling rate (fps). |
| `IG_SCALE_WIDTH` | `960` | Frame width in px (aspect preserved). |
| `IG_CLIP_SECONDS` | `30` | Hard cap on analyzed clip length. |
| `IG_DELTA_REJECT_THRESHOLD` | `8` | Reject frames whose pixel delta is below this. |
| `IG_SHARPNESS_FLOOR` | `50` | Reject frames whose sharpness is below this. |
| `IG_MAX_KEPT_FRAMES` | `30` | Keep at most this many frames (top-N by score). |
| `IG_ANALYSIS_MODEL` | `claude-sonnet-4-6` | Model for the analysis call. |

## Test

```bash
bun test
```

Deterministic tests cover the lib helpers (path layout/naming, spawn error
classification). Later tickets add scoring tests against committed fixture frames
and an opt-in, env-gated end-to-end smoke test against a real reel URL.
