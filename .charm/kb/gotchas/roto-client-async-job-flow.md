---
id: roto-client-async-job-flow
root: gotchas
type: gotcha
status: current
summary: "The Tauri roto client (rotoscoping.rs) now speaks the async job contract: rotoscope_video takes a client-supplied job_id, POSTs (expecting 202, NOT a ZIP), then run_progress_stream RETURNS the terminal stage and the ZIP is fetched separately from GET /result. run_progress_stream no longer signals via AtomicBool and there's no separate POST thread."
created: 2026-06-06
updated: 2026-06-06
---

`rotoscope_video` was rewritten for the async microservice contract (see
[[roto-service-async-job-202-not-sync-zip]] for the service side). Client-side
facts that aren't obvious from the old shape:

- **One client-supplied `job_id` is threaded frontend -> Rust -> service.**
  `RotoVideoPanel.runJob` mints `roto-${Date.now()}-${rand}`, passes it to both
  `startJob(jobId)` and the `rotoscope_video` invoke. The Rust command takes a
  `job_id: String` param (Tauri maps JS `jobId`). This is THE job identity used
  for the POST `job_id` field, the SSE URL, and DELETE-cancel -- so cancel now
  reaches the real job (it used to 404, three divergent ids existed). The old
  `next_job_id()` is renamed `next_local_id()` and is used ONLY for the scratch
  clip filename and the multipart boundary -- not job identity.

- **`run_progress_stream` is the completion signal and RETURNS the terminal
  stage** (`"done" | "error" | "cancelled"`), running inline on the blocking
  task. It no longer takes/sets an `Arc<AtomicBool>`, and there is NO separate
  progress thread + blocking POST anymore (the POST returns 202 fast). It keeps
  the reconnect/backoff race-retry, plus a consecutive-connect-failure cap
  (~60s) so a service that dies mid-job surfaces as `"error"` instead of looping
  forever.

- **The ZIP comes from `fetch_result_zip` (GET /result), not the POST.** Because
  SSE `done` and result-readiness race slightly, it retries on `425` (not
  finished) and `409` with a short sleep before giving up. The POST body (202
  `{job_id}`) is intentionally discarded.

- Order is POST first, then connect SSE. The service registers the job
  synchronously before returning 202, so by the time we open the stream the job
  exists; the retry loop only covers transient drops.
