---
id: sandbox-ready-handshake-must-be-recoverable
root: gotchas
type: gotcha
status: current
summary: "PreviewPanel must not gate render on the iframe's ONE-TIME sandboxReady message -- a Fast-Refresh remount resets sandboxReadyRef while the memoized srcDoc iframe never reloads, so the parked bundle deadlocks forever; recover via an iframe onLoad reset + a parent `ping` the sandbox answers with sandboxReady."
created: 2026-06-04
updated: 2026-06-04
---

The preview can get PERMANENTLY stuck on the watchdog timeout even though the
compile succeeds. Render-log evidence: `[compile] Compiled (N bytes)` followed by
`[watchdog] Preview timed out` -- no render is ever posted and no renderOk/renderError
returns.

Root cause: PreviewPanel only posts `render` to the iframe AFTER it has received the
iframe's ONE-TIME `sandboxReady` message (tracked in `sandboxReadyRef`). On a
`compiled` reply it parks the bundle in `pendingBundleRef` and waits for ready. If the
panel never sees `sandboxReady`, the bundle sits parked forever.

This is not hypothetical: a Fast-Refresh REMOUNT of PreviewPanel (e.g. T-042 added
hooks, forcing a remount) resets React state/refs -- `sandboxReadyRef` goes back to
false -- but the iframe's `srcDoc` is `useMemo`'d ONCE, so the iframe does NOT reload
and never re-announces `sandboxReady`. The render path deadlocks and the T-034
watchdog trips every time, including on Retry.

Fix (the handshake must be RECOVERABLE, never reliant on catching one event):
- sandbox-frame.html answers a parent `{type:"ping"}` by re-posting `{type:"sandboxReady"}`.
  Idempotent; the load-time announce still happens too.
- PreviewPanel: on the iframe `onLoad`, reset `sandboxReadyRef=false` and `ping` (a
  load is a fresh sandbox; ping also covers a load-event vs sandboxReady-post race).
- PreviewPanel: in the worker `compiled` handler, if a bundle arrives while
  `sandboxReadyRef` is false, `ping` the iframe. The sandbox re-announces, the
  existing `sandboxReady` handler flushes `pendingBundleRef`. Self-heals the remount
  case where onLoad never fires (iframe didn't reload) but refs reset.

Keep the watchdog as the last-resort net; it should now rarely fire. See also
[[esbuild-wasm-no-concurrent-transform]] (the generation-tagged watchdog) and
[[preview-panel-passive-isplaying]].
