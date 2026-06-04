---
id: replay-controls-self-wired
root: gotchas
type: gotcha
status: current
summary: "ReplayControls owns all replay state and self-wires the sandbox: it listens for the iframe's own frameUpdate/renderOk and auto-plays on renderOk -- the integration must NOT add a second frameUpdate/renderOk handler in PreviewPanel or play/auto-play double-fire."
created: 2026-06-04
updated: 2026-06-04
---

`ReplayControls.tsx` (T-030) is a drop-in component, not a controlled one. It takes
`{ iframeRef, containerRef?, fps?, defaultTotalFrames? }` and internally:

- attaches its OWN `window` `message` listener (filtered to `iframeRef.current.contentWindow`)
  for `frameUpdate` (syncs currentFrame/totalFrames/isPlaying) and `renderOk`,
- **auto-plays by posting `{type:'play'}` on every `renderOk`** -- this is how
  "auto-play on successful new compilation" is satisfied without PreviewPanel involvement,
- posts play/pause/seek/setSpeed/setLoop to the sandbox via `iframeRef`.

Integration trap (T-032): PreviewPanel already has a `message` handler that consumes
`renderOk` (to clear the loading state). That is fine -- both handlers can observe the
same event. But do NOT add a second auto-play call or a second `frameUpdate` consumer
in PreviewPanel; mounting `<ReplayControls iframeRef={iframeRef} containerRef={containerRef} />`
below the bezel is the entire wiring. Pass the SAME `iframeRef` PreviewPanel already holds.

The Space = play/pause shortcut is also owned here (window keydown, ignored inside
editable elements; scoped to `containerRef` when given), so don't add a duplicate Space
handler. sandbox-frame.html needed no changes -- all command + event handlers were
already present from T-026.
