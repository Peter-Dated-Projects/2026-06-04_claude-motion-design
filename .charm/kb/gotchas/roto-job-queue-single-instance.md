---
id: roto-job-queue-single-instance
root: gotchas
type: gotcha
status: current
summary: "useRotoJobQueue holds ALL queue state + the side-effecting invokes/listener, so it MUST be a single instance shared via RotoJobQueueProvider/useRotoJobQueueApi -- calling the hook directly in both RotoVideoPanel and the overlay would create two independent queues. The .ts file uses createElement (not JSX) so it stays non-.tsx; progress ticks have no jobId and are matched to the running job by status."
created: 2026-06-06
updated: 2026-06-06
---

The rotoscope job queue (`src/hooks/useRotoJobQueue.ts`) owns ALL of its state
(`jobs: QueuedJob[]`) plus the side effects: the `trim_video` / `rotoscope_video` /
`cancel_rotoscope` invokes and the `roto://progress` listener. Two components need
it -- `RotoVideoPanel` (enqueue / cancel) and `RotoJobQueueOverlay` (jobs / cancel /
dismiss) -- and they live in different parts of the tree.

Trap: calling `useRotoJobQueue()` in both would spin up TWO independent queues with
separate state and separate listeners (a job enqueued in one would never appear in
the other). It is therefore exposed as a single shared instance:

- `RotoJobQueueProvider` calls the hook ONCE and is mounted at the app root
  (wraps the `.app` div in `App.tsx`, outside the panel layout so the overlay
  floats over every workspace).
- Both consumers read it via `useRotoJobQueueApi()` (throws if used outside the
  provider).

Why `createElement` instead of JSX in the provider: the file is `.ts`, not `.tsx`
(it's a hook), and the ticket scope fixed it as `.ts`. `createElement(Ctx.Provider,
{ value }, children)` keeps it a valid non-JSX module.

Other non-obvious bits baked into the hook:

- **One job in flight.** `_processNext` has a re-entrancy guard
  (`jobs.some(j => j.status === "running")` -> return) so two rapid enqueues never
  start two concurrent backend runs. State reads inside the stable callbacks go
  through a `jobsRef` kept in lockstep with state by a single `commit()` helper,
  to avoid stale-closure bugs between an enqueue and the async run it triggers.
- **Progress has no jobId.** `RotoProgress` carries only stage/progress. Because
  the backend serializes on its GPU lock, every tick belongs to the running job --
  the listener matches by `status === "running"`, not by id.
- **Trim runs at job-start, not enqueue.** `RotoscopeParams` carries RAW clip
  bounds (+ `fps` for the startFrame rebase); `_processNext` does the `trim_video`
  then rebases `startFrame` by `clipStart*fps` (see roto-trim-rebases-start-frame).
  A job cancelled mid-trim is flagged in a `cancelledIds` ref and bails before the
  heavy `rotoscope_video` invoke; a cancel that lands mid-rotoscope surfaces as a
  rejected promise that the catch path swallows (rather than marking it failed),
  again keyed on `cancelledIds`.
- **Pane unblock is incidental, not explicit.** The 2-job flow works because
  `rotoStore.loadVideo` resets `phase` to `idle`; loading a second video while job 1
  runs drops the blocking ProcessingView so the user can set up + enqueue job 2.
  The queue keeps running independently of the rotoStore's single-job `phase`.
- **Cancel-with-queued-next desyncs the store mirror (known, low-impact).**
  `RotoVideoPanel.cancelJob` calls `queue.cancel(jobId)` -- which synchronously runs
  `_processNext` and `startJob`s the next queued job (store -> uploading/jobId=next) --
  and THEN unconditionally `setState({phase:'idle', jobId:null})`, clobbering that
  promotion. The next job still runs in the queue, but the pane shows the setup view
  (not ProcessingView) and pops a surprise 'done' banner on completion. Only triggers
  when a second job was stacked behind the cancelled one. Inherent to mirroring a
  multi-job queue onto a single-job store; flagged in the PR #7 review, not yet fixed.
