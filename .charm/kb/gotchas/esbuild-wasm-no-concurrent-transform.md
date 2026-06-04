---
id: esbuild-wasm-no-concurrent-transform
root: gotchas
type: gotcha
status: current
summary: "esbuild-wasm with worker:false can DEADLOCK on overlapping transform calls, so the sandbox compiler must single-flight transforms; the preview also needs a generation-tagged watchdog so a missing compile/render reply can't strand the overlay on 'Compiling preview...' forever."
created: 2026-06-04
updated: 2026-06-04
related: esbuild-wasm-init-fetch-and-timeout
---

`src/workers/sandbox-compiler.worker.ts` runs esbuild-wasm with `worker:false`,
i.e. one wasm instance on the worker's single thread. That instance is NOT safe
for concurrent `esbuild.transform` calls -- two in flight at once can DEADLOCK,
and the second compile then never posts a `compiled` or `error` reply.

This is the trigger for the "preview stuck on Compiling preview... forever" bug
(T-034) on *updates* (first load usually works). When Claude makes several edits
in one turn, the Rust file watcher emits multiple `animation://changed` events ->
multiple `setCode` -> multiple `compile` messages arriving close together. The old
`onmessage` was a bare `async` handler that awaited `transform` with no queue, so
two transforms overlapped and the worker hung.

Two-part fix, both required:

1. **Single-flight the worker.** `onmessage` only stashes the latest request in a
   `pending` slot and kicks a `drain()` loop guarded by a `processing` flag. The
   loop awaits one `compileOne` at a time, so transforms never overlap. It also
   coalesces: if a newer `compile` arrived while one ran, the finished result is
   stale and is dropped (skip the `postMessage`) -- only the newest request's
   result is posted. Requests carry the existing `id` field for tagging.

2. **Watchdog + generation guard in `PreviewPanel.tsx`.** Even with the worker
   fixed, the loading overlay had no recovery path: `isLoading` cleared only on a
   `renderOk`/`renderError`/worker-`error`. Now every source change (and the Retry
   button) bumps a monotonic `generationRef`, tags the `compile` with it, and arms
   a ~5s watchdog. Worker replies whose `id` != current generation are ignored
   (stale). `renderOk`/`renderError` clear the watchdog + loading; the watchdog
   firing clears loading and shows a "Preview timed out" error with a Retry that
   re-posts the compile.

Caveat on the generation guard: `renderOk`/`renderError` from the sandbox carry NO
`id` (the sandbox files -- `sandbox-frame.html`, `preview-runtime.js` -- were out
of T-034's scope), so they clear the *current* generation rather than being matched
to a specific one. The worker `id`-guard is the real stale-reply defense; the
sandbox-reply path just clears the watchdog. If you ever need exact render-reply
matching, thread the generation through the `render` message and echo it back in
`renderOk`/`renderError`.

Keep the watchdog generous enough (5s) to cover the first-compile esbuild-wasm init
(`ensureInit`, up to a 10s cap -- see [[esbuild-wasm-init-fetch-and-timeout]]) plus
the iframe srcdoc load, or first load will time out spuriously.
