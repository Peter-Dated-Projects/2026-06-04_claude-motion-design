# Rotoscoping Microservice

An optional Windows/CUDA microservice that rotoscopes a video into a transparent
PNG sequence using [SAM2](https://github.com/facebookresearch/sam2). The
ClaudeMotion Tauri app pings `GET /health` at startup; if the service is not
reachable, the rotoscoping workspace is simply hidden and the rest of the app
works normally.

It accepts a pre-clipped video plus multi-point prompts (foreground/background
clicks placed in the app), runs SAM2 video propagation on the local GPU, and
returns a ZIP of `frame_NNNN.png` images with the subject isolated on a
transparent background. Those PNG sequences become sprite assets Claude can use
when generating Remotion compositions.

## Requirements

- **Windows 11** (the service is built for the Windows workstation; it also runs
  on Linux with CUDA, but ffmpeg auto-download only triggers on Windows).
- **NVIDIA GPU with CUDA 12.8.** The reference box is an RTX 5060 Ti (16GB,
  Blackwell / sm_120). sm_120 *requires* CUDA 12.8 and a matching torch build.
- **[uv](https://docs.astral.sh/uv/)** for dependency management and running.
- **Python 3.11** (pinned in `.python-version`; PyTorch 2.7 + CUDA 12.8 are fully
  supported there).

### Why the cu128 torch wheel

Default PyPI torch wheels do **not** support Blackwell (sm_120). `pyproject.toml`
pulls `torch`/`torchvision` from the CUDA 12.8 wheel index instead:

```toml
[tool.uv.sources]
torch = { index = "pytorch-cu128" }
torchvision = { index = "pytorch-cu128" }

[[tool.uv.index]]
name = "pytorch-cu128"
url = "https://download.pytorch.org/whl/cu128"
explicit = true
```

`uv` resolves these automatically -- you do not run a manual `pip install
--index-url`. SAM2 (`sam-2`) is installed from its upstream git repo with build
isolation disabled (it reaches for torch at build time).

## Running

```bat
REM From this directory:
start.bat
REM which is just:
uv run main.py
```

The service binds `0.0.0.0:7080` so a LAN client (the app on another machine)
can reach it. Set `ROTO_HOST` / `ROTO_PORT` to override.

**First run** downloads:
- SAM2 Large weights (~900MB) into `models/`.
- A static ffmpeg build into `bin/` *only if* `ffmpeg`/`ffprobe` are not already
  on PATH (Windows only).

Neither is committed (`.gitignore` excludes `models/`, `bin/`, `.work/`,
`logs/`). Logs are plain text at `logs/rotoscoping.log` (no database).

### No CPU fallback

The service refuses to start if `torch.cuda.is_available()` is `False` -- it logs
a clear error and exits non-zero rather than silently running on CPU (which would
be unusably slow and is never intended).

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | `{status, model, vram_used_gb, vram_total_gb}` -- polled for discovery |
| POST | `/rotoscope` | multipart `{video, points, frame_skip, job_id}` -> ZIP of PNGs |
| GET | `/rotoscope/{job_id}/progress` | SSE progress snapshots until `done`/`error` |
| DELETE | `/rotoscope/{job_id}` | cancel an in-flight job (200) |

**`points`** is a JSON array of `{x, y, label}` where `label` is `1` for a
foreground point and `0` for a background exclusion point. **`frame_skip`**
controls output decimation (`0` = every frame, `3` = every 4th); capped at
`MAX_FRAME_SKIP` (10). **`job_id`** is **client-supplied**: the client opens the
progress SSE stream on that id before POSTing, because the POST runs the job
synchronously and returns the ZIP, so a server-assigned id could not be
subscribed to in time. The progress endpoint tolerates the race where it
subscribes a moment before the POST registers the job.

Output PNGs are named `frame_{idx+1:04d}.png` (1-based) for the frames where
`frame_idx % (frame_skip + 1) == 0`. SAM2 propagates across *every* frame for
mask quality; only the kept frames are written.

## Configuration -- `config.py`

Every version- and machine-sensitive constant lives in `config.py` so it can be
verified on the target box without hunting through code. Each can be overridden
by an environment variable.

### VERIFY before first run on a new machine

The SAM2 model checkpoint name, Hydra config name, and download URL **must agree
with the installed `sam-2` package version**. They live together in `config.py`:

- `SAM2_CHECKPOINT_NAME` (default `sam2_hiera_large.pt`)
- `SAM2_CONFIG_NAME` (default `sam2_hiera_large.yaml`)
- `SAM2_CHECKPOINT_URL` (default the 072824 release)

If you bump `sam-2` in `pyproject.toml` to a 2.1 build, switch all three
together -- e.g. `sam2.1_hiera_large.pt`, `configs/sam2.1/sam2.1_hiera_l.yaml`,
and the `092824` URL. The config name is resolved by SAM2's Hydra setup from
inside the installed package; the original release uses the bare yaml name while
2.1 builds use a `configs/sam2.1/...` path.

Other tunables: `PORT` (7080), `HOST` (`0.0.0.0`), `MAX_VIDEO_SECONDS` (60),
`MAX_FRAME_SKIP` (10), `FFMPEG_WINDOWS_URL`.

## VRAM notes

- All inference runs under `torch.autocast("cuda", dtype=torch.bfloat16)`
  (~40% less VRAM).
- `reset_state` is called after **every** job in a `finally` block -- without it
  VRAM grows unboundedly and eventually OOMs.
- Clips are capped at `MAX_VIDEO_SECONDS`; longer uploads are rejected with a
  clear error.
- On CUDA OOM the service resets state and returns `500` suggesting a shorter
  clip or higher frame skip.

## Development note

This service was developed on a Mac, which has no CUDA, so the GPU code paths
(predictor build, propagation, VRAM stats) could not be executed here. The code
aims for a clean one-shot run on the Windows box; spots that could not be
exercised are flagged with `VERIFY:` comments in the source, and all
version-sensitive values are funneled through `config.py`. `import main` parses
without CUDA (the SAM2 import is lazy and the CUDA guard only fires at startup).
