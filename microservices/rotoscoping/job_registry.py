"""Per-job state, keyed by a CLIENT-SUPPLIED job_id.

Why client-supplied: the client generates the id, opens the SSE progress stream
on it, then POSTs with the same id. POST /rotoscope launches the job in the
background and returns 202 immediately; progress flows over SSE and the result
ZIP is fetched separately from /rotoscope/{job_id}/result. The SSE side tolerates
the race where it subscribes before the POST registers the job by polling
`registry.get` against a short deadline.

Concurrency model: there is ONE GPU, so jobs are serialized by `GPU_LOCK`. Each
Job carries a threading.Event the propagation loop polls to honour cancellation,
and a lock guarding its mutable progress snapshot. `zip_path` is set by the
background finalizer once the output ZIP is written, and read by the /result
endpoint.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# Serializes GPU work: only one rotoscope job touches SAM2 at a time.
GPU_LOCK = threading.Lock()

# Terminal stages the SSE stream stops on.
TERMINAL_STAGES = ("done", "error", "cancelled")


@dataclass
class Job:
    """Mutable state for one rotoscoping job, keyed by client-supplied id."""

    job_id: str
    stage: str = "queued"
    progress: float = 0.0
    frames_done: int = 0
    frames_total: int = 0
    error: Optional[str] = None
    # Probed source-video frame rate (frames/sec), set once at POST time before
    # the job launches. Surfaced in every SSE snapshot so the Rust client can
    # record it in meta.json (the read-side falls back to 30fps when absent).
    source_fps: Optional[float] = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    work_dir: Optional[Path] = None
    zip_path: Optional[Path] = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def update(
        self,
        *,
        stage: Optional[str] = None,
        progress: Optional[float] = None,
        frames_done: Optional[int] = None,
        frames_total: Optional[int] = None,
        error: Optional[str] = None,
        source_fps: Optional[float] = None,
    ) -> None:
        with self._lock:
            if stage is not None:
                self.stage = stage
            if progress is not None:
                self.progress = progress
            if frames_done is not None:
                self.frames_done = frames_done
            if frames_total is not None:
                self.frames_total = frames_total
            if error is not None:
                self.error = error
            if source_fps is not None:
                self.source_fps = source_fps

    def snapshot(self) -> dict:
        """Thread-safe copy of the progress fields for an SSE event."""
        with self._lock:
            snap = {
                "stage": self.stage,
                "progress": round(self.progress, 4),
                "frames_done": self.frames_done,
                "frames_total": self.frames_total,
            }
            if self.error is not None:
                snap["error"] = self.error
            if self.source_fps is not None:
                snap["source_fps"] = self.source_fps
            return snap

    @property
    def is_terminal(self) -> bool:
        with self._lock:
            return self.stage in TERMINAL_STAGES

    def request_cancel(self) -> None:
        self.cancel_event.set()

    @property
    def cancelled(self) -> bool:
        return self.cancel_event.is_set()


class JobRegistry:
    """Thread-safe map of job_id -> Job."""

    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def register(self, job_id: str) -> Job:
        with self._lock:
            existing = self._jobs.get(job_id)
            if existing is not None:
                return existing
            job = Job(job_id=job_id)
            self._jobs[job_id] = job
            return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def remove(self, job_id: str) -> None:
        with self._lock:
            self._jobs.pop(job_id, None)


# Module-level singleton shared across the app.
registry = JobRegistry()
