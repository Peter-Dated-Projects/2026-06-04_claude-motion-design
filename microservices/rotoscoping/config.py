"""Central configuration for the rotoscoping microservice.

Every value here that is version- or machine-sensitive lives in ONE place so it
can be verified/tuned on the Windows + CUDA workstation without hunting through
the code. This service is developed on a Mac (no CUDA) and cannot be exercised
end-to-end until it runs on the target box, so anything the author could not
actually run is flagged with a `VERIFY:` comment.

All paths are derived from this file's location with pathlib -- nothing is
hardcoded with OS separators, so the same code runs on Windows or Linux.
"""

from __future__ import annotations

import os
from pathlib import Path

# --- Service ---------------------------------------------------------------

# Fixed port the Tauri app pings for /health and posts jobs to. The host is the
# app's concern (localhost, or a LAN IP when the service runs on a separate
# Windows box); the service always binds all interfaces so a LAN client reaches
# it. Override the port with ROTO_PORT only if 7080 collides with something.
PORT: int = int(os.environ.get("ROTO_PORT", "7080"))
HOST: str = os.environ.get("ROTO_HOST", "0.0.0.0")

# Reject inputs longer than this. SAM2 holds per-frame state in VRAM for the
# whole clip; an unbounded clip OOMs the 16GB card. The client also caps clip
# length, but the service enforces it as the last line of defence.
MAX_VIDEO_SECONDS: float = float(os.environ.get("ROTO_MAX_SECONDS", "60"))

# Hard ceiling on frame_skip, matching the UI cap. Beyond this the stop-motion
# playback is too choppy to read; it is also a guard against absurd inputs.
MAX_FRAME_SKIP: int = 10

# Number of frames processed per SAM2 propagation chunk. SAM2's memory bank
# (output_dict) grows one tensor per propagated frame; chunking bounds peak CPU
# RAM regardless of clip length. Between chunks state is reset and freed.
CHUNK_SIZE: int = 150

# --- Filesystem layout -----------------------------------------------------

BASE_DIR: Path = Path(__file__).resolve().parent
MODELS_DIR: Path = BASE_DIR / "models"
BIN_DIR: Path = BASE_DIR / "bin"  # bundled ffmpeg.exe lands here on Windows
WORK_DIR: Path = BASE_DIR / ".work"  # per-job scratch (frames, partial output)
LOGS_DIR: Path = BASE_DIR / "logs"

for _d in (MODELS_DIR, BIN_DIR, WORK_DIR, LOGS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# --- SAM2 model ------------------------------------------------------------

# VERIFY: these three must agree with the installed `sam2` package version.
# The proposal pins the original SAM2 "large" release; if you bump sam-2 in
# pyproject.toml to a 2.1 build, switch all three together (e.g.
# sam2.1_hiera_large.pt + configs/sam2.1/sam2.1_hiera_l.yaml + the 092824 URL).
SAM2_CHECKPOINT_NAME: str = os.environ.get(
    "ROTO_SAM2_CHECKPOINT", "sam2_hiera_large.pt"
)
# Hydra config name resolved from inside the installed sam2 package (hydra is
# initialized with config module "sam2", so this path is relative to the package
# root). Note the config is named with the short size code `_l`, NOT `_large`
# like the checkpoint, and lives under `configs/sam2/`. The 2.1 build uses
# `configs/sam2.1/sam2.1_hiera_l.yaml`. Keep it in lockstep with the checkpoint.
SAM2_CONFIG_NAME: str = os.environ.get(
    "ROTO_SAM2_CONFIG", "configs/sam2/sam2_hiera_l.yaml"
)
SAM2_CHECKPOINT_URL: str = os.environ.get(
    "ROTO_SAM2_CHECKPOINT_URL",
    "https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_large.pt",
)

# Short label reported by /health and stored in each job's meta.json. Derived
# from the checkpoint name without the extension.
MODEL_LABEL: str = Path(SAM2_CHECKPOINT_NAME).stem

CHECKPOINT_PATH: Path = MODELS_DIR / SAM2_CHECKPOINT_NAME

# --- ffmpeg ----------------------------------------------------------------

# Static Windows build, pulled into bin/ only when ffmpeg is not already on
# PATH. gyan.dev publishes the canonical static Windows builds.
FFMPEG_WINDOWS_URL: str = os.environ.get(
    "ROTO_FFMPEG_WINDOWS_URL",
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
)
