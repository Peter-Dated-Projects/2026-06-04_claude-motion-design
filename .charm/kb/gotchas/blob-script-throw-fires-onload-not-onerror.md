---
id: blob-script-throw-fires-onload-not-onerror
root: gotchas
type: gotcha
status: current
summary: "A blob/inline <script> that THROWS at runtime still fires onload (not onerror) -- the exception goes to the window 'error' event; the sandbox must capture it there or a thrown bundle looks like a missing export."
created: 2026-06-04
updated: 2026-06-04
---

In the preview sandbox (`src/assets/sandbox-frame.html`), the compiled animation runs
as a blob-URL `<script>`. If that script THROWS while executing (e.g. an unsupported
import compiled to `require("@remotion/shapes")`, or any runtime error), the script
element still fires `onload`, NOT `onerror`. `script.onerror` only fires for load/network
failures; a runtime exception during execution propagates to the window `error` event.

Consequence before the fix: `runBundle` resolved on `onload`, `window.AnimationExports`
was left undefined (the bundle threw before assigning it), and the render handler reported
the generic "Animation must `export default` a React component." -- a wrong message for
what was actually `require is not defined`.

Fix (T-035): in `runBundle`, add a one-shot `window.addEventListener("error", ...)` around
the script append, capture the first thrown error, and resolve with it. The render handler
then throws that captured error (instead of the generic export message) whenever there's no
default export AND a runtime error was captured.

Companion fix: define a `window.require` shim in the sandbox that throws a friendly,
module-NAMED message. esbuild runs in TRANSFORM mode (see
[esbuild-wasm-no-concurrent-transform]), so an import of a non-whitelisted module is emitted
as a bare `require("<mod>")`; only `react`, `react-dom`, `remotion`, `@remotion/player` are
rewritten to window globals by the worker's `GLOBAL_FOR` map. The shim turns the cryptic
"require is not defined" into "This animation imports '<x>', which isn't available in the
preview runtime." The shim is defined in the IIFE that runs AFTER the React/Remotion UMD
runtime scripts, so it never interferes with their load (UMD CJS detection gates on
`module`/`exports`, not `require`).
