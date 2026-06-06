"""Per-job state, keyed by a CLIENT-SUPPLIED job_id.

Why client-supplied: POST /rotoscope runs the job synchronously and returns the
ZIP, so the client cannot learn a server-assigned id in time to subscribe to
progress. Instead the client generates the id, opens the SSE stream on it, then
POSTs with the same id. The SSE side tolerates the race where it subscribes
before the POST registers the job (see `wait_for_job`).

Concurrency model: there is ONE GPU, so jobs are serialized by `GPU_LOCK`. Each
Job carries a threading.Event the propagation loop polls to honour cancellation,
and a lock guarding its mutable progress snapshot.
"""

from __future__ import annotations

import threading
import time
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
    cancel_event: threading.Event = field(default_factory=threading.Event)
    work_dir: Optional[Path] = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def update(
        self,
        *,
        stage: Optional[str] = None,
        progress: Optional[float] = None,
        frames_done: Optional[int] = None,
        frames_total: Optional[int] = None,
        error: Optional[str] = None,
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

    def wait_for_job(self, job_id: str, timeout: float = 10.0) -> Optional[Job]:
        """Return the Job, waiting up to `timeout`s for it to be registered.

        Tolerates the SSE-subscribes-before-POST race: the progress endpoint
        may open before the POST handler calls register().
        """
        deadline = time.monotonic() + timeout
        while True:
            job = self.get(job_id)
            if job is not None:
                return job
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.05)


# Module-level singleton shared across the app.
registry = JobRegistry()
