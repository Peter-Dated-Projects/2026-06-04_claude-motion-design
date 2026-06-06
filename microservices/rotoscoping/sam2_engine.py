"""SAM2 video-predictor engine.

The predictor is built ONCE at startup (`load_predictor`) so /health can report
it as loaded and every job reuses the in-VRAM model. Each job:

  1. init_state on the extracted frame directory
  2. add_new_points_or_box(frame_idx=0, ...) for the multi-point prompt
  3. propagate_in_video under inference_mode + autocast(bfloat16)
  4. for frames where `frame_idx % (frame_skip+1) == 0`, composite the original
     RGB frame with the predicted mask as alpha -> RGBA PNG
  5. reset_state in a finally block, ALWAYS (prevents VRAM accumulation)

CUDA OOM is caught, state is reset, and a RotoscopeOOMError is raised so the API
layer can return a 500 suggesting a shorter clip or higher frame skip.

VERSION-SENSITIVE: the build call uses SAM2_CONFIG_NAME / CHECKPOINT_PATH from
config.py. If you bump the sam-2 package, re-verify those names there -- this
module never hardcodes them. Developed on a Mac without CUDA, so the GPU paths
here could not be executed; assumptions are flagged with VERIFY comments.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import torch
from PIL import Image

import config
from job_registry import Job

logger = logging.getLogger("rotoscoping.sam2")

# Single object id used for the prompt. SAM2's add_new_points_or_box requires an
# obj_id; we segment one subject, so a constant id is sufficient.
_OBJ_ID = 1

# Module-level predictor, populated by load_predictor() at startup.
_predictor = None


class RotoscopeOOMError(RuntimeError):
    """CUDA ran out of memory during propagation."""


class RotoscopeCancelled(RuntimeError):
    """The job was cancelled mid-propagation."""


def load_predictor():
    """Build the SAM2 video predictor once and cache it. Returns the predictor.

    Imported lazily so the module imports cleanly on a machine without the CUDA
    torch build (e.g. the Mac dev box) -- import main works; only startup, which
    calls this, requires CUDA.
    """
    global _predictor
    if _predictor is not None:
        return _predictor

    from sam2.build_sam import build_sam2_video_predictor

    logger.info(
        "Building SAM2 predictor (config=%s checkpoint=%s)",
        config.SAM2_CONFIG_NAME,
        config.CHECKPOINT_PATH,
    )
    _predictor = build_sam2_video_predictor(
        config.SAM2_CONFIG_NAME,
        str(config.CHECKPOINT_PATH),
        device="cuda",
    )
    logger.info("SAM2 predictor loaded")
    return _predictor


def is_loaded() -> bool:
    return _predictor is not None


def vram_stats() -> tuple[float, float]:
    """Return (used_gb, total_gb) for the active CUDA device.

    Uses torch.cuda.mem_get_info (free, total); used = total - free. Reported by
    /health. Returns (0.0, 0.0) if CUDA is unavailable so /health never raises.
    """
    if not torch.cuda.is_available():
        return 0.0, 0.0
    free_bytes, total_bytes = torch.cuda.mem_get_info()
    used_bytes = total_bytes - free_bytes
    gb = 1024**3
    return round(used_bytes / gb, 2), round(total_bytes / gb, 2)


def _mask_to_alpha(mask_logits: torch.Tensor) -> np.ndarray:
    """Convert SAM2 mask logits for one object into a uint8 alpha array (H, W).

    propagate_in_video yields per-frame mask logits shaped (num_objs, 1, H, W)
    or (num_objs, H, W). We take the first (only) object, threshold at 0, and
    scale to 0/255. VERIFY: confirm the leading/extra dims against the installed
    sam2 build if alpha comes out empty or transposed.
    """
    logits = mask_logits[0]
    # Drop a leading singleton channel dim if present -> (H, W).
    while logits.dim() > 2:
        logits = logits[0]
    binary = (logits > 0.0).to(torch.uint8).cpu().numpy()
    return (binary * 255).astype(np.uint8)


def _save_transparent_png(
    frame_idx: int,
    mask_logits: torch.Tensor,
    frames_dir: Path,
    output_dir: Path,
) -> None:
    """Composite the original frame RGB with the mask alpha -> RGBA PNG.

    Output is named frame_{idx+1:04d}.png (1-based), per the proposal's
    IMPLEMENTATION code. The source frame was extracted as {idx:05d}.jpg.
    """
    src_frame = frames_dir / f"{frame_idx:05d}.jpg"
    rgb = Image.open(src_frame).convert("RGB")

    alpha_arr = _mask_to_alpha(mask_logits)
    alpha = Image.fromarray(alpha_arr, mode="L")
    # Guard against any size mismatch between mask and source frame.
    if alpha.size != rgb.size:
        alpha = alpha.resize(rgb.size, Image.NEAREST)

    rgba = rgb.convert("RGBA")
    rgba.putalpha(alpha)

    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / f"frame_{frame_idx + 1:04d}.png"
    rgba.save(out_path, format="PNG")


def run_job(
    job: Job,
    frames_dir: Path,
    output_dir: Path,
    points: list[dict],
    frame_skip: int,
    total_frames: int,
    on_progress: Optional[Callable[[], None]] = None,
) -> int:
    """Run rotoscoping for one job. Returns the number of PNG frames written.

    `points` is the multi-point prompt: list of {x, y, label} (label 1=fg,
    0=bg). `frame_skip` controls output decimation; SAM2 still propagates over
    every frame for mask quality, we only write every (frame_skip+1)th.
    """
    predictor = load_predictor()

    pts = [[float(p["x"]), float(p["y"])] for p in points]
    labels = [int(p["label"]) for p in points]

    job.update(stage="loading", progress=0.05, frames_total=total_frames)

    state = None
    written = 0
    try:
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            state = predictor.init_state(str(frames_dir))

            predictor.add_new_points_or_box(
                state,
                frame_idx=0,
                obj_id=_OBJ_ID,
                points=pts,
                labels=labels,
            )

            job.update(stage="segmenting", progress=0.1)

            for frame_idx, _obj_ids, mask_logits in predictor.propagate_in_video(
                state
            ):
                if job.cancelled:
                    raise RotoscopeCancelled("job cancelled during propagation")

                if frame_idx % (frame_skip + 1) != 0:
                    continue

                _save_transparent_png(
                    frame_idx, mask_logits, frames_dir, output_dir
                )
                written += 1

                progress = 0.1 + 0.85 * (
                    (frame_idx + 1) / total_frames if total_frames else 0.0
                )
                job.update(
                    stage="segmenting",
                    progress=min(progress, 0.95),
                    frames_done=written,
                )
                if on_progress is not None:
                    on_progress()

        job.update(stage="packaging", progress=0.97, frames_done=written)
        return written

    except torch.cuda.OutOfMemoryError as exc:  # type: ignore[attr-defined]
        logger.exception("CUDA OOM during rotoscoping job %s", job.job_id)
        raise RotoscopeOOMError(
            "GPU ran out of memory. Try a shorter clip or a higher frame skip."
        ) from exc
    finally:
        # reset_state ALWAYS -- without it VRAM grows unboundedly across jobs.
        if state is not None:
            try:
                predictor.reset_state(state)
            except Exception:  # pragma: no cover - defensive cleanup
                logger.exception("reset_state failed for job %s", job.job_id)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
