---
id: roto-service-async-job-202-not-sync-zip
root: gotchas
type: gotcha
status: current
summary: "As of the async-job rewrite, POST /rotoscope returns 202 {job_id} and launches the job in the background; the ZIP is fetched from the NEW GET /rotoscope/{job_id}/result (425 while running) -- it no longer streams the ZIP from the POST. Any client/doc that still expects a synchronous ZIP from the POST is stale."
created: 2026-06-06
updated: 2026-06-06
---

The rotoscoping microservice (`microservices/rotoscoping/main.py`) was
restructured from synchronous-POST to an async job model. Endpoint contract now:

- `POST /rotoscope` -> validates, saves the upload + probes duration off the
  loop (`asyncio.to_thread`, BEFORE returning -- the UploadFile is closed once
  the response is sent), then `asyncio.create_task(asyncio.to_thread(_finalize,
  ...))` and returns `JSONResponse(202, {"job_id": job_id})`. It does NOT await
  the job and does NOT clean up the work_dir.
- `GET /rotoscope/{job_id}/progress` -> SSE, SAME payload shape as before
  (`{stage, progress, frames_done, frames_total[, error]}`). The pre-POST race
  is handled by a non-blocking async poll (`registry.get` + `await
  asyncio.sleep(0.1)` to a ~10s deadline), NOT the old synchronous
  `wait_for_job` busy-wait (which froze the event loop and starved the POST that
  would register the job -- that was the original `job not found` bug).
- `GET /rotoscope/{job_id}/result` -> NEW. `done` streams the ZIP via
  `FileResponse` with a `BackgroundTask` that reaps the job + rmtree's work_dir;
  `425` while still running, `409` cancelled, `500` error, `404` unknown.
- `DELETE /rotoscope/{job_id}` -> unchanged (sets the cancel event).

Two footguns this introduced:

1. `_finalize` (the background thread wrapper) OWNS terminal state + scratch
   cleanup. On success it leaves work_dir in place for `/result` to serve and
   clean up; every cancel/OOM/error path rmtree's work_dir itself or scratch
   leaks. `Job.zip_path` is set BEFORE `stage="done"`, so the reader observing
   `done` always sees a populated zip_path.
2. A bare `asyncio.create_task(...)` result must be kept in a strong reference
   (`_BACKGROUND_TASKS` set + `add_done_callback(discard)`) -- the event loop
   only holds a weak ref, so a fire-and-forget job task can be garbage-collected
   mid-flight otherwise.

Several older KB notes describe the service as "POST runs the job synchronously
and returns the ZIP" (e.g. the client-supplied-job_id rationale) -- that framing
is now stale; the job_id is still client-supplied (so the SSE stream can be
opened before POSTing), but the POST is async.
