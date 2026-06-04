---
id: replay-autoplay-first-render-only
root: gotchas
type: gotcha
status: current
summary: "ReplayControls must autoplay only the first sandbox renderOk per session (hasAutoplayedRef); posting play on every renderOk hijacks playback on every recompile while iterating."
created: 2026-06-04
updated: 2026-06-04
---

The sandbox iframe emits a `renderOk` message every time a freshly compiled animation
renders -- which happens on EVERY successful recompile (Claude edits, editor edits,
hot reloads), not just the first load.

The original ReplayControls handler did `post({ type: "play" })` unconditionally on
`renderOk`, so playback restarted from wherever the sandbox reset to on every code
change. While iterating on an animation this is very disruptive: you pause to inspect a
frame, change one line, and it jumps back into playing.

Fix (T-009): gate autoplay behind a `hasAutoplayedRef` so only the very first
`renderOk` of the session triggers play. Subsequent recompiles do nothing, leaving the
sandbox in whatever play/pause state it was already in. If you ever need
"autoplay on demand" again, make it an explicit user action or setting -- do not key it
off `renderOk`.
