---
id: roto-sse-sync-wait-froze-event-loop
root: gotchas
type: gotcha
status: current
summary: "The roto progress SSE endpoint deadlocked the service because it called the SYNCHRONOUS busy-wait registry.wait_for_job inside an async coroutine; the Rust client opens the SSE before POSTing, so the blocking wait froze the single event loop and the POST could never register the job -- every run returned only {stage:error, error:'job not found'}."
created: 2026-06-06
updated: 2026-06-06
---

In `microservices/rotoscoping/main.py` the synchronous-POST design depends on the
single asyncio event loop staying free to serve the progress SSE stream while the
GPU job runs in a worker thread (`run_in_executor`). Any blocking call made
DIRECTLY inside an `async def` coroutine (not via a thread) freezes that one loop
and breaks the whole concurrency model.

The deadlock: the Rust client opens `GET /rotoscope/{id}/progress` BEFORE sending
the POST (by design, to catch early progress). `event_stream()` called
`registry.wait_for_job(job_id, timeout=10.0)`, which in `job_registry.py` is a
synchronous busy-wait (`time.sleep(0.05)` loop). Calling it inside the coroutine
froze the loop for the full 10s, so the POST coroutine could never run
`registry.register(job_id)`. The wait timed out and emitted
`{"stage":"error","error":"job not found"}` -- the only thing the client ever saw.
No real progress ticks flowed.

Fix (surgical, T-007): in `event_stream()` poll with `registry.get(job_id)` +
`await asyncio.sleep(0.1)` against a ~10s monotonic deadline instead of calling
`wait_for_job`. `registry.get` is a quick lock acquire and is fine on the loop;
only the SLEEP has to yield. Also moved two other blocking calls in the POST
handler off the loop via `asyncio.to_thread`: the `shutil.copyfileobj` upload
write and `ffmpeg_helper.probe_video` (a synchronous `subprocess.run`).

`wait_for_job` was deliberately LEFT in `job_registry.py` (other code/tests may
use it) -- the rule is just: never call a blocking wait from the event loop. The
endpoint contract, SSE payload shape, and synchronous-POST design are unchanged.
