"""ffmpeg / ffprobe resolution and video pre-processing.

SAM2's `init_state` consumes a directory of JPEG frames, so this module's job is
to (1) locate working ffmpeg + ffprobe binaries -- preferring whatever is on
PATH, and on Windows downloading a static build into `bin/` if nothing is there
-- and (2) probe the clip and extract every frame to a temp JPEG directory.

All paths go through pathlib; nothing assumes a separator. Binary discovery is
cached so we resolve once per process.
"""

from __future__ import annotations

import json
import logging
import platform
import shutil
import subprocess
import zipfile
from functools import lru_cache
from pathlib import Path
from urllib.request import urlopen

import config

logger = logging.getLogger("rotoscoping.ffmpeg")

_IS_WINDOWS = platform.system() == "Windows"
_EXE_SUFFIX = ".exe" if _IS_WINDOWS else ""


class FfmpegError(RuntimeError):
    """ffmpeg/ffprobe could not be resolved or a subprocess failed."""


def _bundled_path(name: str) -> Path:
    """Path inside bin/ where a bundled binary lives once downloaded."""
    return config.BIN_DIR / f"{name}{_EXE_SUFFIX}"


def _download_windows_ffmpeg() -> None:
    """Fetch the static Windows ffmpeg build into bin/ (ffmpeg + ffprobe).

    Only ever called on Windows when neither PATH nor bin/ has the binaries.
    The gyan.dev release zip nests the executables under
    `<archive>/bin/ffmpeg.exe`; we flatten them directly into config.BIN_DIR.
    """
    config.BIN_DIR.mkdir(parents=True, exist_ok=True)
    archive = config.BIN_DIR / "ffmpeg-download.zip"

    logger.info("Downloading static ffmpeg build from %s", config.FFMPEG_WINDOWS_URL)
    with urlopen(config.FFMPEG_WINDOWS_URL) as resp, archive.open("wb") as out:
        shutil.copyfileobj(resp, out)

    with zipfile.ZipFile(archive) as zf:
        for member in zf.namelist():
            member_name = Path(member).name.lower()
            if member_name in ("ffmpeg.exe", "ffprobe.exe"):
                target = config.BIN_DIR / Path(member).name
                with zf.open(member) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                logger.info("Extracted %s", target)

    archive.unlink(missing_ok=True)


def _resolve(name: str) -> str:
    """Resolve a binary by name: PATH first, then bin/, then (Windows) download.

    Raises FfmpegError on non-Windows platforms when the binary is missing,
    because we never auto-download for Mac/Linux (the proposal bundles ffmpeg on
    the Tauri side there; the microservice itself targets Windows).
    """
    on_path = shutil.which(name)
    if on_path:
        return on_path

    bundled = _bundled_path(name)
    if bundled.exists():
        return str(bundled)

    if _IS_WINDOWS:
        _download_windows_ffmpeg()
        if bundled.exists():
            return str(bundled)
        raise FfmpegError(
            f"{name} not found on PATH and download did not produce {bundled}"
        )

    raise FfmpegError(
        f"{name} not found on PATH. On non-Windows the microservice does not "
        f"auto-download ffmpeg; install it or add it to PATH."
    )


@lru_cache(maxsize=1)
def resolve_ffmpeg() -> str:
    return _resolve("ffmpeg")


@lru_cache(maxsize=1)
def resolve_ffprobe() -> str:
    return _resolve("ffprobe")


def probe_video(video_path: Path) -> tuple[float, float]:
    """Return (duration_seconds, fps) for the given video via ffprobe.

    fps is parsed from the stream's `r_frame_rate` ("30000/1001" -> 29.97).
    Duration prefers the format-level duration, falling back to the stream's.
    """
    ffprobe = resolve_ffprobe()
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate,duration:format=duration",
        "-of",
        "json",
        str(video_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise FfmpegError(f"ffprobe failed: {result.stderr.strip()}")

    data = json.loads(result.stdout)
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format") or {}

    fps = _parse_frame_rate(stream.get("r_frame_rate"))

    duration_raw = fmt.get("duration") or stream.get("duration")
    if duration_raw is None:
        raise FfmpegError("ffprobe returned no duration for the video")
    duration = float(duration_raw)

    return duration, fps


def _parse_frame_rate(rate: str | None) -> float:
    """Parse an ffprobe r_frame_rate like '30000/1001' into a float fps."""
    if not rate or rate == "0/0":
        raise FfmpegError("ffprobe returned no frame rate for the video")
    if "/" in rate:
        num, den = rate.split("/", 1)
        den_f = float(den)
        if den_f == 0:
            raise FfmpegError(f"invalid frame rate from ffprobe: {rate}")
        return float(num) / den_f
    return float(rate)


def extract_frames(
    video_path: Path,
    frames_dir: Path,
    scale: tuple[int, int] | None = None,
) -> int:
    """Extract every frame of the clip to JPEGs in frames_dir, return the count.

    SAM2's init_state expects a directory of zero-padded JPEG frames named
    `00000.jpg`, `00001.jpg`, ... starting at 0. We extract ALL frames; the
    frame_skip decimation happens later, during PNG output, so SAM2 still
    propagates across the full sequence for mask quality.

    When `scale` is given as `(width, height)`, frames are resized at extraction
    time via `-vf scale=W:H` -- this is the section-1 memory win: SAM2 then
    init_states + propagates over the smaller frames instead of source-resolution
    ones. Omit it (None) to extract at the source resolution.

    # VERIFY: the resolution chosen in the client controls (rotoStore.resolution)
    # is not yet threaded to this call. TODO(submit-wiring): main.py's run_job
    # should pass the requested (width, height) here once the rotoscope_video
    # contract carries it (out of scope for this ticket -- main.py is untouched).
    """
    frames_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = resolve_ffmpeg()
    pattern = str(frames_dir / "%05d.jpg")
    cmd = [
        ffmpeg,
        "-v",
        "error",
        "-i",
        str(video_path),
        "-start_number",
        "0",
        "-q:v",
        "2",
    ]
    if scale is not None:
        width, height = scale
        cmd += ["-vf", f"scale={width}:{height}"]
    cmd.append(pattern)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise FfmpegError(f"ffmpeg frame extraction failed: {result.stderr.strip()}")

    count = sum(1 for _ in frames_dir.glob("*.jpg"))
    if count == 0:
        raise FfmpegError("ffmpeg produced no frames from the video")
    return count
