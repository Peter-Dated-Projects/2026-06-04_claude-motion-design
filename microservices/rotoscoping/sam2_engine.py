"""SAM2 video-predictor engine.

The predictor is built ONCE at startup (`load_predictor`) so /health can report
it as loaded and every job reuses the in-VRAM model. Each job:

  1. init_state on the extracted frame directory
  2. add_new_points_or_box(frame_idx=0, ...) for the multi-point prompt
  3. propagate_in_video under inference_mode + autocast(probe-selected dtype)
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
import math
import os
import shutil
import tempfile
import tracemalloc
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

# How often, in propagation frames, to emit a memory snapshot. The per-frame
# loop runs over every source frame, so logging each one would flood the file;
# every 50th gives a usable VRAM/CPU growth curve without the noise.
_MEM_LOG_EVERY_N_FRAMES = 50

_GB = 1024**3


def log_memory(log: logging.Logger, label: str) -> None:
    """Log a CUDA + CPU memory snapshot at INFO under `label`.

    CUDA figures come from torch.cuda.memory_allocated/reserved and are guarded
    by torch.cuda.is_available() so this is a no-op-ish line on a CPU-only dev
    box (it still logs the CPU side). CPU figures come from tracemalloc, which
    must already be tracing (started in the job entry point); if it is not, the
    CPU portion is omitted rather than reporting a misleading 0.
    """
    parts: list[str] = []
    if torch.cuda.is_available():
        allocated = torch.cuda.memory_allocated() / _GB
        reserved = torch.cuda.memory_reserved() / _GB
        parts.append(f"cuda_alloc={allocated:.2f}GB cuda_reserved={reserved:.2f}GB")
    else:
        parts.append("cuda=unavailable")
    if tracemalloc.is_tracing():
        current, peak = tracemalloc.get_traced_memory()
        parts.append(f"cpu_current={current / _GB:.2f}GB cpu_peak={peak / _GB:.2f}GB")
    log.info("[mem] %s: %s", label, " ".join(parts))

# Module-level predictor, populated by load_predictor() at startup.
_predictor = None

# One-time GPU configuration profile, populated by load_predictor() via
# _probe_gpu(). Holds the autocast dtype, TF32 setting, and JSON-safe labels for
# /health. None until the probe has run.
_GPU_PROFILE: Optional[dict] = None


def _probe_gpu() -> dict:
    """Probe the CUDA GPU and return a configuration profile.

    Raises RuntimeError if no CUDA device is available (Mac/CPU-only), which the
    startup sequence in main.py catches to log + exit cleanly. Selects the
    autocast dtype and TF32 setting by GPU generation. Developed on a Mac without
    CUDA, so the per-generation paths here could not be executed; VERIFY on the
    target box.
    """
    if not torch.cuda.is_available():
        raise RuntimeError(
            "No CUDA device found. This service requires a CUDA-capable GPU. "
            "Mac and CPU-only runs are not supported."
        )
    props = torch.cuda.get_device_properties(0)
    major, minor = props.major, props.minor
    name = props.name
    vram_gb = props.total_memory / (1024**3)

    # Compute capability -> generation mapping (NVIDIA convention):
    #   sm_60-61: Pascal (10-series)
    #   sm_70-72: Volta (Titan V, V100)
    #   sm_75: Turing (16-series, 20-series)
    #   sm_80-86: Ampere (30-series, A-series)
    #   sm_89: Ada (40-series)
    #   sm_90: Hopper (H100, H200)
    #   sm_100+: Blackwell (50-series, GB200)
    if major >= 10:
        generation = "blackwell"  # RTX 5000-series / GB200
    elif major == 9:
        generation = "hopper"  # H100, H200 -- bfloat16 + FlashAttn
    elif major == 8 and minor == 9:
        generation = "ada"  # RTX 4000-series
    elif major == 8:
        generation = "ampere"  # RTX 3000-series
    elif major == 7 and minor == 5:
        generation = "turing"
    else:
        generation = "legacy"

    # Dtype selection: bfloat16 is preferred on Ampere+ (hardware-accelerated);
    # Turing supports fp16 but not bfloat16 in hardware; legacy falls back to fp32.
    if generation in ("blackwell", "hopper", "ada", "ampere"):
        dtype = torch.bfloat16
    elif generation == "turing":
        dtype = torch.float16
    else:
        dtype = torch.float32

    # TF32: enabled by default on Ampere+, but explicitly set here so the log is
    # authoritative. Turing and below do not support TF32.
    use_tf32 = generation in ("blackwell", "hopper", "ada", "ampere")
    torch.backends.cuda.matmul.allow_tf32 = use_tf32
    torch.backends.cudnn.allow_tf32 = use_tf32

    # dtype_str is a JSON-safe label used in /health and logging; torch.dtype
    # objects are not JSON-serializable so never put `dtype` directly in a
    # response dict that gets json.dumps'd.
    dtype_str = str(dtype).replace("torch.", "")  # e.g. "bfloat16"

    logger.info(
        "GPU probe: %s (sm_%d%d, %s, %.1f GB VRAM) | dtype=%s tf32=%s",
        name,
        major,
        minor,
        generation,
        vram_gb,
        dtype_str,
        use_tf32,
    )
    return {
        "name": name,
        "generation": generation,
        "compute_capability": [major, minor],  # list, not tuple, for JSON safety
        "vram_gb": round(vram_gb, 1),
        "dtype": dtype,  # torch.dtype -- for internal use (autocast)
        "dtype_str": dtype_str,  # str -- for /health JSON response
    }


def _gpu_dtype() -> "torch.dtype":
    """Autocast dtype chosen by the GPU probe; bfloat16 until the probe has run.

    run_job calls load_predictor() (which runs the probe) before opening the
    autocast block, so in practice the profile is always populated by then; the
    bfloat16 default is just a defensive fallback.
    """
    if _GPU_PROFILE is not None:
        return _GPU_PROFILE["dtype"]
    return torch.bfloat16


def gpu_profile() -> Optional[dict]:
    """JSON-safe GPU profile for the /health response, or None if not yet probed.

    Excludes the raw `dtype` torch.dtype object (not JSON-serializable); callers
    json.dumps this directly.
    """
    if _GPU_PROFILE is None:
        return None
    return {
        "name": _GPU_PROFILE["name"],
        "generation": _GPU_PROFILE["generation"],
        "compute_capability": _GPU_PROFILE["compute_capability"],
        "vram_gb": _GPU_PROFILE["vram_gb"],
        "dtype_str": _GPU_PROFILE["dtype_str"],
    }


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
    global _predictor, _GPU_PROFILE
    if _predictor is not None:
        return _predictor

    from sam2.build_sam import build_sam2_video_predictor

    # One-time GPU probe before the build: picks the autocast dtype + TF32 and
    # gates FlashAttention. Raises RuntimeError on a non-CUDA box; startup
    # catches it to exit cleanly.
    _GPU_PROFILE = _probe_gpu()

    # FlashAttention-2 / SDPA is available on Ada (sm_89), Hopper (sm_90) and
    # Blackwell (sm_100+); Ampere and below default to standard attention.
    # VERIFY: that build_sam2_video_predictor accepts use_flash_attn on the
    # installed sam2 build (added with the GPU probe, never run on this Mac).
    use_flash = _GPU_PROFILE["generation"] in ("ada", "hopper", "blackwell")
    logger.info(
        "Building SAM2 predictor (config=%s checkpoint=%s use_flash_attn=%s)",
        config.SAM2_CONFIG_NAME,
        config.CHECKPOINT_PATH,
        use_flash,
    )
    try:
        _predictor = build_sam2_video_predictor(
            config.SAM2_CONFIG_NAME,
            str(config.CHECKPOINT_PATH),
            device="cuda",
            use_flash_attn=use_flash,
        )
    except ImportError:
        # flash-attn package not installed; the build tried to import it because
        # use_flash_attn=True. Rebuild with use_flash_attn=False, which skips the
        # import path entirely. Catch ImportError SPECIFICALLY, not bare
        # Exception, so genuine SAM2 build errors (wrong checkpoint path, config
        # mismatch) still surface.
        logger.warning(
            "flash-attn not available on this system; building without FlashAttention"
        )
        _predictor = build_sam2_video_predictor(
            config.SAM2_CONFIG_NAME,
            str(config.CHECKPOINT_PATH),
            device="cuda",
            use_flash_attn=False,
        )
    except TypeError as exc:
        # The installed sam2 build's build_sam2_video_predictor signature doesn't
        # accept use_flash_attn at all (the kwarg was added with the GPU probe and
        # is unverified on this Mac). Passing use_flash_attn=False would raise the
        # SAME TypeError, so the fallback must OMIT the kwarg entirely. Without
        # this arm the build raises on exactly the flash-capable GPUs
        # (Ada/Hopper/Blackwell) this targets, and main.py's lifespan handler only
        # catches RuntimeError -> ungraceful startup crash.
        logger.warning(
            "build_sam2_video_predictor does not accept use_flash_attn "
            "(signature mismatch: %s); building without it",
            exc,
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
    source_frame_idx: int,
) -> None:
    """Composite the original frame RGB with the mask alpha -> RGBA PNG.

    `frame_idx` is the chunk-local index used to read the source JPEG from
    `frames_dir`. `source_frame_idx` is the globally-unique index used for the
    output filename, so concurrent chunks never clobber each other's output.
    Output is named frame_{source_frame_idx+1:04d}.png (1-based).
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
    out_path = output_dir / f"frame_{source_frame_idx + 1:04d}.png"
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

    Propagation runs in chunks of config.CHUNK_SIZE frames. Between chunks,
    state is reset and the CUDA cache is freed so that peak CPU RAM is bounded
    regardless of clip length. The mask from each chunk's last frame is carried
    forward to seed the next chunk's prompt.
    """
    predictor = load_predictor()

    pts = [[float(p["x"]), float(p["y"])] for p in points]
    labels = [int(p["label"]) for p in points]

    job.update(stage="loading", progress=0.05, frames_total=total_frames)

    num_chunks = math.ceil(total_frames / config.CHUNK_SIZE) if total_frames else 1
    global_frames_processed = 0
    written = 0
    carry_mask: Optional[np.ndarray] = None  # CPU bool (H,W) from prior chunk
    state = None
    current_chunk_dir: Optional[Path] = None

    try:
        with torch.inference_mode(), torch.autocast("cuda", dtype=_gpu_dtype()):
            job.update(stage="segmenting", progress=0.1)

            for chunk_idx in range(num_chunks):
                chunk_start = chunk_idx * config.CHUNK_SIZE
                chunk_end = min(chunk_start + config.CHUNK_SIZE, total_frames)
                chunk_frames = chunk_end - chunk_start

                chunk_dir = Path(
                    tempfile.mkdtemp(
                        dir=frames_dir.parent, prefix=f"chunk_{chunk_idx}_"
                    )
                )
                current_chunk_dir = chunk_dir

                try:
                    # Populate the chunk sub-dir with this chunk's frames,
                    # renamed to a contiguous 00000.jpg sequence so SAM2's
                    # frame loader sees them as a self-contained clip.
                    # Linux/macOS: symlink (zero-copy). Windows: shallow copy
                    # (NTFS symlinks require elevation).
                    for local_idx in range(chunk_frames):
                        src = frames_dir / f"{chunk_start + local_idx:05d}.jpg"
                        dst = chunk_dir / f"{local_idx:05d}.jpg"
                        if os.name == "nt":
                            shutil.copy2(src, dst)
                        else:
                            dst.symlink_to(src)

                    # Offload flags (SAM2 v1.0 API): keep decoded frames and
                    # the per-frame memory bank on CPU. VERIFY on CUDA.
                    state = predictor.init_state(
                        str(chunk_dir),
                        offload_video_to_cpu=True,
                        offload_state_to_cpu=True,
                        async_loading_frames=True,
                    )
                    log_memory(logger, f"after init_state chunk {chunk_idx}")

                    if job.cancelled:
                        raise RotoscopeCancelled(
                            f"job cancelled before chunk {chunk_idx} prompt"
                        )

                    if chunk_idx == 0 or carry_mask is None:
                        predictor.add_new_points_or_box(
                            state,
                            frame_idx=0,
                            obj_id=_OBJ_ID,
                            points=pts,
                            labels=labels,
                        )
                    else:
                        # Seed with the carry mask from the prior chunk's last
                        # frame. add_new_mask was added in later SAM2 builds;
                        # fall back to the point prompt if it's absent.
                        try:
                            predictor.add_new_mask(state, 0, _OBJ_ID, carry_mask)
                        except AttributeError:
                            predictor.add_new_points_or_box(
                                state,
                                frame_idx=0,
                                obj_id=_OBJ_ID,
                                points=pts,
                                labels=labels,
                            )

                    log_memory(logger, f"after prompt chunk {chunk_idx}")
                    if job.cancelled:
                        raise RotoscopeCancelled(
                            f"job cancelled after chunk {chunk_idx} prompt"
                        )

                    last_mask_logits = None

                    for chunk_local_idx, _obj_ids, mask_logits in (
                        predictor.propagate_in_video(state)
                    ):
                        if job.cancelled:
                            raise RotoscopeCancelled(
                                "job cancelled during propagation"
                            )

                        source_frame_idx = chunk_start + chunk_local_idx
                        global_frames_processed += 1
                        last_mask_logits = mask_logits

                        if source_frame_idx % _MEM_LOG_EVERY_N_FRAMES == 0:
                            log_memory(
                                logger, f"propagation frame {source_frame_idx}"
                            )

                        if source_frame_idx % (frame_skip + 1) != 0:
                            continue

                        _save_transparent_png(
                            chunk_local_idx,
                            mask_logits,
                            chunk_dir,
                            output_dir,
                            source_frame_idx,
                        )
                        written += 1

                        progress = 0.1 + 0.85 * (
                            global_frames_processed / total_frames
                            if total_frames
                            else 0.0
                        )
                        job.update(
                            stage="segmenting",
                            progress=min(progress, 0.95),
                            frames_done=written,
                        )
                        if on_progress is not None:
                            on_progress()

                    # Carry the last frame's mask into the next chunk as a CPU
                    # bool array so we can free the GPU tensor immediately.
                    if last_mask_logits is not None:
                        logits = last_mask_logits[0]
                        while logits.dim() > 2:
                            logits = logits[0]
                        carry_mask = (logits > 0.0).cpu().numpy()

                finally:
                    # Reset per-chunk state and free the memory bank before the
                    # next chunk init_state allocates a new one.
                    if state is not None:
                        try:
                            predictor.reset_state(state)
                        except Exception:  # pragma: no cover
                            logger.exception(
                                "reset_state failed for chunk %d of job %s",
                                chunk_idx,
                                job.job_id,
                            )
                        state = None
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    log_memory(logger, f"after reset_state chunk {chunk_idx}")

                    shutil.rmtree(chunk_dir, ignore_errors=True)
                    current_chunk_dir = None

        job.update(stage="packaging", progress=0.97, frames_done=written)
        return written

    except torch.cuda.OutOfMemoryError as exc:  # type: ignore[attr-defined]
        logger.exception("CUDA OOM during rotoscoping job %s", job.job_id)
        raise RotoscopeOOMError(
            "GPU ran out of memory. Try a shorter clip or a higher frame skip."
        ) from exc
    finally:
        # Safety net: reset state and clean up chunk dir if an exception
        # bypassed the inner finally (e.g. RotoscopeCancelled during symlink
        # setup before init_state was called).
        if state is not None:
            try:
                predictor.reset_state(state)
            except Exception:  # pragma: no cover
                logger.exception("reset_state failed in outer finally for job %s", job.job_id)
        if current_chunk_dir is not None:
            shutil.rmtree(current_chunk_dir, ignore_errors=True)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        log_memory(logger, "after job finally")
