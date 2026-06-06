"""Rotoscoping microservice -- FastAPI app.

Runs SAM2 on a local CUDA GPU to turn a clipped video into a transparent PNG
sequence. Four endpoints (exact contract in
.charm/proposals/PROPOSAL-rotoscoping-microservice.md):

  GET    /health                        -> service + model + VRAM status
  POST   /rotoscope                     -> run a job synchronously, return a ZIP
  GET    /rotoscope/{job_id}/progress   -> SSE progress snapshots
  DELETE /rotoscope/{job_id}            -> cancel an in-flight job

Design note: the job_id is CLIENT-SUPPLIED in the POST form so the client can
open the progress SSE stream before the synchronous POST returns. The job is run
in a thread (run_in_executor) so the event loop stays free to serve the SSE
stream concurrently with the blocking GPU work. One GPU -> jobs are serialized
by GPU_LOCK.

Entry point is `uv run main.py`. Refuses to start without CUDA (no CPU
fallback). Developed on a Mac (no CUDA): GPU paths could not be executed here.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
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


def _write_upload(src, dest: Path) -> None:
    """Copy an uploaded file's bytes to dest. Run via asyncio.to_thread so the
    blocking disk write never stalls the event loop."""
    with dest.open("wb") as out:
        shutil.copyfileobj(src, out)


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
        job.update(stage="extracting", progress=0.02)
        total_frames = ffmpeg_helper.extract_frames(video_path, frames_dir)
        return sam2_engine.run_job(
            job=job,
            frames_dir=frames_dir,
            output_dir=output_dir,
            points=points,
            frame_skip=frame_skip,
            total_frames=total_frames,
        )


@app.post("/rotoscope")
async def rotoscope(
    video: UploadFile,
    points: str = Form(...),
    job_id: str = Form(...),
    frame_skip: int = Form(3),
) -> FileResponse:
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

    def _cleanup() -> None:
        registry.remove(job_id)
        shutil.rmtree(work_dir, ignore_errors=True)

    try:
        # Persist the upload (off the event loop -- blocking disk write).
        await asyncio.to_thread(_write_upload, video.file, video_path)

        # Enforce the clip-length cap (last line of defence; client caps too).
        # probe_video is a synchronous subprocess.run, so run it in a thread too.
        duration, _fps = await asyncio.to_thread(ffmpeg_helper.probe_video, video_path)
        if duration > config.MAX_VIDEO_SECONDS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"video is {duration:.1f}s; max is "
                    f"{config.MAX_VIDEO_SECONDS:.0f}s"
                ),
            )

        loop = asyncio.get_running_loop()
        written = await loop.run_in_executor(
            None,
            _run_job_blocking,
            job,
            video_path,
            frames_dir,
            output_dir,
            parsed_points,
            frame_skip,
        )

        if job.cancelled:
            job.update(stage="cancelled")
            raise HTTPException(status_code=409, detail="job cancelled")

        zip_path = work_dir / "result.zip"
        _zip_output(output_dir, zip_path)
        job.update(stage="done", progress=1.0, frames_done=written)

        # FileResponse streams the zip, then BackgroundTask cleans up scratch.
        return FileResponse(
            zip_path,
            media_type="application/zip",
            filename=f"rotoscope_{Path(video_path.name).stem}.zip",
            background=BackgroundTask(_cleanup),
        )

    except sam2_engine.RotoscopeCancelled:
        job.update(stage="cancelled")
        _cleanup()
        raise HTTPException(status_code=409, detail="job cancelled")
    except sam2_engine.RotoscopeOOMError as exc:
        job.update(stage="error", error=str(exc))
        _cleanup()
        raise HTTPException(status_code=500, detail=str(exc))
    except HTTPException:
        job.update(stage="error", error="invalid request")
        _cleanup()
        raise
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("rotoscope job %s failed", job_id)
        job.update(stage="error", error=str(exc))
        _cleanup()
        raise HTTPException(status_code=500, detail=f"rotoscope failed: {exc}")


@app.get("/rotoscope/{job_id}/progress")
async def progress(job_id: str) -> StreamingResponse:
    async def event_stream():
        # Tolerate the client subscribing before the POST registers the job.
        # Poll asynchronously rather than busy-waiting: registry.wait_for_job is a
        # blocking time.sleep loop that would freeze the single event loop for the
        # whole timeout, preventing the POST coroutine from ever registering the
        # job. registry.get is a quick lock acquire and is safe on the loop; only
        # the sleep must yield control (await), so the POST can run concurrently.
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
