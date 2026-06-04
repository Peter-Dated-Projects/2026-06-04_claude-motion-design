---
id: animation-can-export-fps-duration
root: gotchas
type: gotcha
status: current
summary: "An animation overrides fps/durationInFrames by exporting them (top-level `export const fps`/`durationInFrames`, or `export const config`); the sandbox reads these off window.AnimationExports before rendering. Width/height stay fixed 1080x1920, and DEFAULT_FPS=30 is duplicated in three files that must agree."
created: 2026-06-04
updated: 2026-06-04
---

As of T-033 the composition fps and durationInFrames are no longer fixed app-side.
animation.tsx may override them by exporting values; the preview applies them before
rendering, so `useVideoConfig()` inside the component returns the chosen values.

How it flows:
- The compiled bundle assigns `window.AnimationExports`, and ANY extra named export
  lands there alongside `default`. So `export const fps = 60` is readable with no
  compiler/worker change -- the sandbox just reads it.
- `sandbox-frame.html` -> `resolveConfig(exported)` reads `fps`/`durationInFrames`
  (or `config.fps`/`config.durationInFrames`), validates each as finite and > 0
  (duration floored to an int), falls back to the default otherwise, and writes the
  result onto the `COMPOSITION` object BEFORE `renderPlayer()`. `renderPlayer()` and
  the `frameUpdate` tick both read `COMPOSITION`, so updating it is enough.
- Resolved values are reported to the parent in BOTH the `renderOk` post and every
  `frameUpdate`. PreviewPanel captures `fps` from `frameUpdate` and threads it into
  `<ReplayControls fps=...>`; ReplayControls self-updates `totalFrames` from the same
  message. That is why the scrubber length and `m:ss.ff` readout track the real values.

Footgun: the default frame rate (30) and default duration (150) are now hardcoded in
THREE places that must stay in agreement:
- `src/assets/sandbox-frame.html` (`DEFAULT_FPS` / `DEFAULT_DURATION_IN_FRAMES`),
- `src/components/PreviewPanel/PreviewPanel.tsx` (`DEFAULT_FPS`),
- `src/components/PreviewPanel/ReplayControls.tsx` (`DEFAULT_FPS` / `DEFAULT_TOTAL_FRAMES`).
The sandbox is the source of truth at render time; the React-side constants only cover
the window before the first `frameUpdate`/`renderOk` arrives. Width/height remain fixed
at 1080x1920 and are NOT overridable. See [[canonical-canvas-is-vertical]].
