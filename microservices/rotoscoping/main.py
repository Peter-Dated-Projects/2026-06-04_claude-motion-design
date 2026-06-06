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


def _ensure_weights() -> None:
    """Download SAM2 weights to models/ on first run if missing."""
    if config.CHECKPOINT_PATH.exists():
        logger.info("SAM2 checkpoint present at %s", config.CHECKPOINT_PATH)
        return
    config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    logger.info(
        "Downloading SAM2 checkpoint from %s -> %s",
        config.SAM2_CHECKPOINT_URL,
        config.CHECKPOINT_PATH,
    )
    tmp = config.CHECKPOINT_PATH.with_suffix(config.CHECKPOINT_PATH.suffix + ".part")
    with urlopen(config.SAM2_CHECKPOINT_URL) as resp, tmp.open("wb") as out:
        shutil.copyfileobj(resp, out)
    tmp.replace(config.CHECKPOINT_PATH)
    logger.info("SAM2 checkpoint downloaded")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _require_cuda()
    _ensure_weights()
    # Load the predictor once so /health reports it and jobs reuse it.
    sam2_engine.load_predictor()
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
    return {
        "status": "ok" if sam2_engine.is_loaded() else "loading",
        "model": config.MODEL_LABEL,
        "vram_used_gb": used_gb,
        "vram_total_gb": total_gb,
    }


def _zip_output(output_dir: Path, zip_path: Path) -> None:
    """Zip every PNG in output_dir (sorted) into zip_path."""
    pngs = sorted(output_dir.glob("frame_*.png"))
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for png in pngs:
            zf.write(png, arcname=png.name)


def _run_job_blocking(
    job: Job,
    video_path: Path,
    frames_dir: Path,
    output_dir: Path,
    points: list[dict],
    frame_skip: int,
) -> int:
    """Blocking job body run in a worker thread; serialized on the single GPU."""
    with GPU_LOCK:
        if job.cancelled:
            raise sam2_engine.RotoscopeCancelled("cancelled before start")
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
    video_path: Path, output_dir: Path, work_dir: Path, source_fps: float, frame_skip: int
) -> None:
    """Best-effort post-zip artifacts: a transparent video + the source clip.

    Composes the PNG sequence into `work_dir/output.webm` at the effective output
    fps (source fps / (frame_skip + 1), matching the decimation), and copies the
    uploaded clip into `output_dir/source_clip.mp4`. The upload is always the
    frame-accurately clipped source the client submitted (the client trims/clips
    before upload -- see T-015), so this archive is real, not a placeholder.

    Both steps are wrapped so a failure here never fails the job: the zipped PNG
    sequence is the primary artifact and is already recorded by the time this
    runs. Logs and swallows; raises nothing.
    """
    try:
        effective_fps = source_fps / (frame_skip + 1)
        ffmpeg_helper.compose_video(output_dir, work_dir / "output.webm", effective_fps)
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
            job, video_path, frames_dir, output_dir, points, frame_skip
        )
        if job.cancelled:
            job.update(stage="cancelled")
            if work_dir is not None:
                shutil.rmtree(work_dir, ignore_errors=True)
            return
        zip_path = (work_dir or output_dir.parent) / "result.zip"
        _zip_output(output_dir, zip_path)
        job.zip_path = zip_path
        # Post-zip extras (composed video + archived source clip). Best-effort:
        # the zip is already the recorded primary artifact, so a compose failure
        # must not flip the job to error.
        _compose_outputs(
            video_path, output_dir, work_dir or output_dir.parent, source_fps, frame_skip
        )
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
) -> JSONResponse:
    # --- validate inputs ---
    if frame_skip < 0 or frame_skip > config.MAX_FRAME_SKIP:
        raise HTTPException(
            status_code=400,
            detail=f"frame_skip must be between 0 and {config.MAX_FRAME_SKIP}",
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
    # queued / extracting / segmenting / packaging -> not ready yet.
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
