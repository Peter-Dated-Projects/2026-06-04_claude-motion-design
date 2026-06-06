---
id: roto-store-no-cancel-reducer
root: gotchas
type: gotcha
status: current
summary: "rotoStore has no cancel-to-placement reducer -- its `reset` wipes the whole setup (video/startFrame/points), so returning from a cancelled job to point placement requires useRotoStore.setState({phase:'idle',jobId:null,progress:null,error:null}) directly; the job-START invokes (rotoscope_video/cancel_rotoscope) live in RotoVideoPanel, not App.tsx."
created: 2026-06-06
updated: 2026-06-06
---

The rotoscoping store (`src/store/rotoStore.ts`) exposes `reset()` which clears the
ENTIRE active setup -- `video`, `startFrame`, `points`, `frameSkip`, plus the job
fields. That is the "start over" path, NOT the cancel path.

The proposal's Cancel button must return the user to the point-placement view with
the loaded video, locked start frame, and placed points still intact. No action in
the store does that (there is no `cancelJob`/`returnToSetup` reducer), and the store
file is owned by T-003 -- out of T-004's touches. So `RotoVideoPanel.cancelJob`
flips only the job fields back to idle directly:

```ts
useRotoStore.setState({ phase: "idle", jobId: null, progress: null, error: null });
```

This is the one deliberate place the panel bypasses the action vocabulary. If the
store later grows a proper cancel reducer, route through it instead.

Related boundary fact: the store is intentionally Tauri-free and App.tsx wires the
`roto://progress` listener app-level, but App.tsx explicitly DEFERS the job-START
commands to the panel. So `invoke("rotoscope_video", ...)` and
`invoke("cancel_rotoscope", ...)` live in `RotoVideoPanel`, not in App.tsx or the
store -- results feed back through the documented actions (`startJob` /
`jobComplete` / `setError`). Tauri arg keys are camelCase (`sourcePath`,
`startFrame`, `frameSkip`) -- Tauri maps them to the Rust command's snake_case.

Job-id contract (fixed in T-008, was previously broken): there is ONE job id, and
the client generates it. `RotoVideoPanel.runJob` makes `roto-<ts>-<rand>`, passes it
to `startJob(jobId)` AND to `invoke("rotoscope_video", { jobId, ... })`. The Rust
`rotoscope_video` command takes a `job_id: String` param and uses it verbatim for the
multipart `job_id` field (the service's key) and the SSE stream URL. `cancelJob` reads
`useRotoStore.getState().jobId` and DELETEs `/rotoscope/<id>` -- now the same id the
service registered, so cancel actually matches.

Before T-008 there were THREE ids: a `local-<ts>` store marker, a Rust-side
`next_job_id()` (`job_<nanos>` -- the only one the service ever saw), and cancel sent
the store marker -> guaranteed 404 -> silent no-op. `cancel_rotoscope`/`cancel_blocking`
route by the job_id in the URL PATH, never by `host` (the old comment claiming
host-routing was wrong). `next_job_id()` survives only for locally-unique throwaways
(the temp clip filename, and an independent multipart boundary inside `build_multipart`),
never as job identity.
