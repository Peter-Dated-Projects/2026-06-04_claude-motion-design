---
id: preview-panel-passive-isplaying
root: gotchas
type: gotcha
status: current
summary: "PreviewPanel keeps its OWN read-only frameUpdate listener to mirror isPlaying (auto-hides the safe-zone overlay during play); it is intentional, not a duplicate of ReplayControls' self-wiring -- it never posts commands."
created: 2026-06-04
updated: 2026-06-04
---

There are deliberately TWO `frameUpdate` listeners on `window`:

- `ReplayControls` (T-030) owns playback STATE and commands -- see
  [[replay-controls-self-wired]].
- `PreviewPanel` (T-029) adds a second, **read-only** listener that copies
  `frameUpdate.isPlaying` into local state purely so the safe-zone overlay can
  render as `showSafeZone && !isPlaying` ("auto-off on play"). It posts nothing
  to the sandbox.

This is the scope-clean way to get "auto-off on play" without `PreviewPanel`
owning playback or mounting/altering `ReplayControls`. Do NOT "consolidate" the
two listeners during integration (T-032) thinking one is a bug -- they have
different jobs. Both correctly verify `ev.source === iframeRef.current?.contentWindow`
before trusting a message.

Note also that the user's explicit toggle (`useUIStore.showSafeZone`) is left
untouched during playback -- visibility is the AND of the toggle and not-playing,
so the overlay reappears on pause.
