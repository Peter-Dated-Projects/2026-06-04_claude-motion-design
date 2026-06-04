---
id: sandbox-runtime-vs-render-error-boundary
root: gotchas
type: gotcha
status: current
summary: "The sandbox's bundleRunning flag flips false on script onload, BEFORE React actually renders the first frame, so a throw during React's render surfaces as runtimeError (persistent listener), not renderError -- only bundle-EXECUTION throws are renderError."
created: 2026-06-04
updated: 2026-06-04
---

The preview sandbox (`src/assets/sandbox-frame.html`) now has two error-capture paths
with a subtle boundary between them:

- **runBundle one-shot listener** -> surfaced to parent as `renderError`. Active only
  while the compiled bundle's `<script>` is *executing* (assigning
  `window.AnimationExports`). `bundleRunning` is true for exactly this window.
- **Persistent `window` error / unhandledrejection listeners** -> surfaced as
  `runtimeError`. Gated to fire only when `bundleRunning` is false.

The non-obvious part: `bundleRunning` flips back to false inside `runBundle`'s
`cleanup()`, which runs on the blob script's `onload`. But React's actual render of
the component is *scheduled* by `root.render()` and happens asynchronously AFTER that
-- after `renderOk` is even posted. So a component that throws while React renders it
(bad `interpolate` range, undefined helper hit on frame 0) blows up when
`bundleRunning` is already false, and is caught by the **persistent** listener as a
`runtimeError`, not as a `renderError`.

Practical consequences:
- Only errors thrown during top-level bundle execution (e.g. the `require` shim for an
  unsupported import, a throw at module scope) are `renderError`. Everything React
  throws at render/playback time is `runtimeError`.
- This is by design and avoids double-reporting: the two windows don't overlap, so a
  given throw produces exactly one parent message.
- `runtimeError` entries deliberately do NOT set PreviewPanel's `error`/`isLoading`
  state -- the preview may already be showing a valid earlier frame; they only append
  to the render-log store. The render-log drawer is the surface for these.
- Identical consecutive `runtimeError` messages are throttled (~1s) so a per-frame
  throw can't flood the log.

Related: [[blob-script-throw-fires-onload-not-onerror]] (why the one-shot listener
exists at all), [[animation-can-export-fps-duration]].
