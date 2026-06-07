---
id: roto-controls-warning-effect-clobber
root: gotchas
type: gotcha
status: current
summary: "In RotoControls the Output FPS field is a derived view over the canonical frameSkip, synced by a useEffect keyed on targetFps; any companion state (e.g. the source-fps ceiling warning) must NOT be cleared in that effect or the in-place clamp will wipe it -- clear it in a separate effect keyed on `video` instead."
created: 2026-06-07
updated: 2026-06-07
---

`RotoControls.tsx` shows Output FPS as a derived view: the canonical store value is
the integer `frameSkip`, and the displayed fps is `sourceFps / (frameSkip + 1)`. A
`useEffect` keyed on `targetFps` re-syncs the text field whenever the derived fps
changes (new video, or skip set elsewhere).

The trap: the source-fps ceiling warning (#5) is set inside `onFpsChange` when the
typed value exceeds `sourceFps`, and at the same time it clamps `frameSkip` to 0
(every frame). That clamp moves `targetFps` up to the source rate, which fires the
`targetFps` sync effect. If you clear the warning inside that effect, the clamp you
just performed immediately wipes the warning you just set -- the user never sees it.

Fix that's in place: the warning lives in its own `fpsWarning` state, cleared only
on the next valid in-range edit. To still clear a *stale* warning when a different
video loads, there is a second `useEffect` keyed on `video` (not `targetFps`) -- a
new source clears it, but the same-video clamp does not. The warning render is also
gated on `probed` so an unprobed video never shows a ceiling warning (acceptance
criterion: no false warning before probe).

General rule for this component: do not pile companion UI state into the
targetFps-keyed sync effect; pick the dependency that fires on the event you
actually mean.
