---
id: roto-model-size-read-at-runtime
root: gotchas
type: gotcha
status: current
summary: "The rotoscope model_size is read from rotoStore at job run time in useRotoJobQueue.runJob (NOT captured in RotoscopeParams at enqueue like every other job param) -- do not 'fix' it by threading it through RotoscopeParams."
created: 2026-06-07
updated: 2026-06-07
---

Every per-job rotoscope input (sourcePath, points, frameSkip, clipStart/End,
quality, fps) is snapshotted into `RotoscopeParams` at enqueue time in
`RotoVideoPanel`, so a queued job is self-contained. The SAM2 `modelSize` is the
one exception: it is read live from the store inside `useRotoJobQueue.runJob` via
`useRotoStore.getState().modelSize` and passed to the `rotoscope_video` invoke as
`modelSize` (Tauri maps it to the Rust `model_size: Option<String>` param from
T-008, which becomes a multipart field only when present).

Why it diverges: model size is a setup-wide preference, not a per-clip property,
and `RotoscopeParams` + its construction site (`RotoVideoPanel`) were out of scope
for the ticket that added the control (T-012, touches limited to rotoStore /
RotoControls / useRotoJobQueue). Reading at run time kept the change additive and
inside scope. The practical effect: if multiple jobs are queued, they all use
whatever model is selected when each one actually starts, not when it was
enqueued. That is acceptable because the service swaps models serially behind the
GPU lock anyway. If you ever need per-job model locking, that is the moment to
promote `modelSize` into `RotoscopeParams` -- until then, do not "tidy" it there.

Related: the control reflects the swap stages T-006 pins on `roto://progress`
(`downloading_model` with a 0..1 fraction, `loading_model`, `queued`) so it never
silently lies about which model is loading.
