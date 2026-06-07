---
id: roto-reference-frame-is-clip-frame-zero
root: decisions
type: decision
status: current
summary: "The roto SAM2 reference frame is always frame 0 of the selected clip (clipStart, or frame 0 if no region) -- derived automatically at enqueue, not picked via a manual 'Set Start Frame' lock step which was removed."
created: 2026-06-07
updated: 2026-06-07
---

## Decision

In the rotoscoping editor, the reference frame from which SAM2 propagates masks is
**always frame 0 of the selected clip** -- i.e. `clipStart` in seconds, or frame 0
when no clip region is set. It is computed automatically (`round(clipStart * fps)`,
else 0) at job-enqueue time rather than stored from a manual user gesture.

## Why

The old flow overloaded two distinct "start" concepts onto adjacent buttons:
"Set Start" (clip trim start) and "Set Start Frame" (SAM2 reference lock). Users
conflated them. The manual lock step also forced a mode swap -- the `<video>` was
replaced by `PointOverlay` only once `startFrame` was set, so scrubbing and point
placement could never be seen together.

Collapsing the reference frame to "frame 0 of the clip" removes the second "start"
concept entirely: there is one region selection, and points are always placed on
its first frame. Flow becomes: load video -> (optionally) select region -> place
points -> Generate.

## Consequences

- "Set Start Frame" button + `roto-video__set-start` CSS + the locked-bar
  ("Reference frame: N" / "Change frame") are removed.
- The store's `startFrame` is no longer set by a manual action; it is derived from
  `clipStart` at enqueue (in `useRotoJobQueue`).
- Clip region selection switched to a drag-on-track interaction (draggable
  start/end handles on the row-1 clip track) that must coexist with seek-on-click.
- `PointOverlay` is anchored to the reference frame and re-anchors when the region
  is dragged. Open micro-interaction: how transient clip *preview* playback (the
  new row-2 play/rewind/skip controls) coexists with the overlay being pinned to
  frame 0.

Source: `.charm/proposals/PROPOSAL-roto-editor-controls-ux.md` +
`.charm/PROJECT.md` (Roto Editor & Controls UX Improvements).
