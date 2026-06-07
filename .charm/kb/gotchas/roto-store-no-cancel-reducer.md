---
id: roto-store-no-cancel-reducer
root: gotchas
type: gotcha
status: current
summary: "rotoStore has no cancel-to-placement reducer -- its `reset` wipes the whole setup (video/startFrame/points), so returning from a cancelled job to point placement requires useRotoStore.setState({phase:'idle',jobId:null,progress:null,error:null}) directly. NOTE: as of the job-queue PR the rotoscope_video/trim_video/cancel_rotoscope invokes MOVED out of RotoVideoPanel into the useRotoJobQueue hook -- see roto-job-queue-single-instance."
created: 2026-06-06
updated: 2026-06-07
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
`roto://progress` listener app-level. The job-START commands USED to live in
`RotoVideoPanel`, but the job-queue PR moved `invoke("trim_video"/"rotoscope_video"/
"cancel_rotoscope", ...)` into the `useRotoJobQueue` hook. Results still feed back
through the documented actions (`startJob` / `jobComplete` / `setError`), which the
hook now calls. Tauri arg keys are camelCase (`sourcePath`, `startFrame`,
`frameSkip`) -- Tauri maps them to the Rust command's snake_case.

`RotoVideoPanel.cancelJob` still does the `setState({phase:'idle',...})` above (so
the displayed pane returns to point placement), but it now also calls
`queue.cancel(jobId)` to delegate the actual backend teardown to the hook.

DESYNC FOOTGUN (PR #7 review fix): `queue.cancel` is synchronous and, for a
running job, calls `processNext()` which can PROMOTE the next queued job to
running -- which itself calls `useRotoStore.getState().startJob(nextId)`,
writing fresh job fields into the store. If `cancelJob` then unconditionally ran
`setState({phase:'idle',jobId:null,...})` it would CLOBBER that just-promoted
job. So `queue.cancel(id)` now returns a boolean = "a queued job was promoted to
running" (it checks `jobsRef` for a running job after `processNext`), and
`cancelJob` resets the store to idle ONLY when that is false. Any other caller
that mirrors the running job into shared single-job state must honor the same
return value before resetting on cancel.
