# Rotoscoping Bug Bash 3 — Job Queue Overlay

One feature: a client-side job queue with a persistent bottom-left overlay that
lets users stack multiple rotoscope requests and continue using the workspace
while jobs run in the background. Jobs are sent to the backend one at a time, in
the order they were submitted.

---

## Problem

The current flow is entirely blocking: once a job starts, `RotoVideoPanel` shows
`ProcessingView` and the whole Video pane is a progress bar with a Cancel button.
Users cannot load a different video, place points for the next job, or do anything
in the rotoscoping workspace until the current job finishes. There is no way to
queue a second request while the first is running.

---

## Proposed UX

A stack of job cards anchored to the bottom-left corner of the app window, layered
over everything else (z-index above panels and toolbars). Each card is compact:
one line with the job name, a progress bar, and a Cancel button.

- The stack grows upward as cards are added (newest on top, oldest at the bottom).
- A running job shows its progress bar filling in real time.
- A queued-but-not-yet-sent job shows "Waiting..." and a Cancel button.
- A finished job shows a brief "Done" state (2 seconds), then fades out.
- A failed job shows "Failed: <short reason>" and a Dismiss button. It does not
  auto-remove so the user can read the error.
- The stack is always visible (not collapsible in this version), but individual
  cards are small enough that 3-4 of them do not cover critical UI.

---

## Architecture

### Client-side queue

The queue lives in a new `useRotoJobQueue` hook (or a Zustand slice, but a hook
is cleaner since it owns side effects). Its state is:

```ts
interface QueuedJob {
  id: string;          // client-generated, same format as rotoStore.jobId
  label: string;       // e.g. "rotoscope_clip (frame 42)"
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;    // 0..1 for running jobs
  error: string | null;
  params: RotoscopeParams;  // everything needed to call invoke("rotoscope_video", ...)
}
```

The hook exposes:
- `enqueue(params, label) -> id` -- appends a new `QueuedJob` in `"queued"` state
  and, if no job is currently running, immediately starts it.
- `cancel(id)` -- if the job is `"queued"`, removes it. If `"running"`, calls
  `invoke("cancel_rotoscope", ...)` on the backend and marks it `"cancelled"`.
- `dismiss(id)` -- removes a `"failed"` or `"done"` card from the visible stack.

The hook's internal `_processNext` function:
1. **Re-entrancy guard.** If any job is already `"running"`, return immediately.
   This prevents two rapid `enqueue` calls from starting two concurrent runners:
   ```ts
   if (jobs.some(j => j.status === "running")) return;
   ```
2. Finds the first `"queued"` job. If none, return.
3. Marks it `"running"` and calls `rotoStore.startJob(id)`.
4. **Trim step.** If `params.clipStart != null && params.clipEnd != null`, call
   `invoke("trim_video", { path: params.sourcePath, startSecs: params.clipStart, endSecs: params.clipEnd })`
   to get a trimmed path and rebase `effectiveStartFrame`. Check the job's
   cancellation flag after the trim resolves -- if the job was cancelled mid-trim,
   skip the `rotoscope_video` invoke and clean up.
5. Calls `invoke("rotoscope_video", { ...resolvedParams })`.
6. On completion: marks `"done"`, calls `rotoStore.jobComplete(result)`, stores
   the auto-dismiss timer handle per job, and calls `_processNext` again.
7. On error: marks `"failed"`, calls `rotoStore.setError(message)`.

**`RotoscopeParams` must carry raw clip bounds**, not pre-trimmed paths, so
`_processNext` can perform the trim at run time rather than at enqueue time
(eager trimming would block the UI and create temp files for jobs that may be
cancelled before they ever run):

```ts
interface RotoscopeParams {
  slug: string;
  sourcePath: string;       // original file path
  startFrame: number;       // source-relative (pre-rebase)
  clipStart: number | null; // seconds, or null for full video
  clipEnd: number | null;
  points: RotoPoint[];
  frameSkip: number;
  compress: boolean;
  quality: number;
  // host is read from localStorage inside _processNext, not captured at enqueue
}
```

**Progress updates.** `RotoProgress` (in `src/types/roto.ts`) contains only
`stage`, `progress`, `framesDone?`, `framesTotal?` -- there is no `jobId` field.
Because the backend serializes jobs via its GPU lock (one at a time), every
progress tick belongs to the currently running job. The queue hook matches events
to the running job by status, not by id:

```ts
listen<RotoProgress>("roto://progress", (e) => {
  setJobs(prev => prev.map(j =>
    j.status === "running" ? { ...j, progress: e.payload.progress ?? j.progress } : j
  ));
});
```

**Auto-dismiss timer handles.** Store per-job timer ids so `dismiss` can cancel
the pending auto-remove before it fires:

```ts
const autoRemoveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

// In _processNext on completion:
autoRemoveTimers.current[job.id] = setTimeout(() => {
  setJobs(prev => prev.filter(j => j.id !== job.id));
  delete autoRemoveTimers.current[job.id];
}, 2000);

// In dismiss:
clearTimeout(autoRemoveTimers.current[id]);
delete autoRemoveTimers.current[id];
setJobs(prev => prev.filter(j => j.id !== id));
```

### Changing `RotoVideoPanel`

`RotoVideoPanel` currently drives the job lifecycle directly (calls
`invoke("rotoscope_video", ...)` and shows `ProcessingView`). After this change:

- The "Generate" button (via `ReviewModal`) calls `queue.enqueue(params, label)`
  instead of running the job directly.
- `ProcessingView` inside `RotoVideoPanel` is no longer used -- it can be removed
  from this component, or retained as a local in-pane view only for the job whose
  params match the currently-loaded video (so the pane still reflects the status
  of the most recent job for the video the user is looking at).
- The `cancelJob` function in `RotoVideoPanel` delegates to `queue.cancel(id)`.

A simpler approach (lower risk): keep `RotoVideoPanel`'s existing single-job UX
exactly as-is, but add a "Queue" path that runs in parallel. When `queue.length > 0
&& no job is running`, the Video pane is unblocked. This avoids touching the
existing single-job flow and makes the queue a progressive enhancement.

The simpler approach is recommended for the initial version.

### Overlay component

`RotoJobQueueOverlay` is a new top-level component rendered in `App.tsx`, outside
the panel layout (so it always floats regardless of workspace):

```tsx
// In App.tsx, inside the root div:
<RotoJobQueueOverlay />
```

It reads from the queue hook and renders the card stack. Cards are absolutely
positioned at `bottom: 60px; left: 16px` (above the `WorkspaceBar`). Z-index
above all panels.

Each card is roughly 240px wide x 48px tall:

```
[ rotoscope_clip (frame 42)    [x] ]
[ ======================= 62%      ]
```

Card states:
- **queued**: grey bar, "Waiting" label.
- **running**: accent-colored fill bar, progress percentage.
- **done**: green bar at 100%, "Done" label, auto-removes after 2s.
- **failed**: red bar, "Failed" label, "Dismiss" button.
- **cancelled**: fades out immediately.

### Job label

The label is derived at enqueue time from the current store state:
`{videoBasename} (frame {startFrame})`. This gives the user enough context to
identify which job is which when multiple are in the stack.

---

## What stays the same

- The backend receives jobs one at a time (no concurrency change on the Python
  side). The queue's serialization ensures the second `invoke("rotoscope_video")`
  call is never made until the first `invoke` settles.
- `rotoStore.jobComplete` and `rotoStore.setError` are still called on completion
  to update the Outputs panel and show the "Rotoscope complete" banner in the
  Video pane.
- The existing `cancel_rotoscope` backend command is reused unchanged.
- The `roto://progress` event is reused unchanged.

---

## What changes in the store

`rotoStore.jobId` is currently a single string. With a queue, multiple jobs have
ids but only one is the "active" backend job. The store field tracks the currently
running backend job id (same meaning as today). The queue hook owns the full list;
the store only needs to know the running job's id for cancel.

No other store changes are required.

---

## Implementation order

1. **Extract `RotoscopeParams` type** from `RotoVideoPanel.tsx` and the
   `invoke("rotoscope_video", ...)` call into a shared type / helper. This is
   the seam the queue hook plugs into.

2. **Implement `useRotoJobQueue`** with the queue state, `enqueue`, `cancel`,
   and `_processNext` logic. Add the `roto://progress` listener inside the hook.

3. **Wire `ReviewModal`'s confirm callback** to call `queue.enqueue(...)` instead
   of `runJob` directly.

4. **Add `RotoJobQueueOverlay`** in `App.tsx`. Style the cards.

5. **Test the 2-job case**: submit a job, immediately navigate to a second video
   and submit a second job while the first is running. Verify the second stays
   `"queued"` and starts automatically when the first finishes.
