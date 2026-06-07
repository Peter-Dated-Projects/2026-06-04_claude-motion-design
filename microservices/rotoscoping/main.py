"""Rotoscoping microservice -- FastAPI app.

Runs SAM2 on a local CUDA GPU to turn a clipped video into a transparent PNG
sequence. Four endpoints (exact contract in
.charm/proposals/PROPOSAL-rotoscoping-microservice.md):

  GET    /health                        -> service + model + VRAM status
  POST   /rotoscope                     -> launch a job, return 202 + job_id
  GET    /rotoscope/{job_id}/progress   -> SSE progress snapshots
  GET    /rotoscope/{job_id}/result     -> the output ZIP once the job is done
  DELETE /rotoscope/{job_id}            -> cancel an in-flight job

Design note: the job_id is CLIENT-SUPPLIED in the POST form so the client can
open the progress SSE stream before POSTing. The POST validates, saves the
upload, probes duration, then launches the segmentation as a background task and
returns 202 immediately -- it does NOT hold the HTTP connection open for the
multi-minute GPU job. Progress flows over the SSE stream; the result ZIP is
fetched separately from /result. The blocking job body runs in a worker thread
(asyncio.to_thread) so the event loop stays free; one GPU -> jobs are serialized
by GPU_LOCK, so concurrent POSTs queue correctly.

Entry point is `uv run main.py`. Refuses to start without CUDA (no CPU
fallback). Developed on a Mac (no CUDA): GPU paths could not be executed here.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
import tracemalloc
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable, Optional
from urllib.request import urlopen

import torch
import uvicorn
from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

import config
import ffmpeg_helper
import sam2_engine
from job_registry import GPU_LOCK, Job, registry
from logging_setup import configure_logging

logger = configure_logging()


# --- startup helpers -------------------------------------------------------


def _require_cuda() -> None:
    """Refuse to run without CUDA. Never silently fall back to CPU."""
    if not torch.cuda.is_available():
        logger.error(
            "CUDA is not available. This service requires an NVIDIA GPU with "
            "CUDA 12.8 (sm_120 / Blackwell) and a cu128 torch build. Refusing "
            "to start -- it will not fall back to CPU."
        )
        raise RuntimeError("CUDA unavailable; refusing to start")


def _ensure_weights(
    triple: config.ModelTriple,
    *,
    on_progress: Optional[Callable[[float], None]] = None,
    cancelled: Optional[Callable[[], bool]] = None,
) -> bool:
    """Download `triple`'s checkpoint to models/ if missing. Returns True if a
    download happened, False if it was already present.

    Streams in 1 MiB chunks so a job can report the download fraction over its SSE
    progress stream and abort promptly on cancel. Writes to a `.part` temp then
    atomically replaces, so an interrupted download never leaves a truncated file
    that later looks "present". All downloaded checkpoints are kept cached under
    models/ -- never evicted.
    """
    path = triple.checkpoint_path
    if path.exists():
        logger.info("SAM2 checkpoint present at %s", path)
        return False
    config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("Downloading SAM2 checkpoint from %s -> %s", triple.url, path)
    tmp = path.with_suffix(path.suffix + ".part")
    try:
        with urlopen(triple.url) as resp:  # noqa: S310 - fixed fbaipublicfiles URL
            total = int(resp.headers.get("Content-Length") or 0)
            downloaded = 0
            last_tick = 0.0
            with tmp.open("wb") as out:
                while True:
                    if cancelled is not None and cancelled():
                        raise sam2_engine.RotoscopeCancelled(
                            "cancelled during model download"
                        )
                    chunk = resp.read(1 << 20)  # 1 MiB
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    if on_progress is not None and total:
                        frac = min(downloaded / total, 1.0)
                        # Tick at ~1% granularity to bound SSE churn (the stream
                        # also dedups identical snapshots before emitting).
                        if frac - last_tick >= 0.01 or frac >= 1.0:
                            last_tick = frac
                            on_progress(frac)
        tmp.replace(path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    logger.info("SAM2 checkpoint downloaded (%s)", triple.label)
    return True


# --- per-job model selection -----------------------------------------------
#
# These exact stage strings ride the EXISTING GET /rotoscope/{job_id}/progress SSE
# stream AHEAD of the frame stages; the frontend (model-size selector tickets) must
# match them VERBATIM:
#   "downloading_model" -- progress = checkpoint download fraction (0..1), ticked at
#                          ~1% granularity. Emitted only when the requested size's
#                          checkpoint is missing and must be fetched (one-time/size).
#   "loading_model"     -- the predictor is being (re)built into VRAM for the swap;
#                          no numeric progress (held at the prior value).
#   "queued"            -- a job waiting behind GPU_LOCK while another job/swap is in
#                          flight. This is the Job default stage (job_registry), so
#                          nothing extra is emitted -- the snapshot already reads
#                          "queued" until the job acquires the lock.
_STAGE_DOWNLOADING_MODEL = "downloading_model"
_STAGE_LOADING_MODEL = "loading_model"


def _ensure_model_for_job(job: Job, model_size: str) -> None:
    """Make `model_size` the resident SAM2 model, downloading + swapping if needed.

    MUST be called holding GPU_LOCK (it is -- from _run_job_blocking), so the swap
    is serialized ahead of this job's GPU work and never races an in-flight job
    (decision 4). When the requested size is already resident this is a no-op: no
    download, no reload -- the warm predictor is reused (decision 2), so repeated
    jobs at one size stay exactly as fast as before.
    """
    if sam2_engine.is_loaded() and sam2_engine.resident_size() == model_size:
        logger.info("Model %s already resident; reusing warm predictor", model_size)
        return

    triple = config.model_triple(model_size)
    # Download the checkpoint if missing (one-time per size). Surfaces as the
    # downloading_model stage with a 0..1 fraction.
    if not triple.checkpoint_path.exists():
        job.update(stage=_STAGE_DOWNLOADING_MODEL, progress=0.0)
        _ensure_weights(
            triple,
            on_progress=lambda frac: job.update(
                stage=_STAGE_DOWNLOADING_MODEL, progress=frac
            ),
            cancelled=lambda: job.cancelled,
        )

    if job.cancelled:
        raise sam2_engine.RotoscopeCancelled("cancelled before model load")

    # Swap the resident predictor to the requested size. VRAM headroom for `large`
    # on a smaller card is NOT pre-checked: attempt the load and let a CUDA OOM
    # surface as a clear job error rather than second-guessing the card up front.
    job.update(stage=_STAGE_LOADING_MODEL)
    sam2_engine.load_predictor(model_size)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _require_cuda()
    # Pre-fetch the launched/default size so a no-size job is warm immediately.
    # Other sizes download lazily on first use (decision: keep all cached).
    _ensure_weights(config.model_triple(config.DEFAULT_MODEL_SIZE))
    # Load the predictor once so /health reports it and jobs reuse it. The GPU
    # probe inside raises RuntimeError on a non-CUDA box (Mac/CPU); treat that as
    # fatal -- log CRITICAL and exit rather than serving a permanently-broken
    # process. (_require_cuda above is the earlier safety net; this guards the
    # probe path specifically.)
    try:
        sam2_engine.load_predictor()
    except RuntimeError:
        logger.critical(
            "FATAL: This rotoscoping service requires a CUDA GPU. Mac (MPS) and "
            "CPU-only environments are not supported. Exiting."
        )
        raise SystemExit(1)
    logger.info("Rotoscoping service ready on %s:%s", config.HOST, config.PORT)
    yield
    logger.info("Rotoscoping service shutting down")


app = FastAPI(title="ClaudeMotion Rotoscoping", lifespan=lifespan)

# Strong references to in-flight background job tasks. asyncio only holds a weak
# reference to a bare create_task result, so without this the fire-and-forget
# job task can be garbage-collected mid-flight. Tasks remove themselves on done.
_BACKGROUND_TASKS: set[asyncio.Task] = set()


# --- endpoints -------------------------------------------------------------


@app.get("/health")
async def health() -> dict:
    used_gb, total_gb = sam2_engine.vram_stats()
    body = {
        "status": "ok" if sam2_engine.is_loaded() else "loading",
        # Resident model label -- reflects the current size after a per-job swap,
        # not just the launched default.
        "model": sam2_engine.model_label(),
        "vram_used_gb": used_gb,
        "vram_total_gb": total_gb,
    }
    # JSON-safe GPU probe (name/generation/compute_capability/vram_gb/dtype_str);
    # absent until the predictor has loaded. Never the raw torch.dtype.
    profile = sam2_engine.gpu_profile()
    if profile is not None:
        body["gpu_profile"] = profile
    return body


def _zip_output(output_dir: Path, zip_path: Path) -> None:
    """Zip the PNG sequence into zip_path, plus the composed video and archived
    source clip when present.

    The `frame_*.png` sequence is the guaranteed primary artifact. `output.webm`
    (the composed transparent video) and `source_clip.mp4` (the archived source)
    are written by `_compose_outputs`, which must run BEFORE this, but both are
    best-effort: a missing extra is skipped, never fatal -- the client only needs
    the PNGs to succeed. The client (rotoscoping.rs) extracts all three from this
    single ZIP, since /result reaps the work_dir right after serving it.
    """
    pngs = sorted(output_dir.glob("frame_*.png"))
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for png in pngs:
            zf.write(png, arcname=png.name)
        for extra in ("output.webm", "source_clip.mp4"):
            path = output_dir / extra
            if path.exists():
                zf.write(path, arcname=extra)


def _run_job_blocking(
    job: Job,
    video_path: Path,
    frames_dir: Path,
    output_dir: Path,
    points: list[dict],
    frame_skip: int,
    model_size: str,
) -> int:
    """Blocking job body run in a worker thread; serialized on the single GPU."""
    with GPU_LOCK:
        if job.cancelled:
            raise sam2_engine.RotoscopeCancelled("cancelled before start")
        # Ensure the requested SAM2 size is resident BEFORE any GPU work. Inside
        # GPU_LOCK so the swap (download + teardown + rebuild) is serialized ahead
        # of this job and can never run while another job is propagating; a job
        # POSTed during the swap stays "queued" until it acquires the lock.
        _ensure_model_for_job(job, model_size)
        # Start CPU memory tracing once so the stage-boundary snapshots below and
        # in sam2_engine have a current/peak figure to report. Idempotent.
        if not tracemalloc.is_tracing():
            tracemalloc.start()
        job.update(stage="extracting", progress=0.02)
        total_frames = ffmpeg_helper.extract_frames(video_path, frames_dir)
        sam2_engine.log_memory(logger, "after extract_frames")
        written = sam2_engine.run_job(
            job=job,
            frames_dir=frames_dir,
            output_dir=output_dir,
            points=points,
            frame_skip=frame_skip,
            total_frames=total_frames,
        )
        # Propagation is done; the extracted source JPEGs are no longer needed.
        # Delete them now (only the frames dir, never output/ or the zip) so the
        # scratch footprint is not doubled while _zip_output runs. On cancel/error
        # run_job raises, so we skip this and the caller rmtrees the whole work_dir.
        shutil.rmtree(frames_dir, ignore_errors=True)
        return written


def _compose_outputs(
    video_path: Path, output_dir: Path, source_fps: float, frame_skip: int
) -> None:
    """Best-effort extra artifacts: a transparent video + the source clip.

    Composes the PNG sequence into `output_dir/output.webm` at the effective
    output fps (source fps / (frame_skip + 1), matching the decimation), and
    copies the uploaded clip into `output_dir/source_clip.mp4`. The upload is
    always the frame-accurately clipped source the client submitted (the client
    trims/clips before upload -- see T-015), so this archive is real, not a
    placeholder.

    Both artifacts land in `output_dir` (alongside the PNGs) so `_zip_output` can
    fold them into result.zip -- the only way they reach the client, since
    /result reaps the work_dir right after serving the ZIP. This runs BEFORE
    `_zip_output` so the files exist when the zip is built.

    Both steps are wrapped so a failure here never fails the job: the zipped PNG
    sequence is the primary artifact. Logs and swallows; raises nothing.
    """
    try:
        effective_fps = source_fps / (frame_skip + 1)
        ffmpeg_helper.compose_video(output_dir, output_dir / "output.webm", effective_fps)
    except Exception:  # pragma: no cover - best-effort, never fail the job
        logger.exception("compose_video failed; continuing with zip only")
    try:
        if video_path.exists():
            shutil.copyfile(video_path, output_dir / "source_clip.mp4")
    except Exception:  # pragma: no cover - best-effort
        logger.exception("archiving source clip failed; continuing")


def _finalize(
    job: Job,
    video_path: Path,
    frames_dir: Path,
    output_dir: Path,
    points: list[dict],
    frame_skip: int,
    source_fps: float,
    model_size: str,
) -> None:
    """Run the whole job to completion in a worker thread.

    Launched fire-and-forget from the POST (it has already returned 202). Owns
    the job's terminal state and scratch lifecycle: on success it zips the
    output, records `job.zip_path`, and leaves the work_dir in place for the
    /result endpoint to serve and clean up. Every failure path sets a terminal
    stage AND removes the work_dir so scratch never leaks.
    """
    work_dir = job.work_dir
    try:
        written = _run_job_blocking(
            job, video_path, frames_dir, output_dir, points, frame_skip, model_size
        )
        if job.cancelled:
            job.update(stage="cancelled")
            if work_dir is not None:
                shutil.rmtree(work_dir, ignore_errors=True)
            return
        # Compose the extras (transparent video + archived source clip) into
        # output_dir FIRST, so _zip_output can fold them into result.zip -- the
        # single fetch the client makes. Best-effort: a compose failure must not
        # flip the job to error, since the PNG sequence is the primary artifact.
        _compose_outputs(video_path, output_dir, source_fps, frame_skip)
        zip_path = (work_dir or output_dir.parent) / "result.zip"
        _zip_output(output_dir, zip_path)
        job.zip_path = zip_path
        job.update(stage="done", progress=1.0, frames_done=written)
    except sam2_engine.RotoscopeCancelled:
        job.update(stage="cancelled")
        if work_dir is not None:
            shutil.rmtree(work_dir, ignore_errors=True)
    except sam2_engine.RotoscopeOOMError as exc:
        job.update(stage="error", error=str(exc))
        if work_dir is not None:
            shutil.rmtree(work_dir, ignore_errors=True)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("rotoscope job %s failed", job.job_id)
        job.update(stage="error", error=str(exc))
        if work_dir is not None:
            shutil.rmtree(work_dir, ignore_errors=True)


@app.post("/rotoscope")
async def rotoscope(
    video: UploadFile,
    points: str = Form(...),
    job_id: str = Form(...),
    frame_skip: int = Form(3),
    model_size: Optional[str] = Form(None),
) -> JSONResponse:
    # --- validate inputs ---
    if frame_skip < 0 or frame_skip > config.MAX_FRAME_SKIP:
        raise HTTPException(
            status_code=400,
            detail=f"frame_skip must be between 0 and {config.MAX_FRAME_SKIP}",
        )
    # Absent model_size -> the launched/resident default (backwards compatible:
    # older clients send no field). An explicit unknown size is a 400.
    if model_size is None:
        model_size = config.DEFAULT_MODEL_SIZE
    elif model_size not in config.MODEL_SIZES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"unknown model_size {model_size!r}; valid sizes: "
                f"{sorted(config.MODEL_SIZES)}"
            ),
        )
    try:
        parsed_points = json.loads(points)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"invalid points JSON: {exc}")
    if not isinstance(parsed_points, list) or not parsed_points:
        raise HTTPException(
            status_code=400, detail="points must be a non-empty JSON array"
        )

    job = registry.register(job_id)
    work_dir = config.WORK_DIR / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    job.work_dir = work_dir

    frames_dir = work_dir / "frames"
    output_dir = work_dir / "output"
    video_path = work_dir / (Path(video.filename or "input").name or "input.mp4")

    # Persist the upload and probe duration BEFORE returning: the UploadFile is
    # closed once the response is sent. Both touch the disk / spawn ffprobe, so
    # run them off the event loop.
    def _save_upload() -> None:
        with video_path.open("wb") as out:
            shutil.copyfileobj(video.file, out)

    try:
        await asyncio.to_thread(_save_upload)
        # Enforce the clip-length cap (last line of defence; client caps too).
        # source_fps is reused below to derive the composed video's output fps.
        duration, source_fps = await asyncio.to_thread(
            ffmpeg_helper.probe_video, video_path
        )
    except Exception as exc:
        logger.exception("rotoscope job %s: failed to ingest upload", job_id)
        job.update(stage="error", error=str(exc))
        registry.remove(job_id)
        shutil.rmtree(work_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"could not read upload: {exc}")

    # Record the probed source fps on the job so it rides every SSE snapshot --
    # the Rust client reads it from the progress stream and writes it into
    # meta.json (the outputs panel then plays back at the real rate, not 30fps).
    job.update(source_fps=source_fps)

    if duration > config.MAX_VIDEO_SECONDS:
        job.update(stage="error", error="video too long")
        registry.remove(job_id)
        shutil.rmtree(work_dir, ignore_errors=True)
        raise HTTPException(
            status_code=400,
            detail=(
                f"video is {duration:.1f}s; max is {config.MAX_VIDEO_SECONDS:.0f}s"
            ),
        )

    # Launch the job in the background and return immediately. GPU_LOCK inside
    # _run_job_blocking serializes GPU work, so concurrent POSTs queue.
    task = asyncio.create_task(
        asyncio.to_thread(
            _finalize,
            job,
            video_path,
            frames_dir,
            output_dir,
            parsed_points,
            frame_skip,
            source_fps,
            model_size,
        )
    )
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return JSONResponse(status_code=202, content={"job_id": job_id})


@app.get("/rotoscope/{job_id}/progress")
async def progress(job_id: str) -> StreamingResponse:
    async def event_stream():
        # Tolerate the client subscribing before the POST registers the job.
        # Poll without blocking the event loop (the old wait_for_job busy-wait
        # froze the loop and starved the POST that would register the job).
        deadline = asyncio.get_running_loop().time() + 10.0
        job = registry.get(job_id)
        while job is None and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.1)
            job = registry.get(job_id)
        if job is None:
            payload = json.dumps({"stage": "error", "error": "job not found"})
            yield f"data: {payload}\n\n"
            return

        last: str | None = None
        while True:
            snap = job.snapshot()
            payload = json.dumps(snap)
            # Only emit when something changed, to avoid spamming the stream.
            if payload != last:
                yield f"data: {payload}\n\n"
                last = payload
            if job.is_terminal:
                break
            await asyncio.sleep(0.25)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/rotoscope/{job_id}/result")
async def result(job_id: str) -> FileResponse:
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    snap = job.snapshot()
    stage = snap["stage"]

    if stage == "done":
        if job.zip_path is None or not job.zip_path.exists():
            raise HTTPException(status_code=500, detail="result missing")
        work_dir = job.work_dir

        def _cleanup() -> None:
            registry.remove(job_id)
            if work_dir is not None:
                shutil.rmtree(work_dir, ignore_errors=True)

        # FileResponse streams the zip, then BackgroundTask reaps job + scratch.
        return FileResponse(
            job.zip_path,
            media_type="application/zip",
            filename=f"rotoscope_{job_id}.zip",
            background=BackgroundTask(_cleanup),
        )

    if stage == "error":
        raise HTTPException(
            status_code=500, detail=snap.get("error") or "rotoscope failed"
        )
    if stage == "cancelled":
        raise HTTPException(status_code=409, detail="job cancelled")
    # Any non-terminal stage (queued / downloading_model / loading_model /
    # extracting / segmenting / packaging) -> not ready yet.
    raise HTTPException(status_code=425, detail="job not finished")


@app.delete("/rotoscope/{job_id}")
async def cancel(job_id: str) -> JSONResponse:
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    job.request_cancel()
    logger.info("Cancellation requested for job %s", job_id)
    # The propagation loop checks the cancel flag each frame, resets SAM2 state,
    # and the POST handler discards partial output. Return 200 immediately.
    return JSONResponse({"status": "cancelling", "job_id": job_id})


def main() -> None:
    # Guard before binding the socket so a misconfigured box fails fast and loud.
    if not torch.cuda.is_available():
        logger.error(
            "CUDA is not available. Refusing to start (no CPU fallback). "
            "Install a cu128 torch build on a CUDA 12.8 machine."
        )
        sys.exit(1)
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_config=None)


if __name__ == "__main__":
    main()
