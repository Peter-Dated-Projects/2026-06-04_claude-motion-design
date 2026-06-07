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

import logging
import os
from pathlib import Path
from typing import NamedTuple

logger = logging.getLogger("rotoscoping.config")

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
#
# Larger VRAM warrants larger chunks (fewer init/reset cycles, slightly better
# throughput). The default 150 suits a 16GB card; an operator on a 24GB card can
# try ROTO_CHUNK_SIZE=300. No automatic per-GPU tuning -- this env override is
# the knob.
#
# Guarded: a non-numeric ROTO_CHUNK_SIZE would otherwise raise ValueError at
# import and take the whole service down before it can log anything useful; fall
# back to the default with a warning instead.
_DEFAULT_CHUNK_SIZE = 150
try:
    CHUNK_SIZE: int = int(os.environ.get("ROTO_CHUNK_SIZE", str(_DEFAULT_CHUNK_SIZE)))
except ValueError:
    logger.warning(
        "ROTO_CHUNK_SIZE=%r is not a valid integer; falling back to %d",
        os.environ.get("ROTO_CHUNK_SIZE"),
        _DEFAULT_CHUNK_SIZE,
    )
    CHUNK_SIZE = _DEFAULT_CHUNK_SIZE

# --- Filesystem layout -----------------------------------------------------

BASE_DIR: Path = Path(__file__).resolve().parent
MODELS_DIR: Path = BASE_DIR / "models"
BIN_DIR: Path = BASE_DIR / "bin"  # bundled ffmpeg.exe lands here on Windows
WORK_DIR: Path = BASE_DIR / ".work"  # per-job scratch (frames, partial output)
LOGS_DIR: Path = BASE_DIR / "logs"

for _d in (MODELS_DIR, BIN_DIR, WORK_DIR, LOGS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# --- SAM2 model ------------------------------------------------------------

# Per-job model-size selection (Option B). The service can swap between four SAM2
# sizes; a job names one via the `model_size` POST field, and the engine swaps the
# single resident predictor only when the requested size differs from what is
# loaded (see sam2_engine.load_predictor / decisions in the project doc).
#
# BUILD: we standardize on the original SAM2 *2.0* release (the `072824` URL date).
# That is what config defaulted to before this change, what the engine's API
# assumptions were written against, and the only build the existing base_plus path
# was verified-as-written for. To move to 2.1 instead, the WHOLE map changes in
# lockstep: 092824 URL date, `sam2.1_hiera_*.pt` checkpoints, and
# `configs/sam2.1/sam2.1_hiera_*.yaml` configs.
#
# NAMING SPLIT (load-bearing): the Hydra config uses the SHORT size code in its
# filename (`t`/`s`/`b+`/`l`) while the checkpoint uses the LONG name
# (`tiny`/`small`/`base_plus`/`large`). The triple (checkpoint_name, config_name,
# url) therefore must be spelled out per size -- you cannot derive one from the
# other. Configs are resolved from INSIDE the installed `sam2` package (hydra is
# initialized with config module "sam2"), so they are package-relative paths under
# `configs/sam2/`, not files on disk here.
#
# VERIFY: these must agree with the installed `sam2` package version on the CUDA
# box. base_plus and large match what config.py documented before this change.
_SAM2_URL_BASE: str = "https://dl.fbaipublicfiles.com/segment_anything_2/072824"
MODEL_SIZES: dict[str, tuple[str, str, str]] = {
    "tiny": (
        "sam2_hiera_tiny.pt",
        "configs/sam2/sam2_hiera_t.yaml",
        f"{_SAM2_URL_BASE}/sam2_hiera_tiny.pt",
    ),
    "small": (
        "sam2_hiera_small.pt",
        "configs/sam2/sam2_hiera_s.yaml",
        f"{_SAM2_URL_BASE}/sam2_hiera_small.pt",
    ),
    "base_plus": (
        "sam2_hiera_base_plus.pt",
        "configs/sam2/sam2_hiera_b+.yaml",
        f"{_SAM2_URL_BASE}/sam2_hiera_base_plus.pt",
    ),
    "large": (
        "sam2_hiera_large.pt",
        "configs/sam2/sam2_hiera_l.yaml",
        f"{_SAM2_URL_BASE}/sam2_hiera_large.pt",
    ),
}

# The size loaded at startup and used when a job omits `model_size` (backwards
# compatible: older clients send no size and get this). Override with
# ROTO_SAM2_SIZE; falls back to the long-standing base_plus default.
DEFAULT_MODEL_SIZE: str = os.environ.get("ROTO_SAM2_SIZE", "base_plus")
if DEFAULT_MODEL_SIZE not in MODEL_SIZES:
    logger.warning(
        "ROTO_SAM2_SIZE=%r is not a known size %s; falling back to base_plus",
        DEFAULT_MODEL_SIZE,
        sorted(MODEL_SIZES),
    )
    DEFAULT_MODEL_SIZE = "base_plus"


class ModelTriple(NamedTuple):
    """A resolved SAM2 model: its size label plus the three lockstep assets."""

    size: str
    checkpoint_name: str
    config_name: str
    url: str

    @property
    def checkpoint_path(self) -> Path:
        return MODELS_DIR / self.checkpoint_name

    @property
    def label(self) -> str:
        """Short label for /health + meta.json, e.g. 'sam2_hiera_base_plus'."""
        return Path(self.checkpoint_name).stem


def model_triple(size: str) -> ModelTriple:
    """Resolve a size name to its (checkpoint, config, url) triple.

    The legacy ROTO_SAM2_CHECKPOINT / _CONFIG / _CHECKPOINT_URL env vars still
    work, but ONLY as an override of the DEFAULT size's triple (backwards compat).
    Requesting any other size always uses the built-in map. Raises ValueError on
    an unknown size so the API layer can return a 400.
    """
    if size not in MODEL_SIZES:
        raise ValueError(
            f"unknown model_size {size!r}; valid sizes: {sorted(MODEL_SIZES)}"
        )
    checkpoint_name, config_name, url = MODEL_SIZES[size]
    if size == DEFAULT_MODEL_SIZE:
        checkpoint_name = os.environ.get("ROTO_SAM2_CHECKPOINT", checkpoint_name)
        config_name = os.environ.get("ROTO_SAM2_CONFIG", config_name)
        url = os.environ.get("ROTO_SAM2_CHECKPOINT_URL", url)
    return ModelTriple(size, checkpoint_name, config_name, url)


# Backwards-compatible module constants describing the DEFAULT (launched) model.
# Kept so any external reader of the old names still works; size-aware code calls
# model_triple(size) instead. MODEL_LABEL here is the launched size's label --
# /health reports the *resident* label via sam2_engine, which can differ after a
# swap.
_DEFAULT_TRIPLE: ModelTriple = model_triple(DEFAULT_MODEL_SIZE)
SAM2_CHECKPOINT_NAME: str = _DEFAULT_TRIPLE.checkpoint_name
SAM2_CONFIG_NAME: str = _DEFAULT_TRIPLE.config_name
SAM2_CHECKPOINT_URL: str = _DEFAULT_TRIPLE.url
MODEL_LABEL: str = _DEFAULT_TRIPLE.label
CHECKPOINT_PATH: Path = _DEFAULT_TRIPLE.checkpoint_path

# --- ffmpeg ----------------------------------------------------------------

# Static Windows build, pulled into bin/ only when ffmpeg is not already on
# PATH. gyan.dev publishes the canonical static Windows builds.
FFMPEG_WINDOWS_URL: str = os.environ.get(
    "ROTO_FFMPEG_WINDOWS_URL",
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
)
