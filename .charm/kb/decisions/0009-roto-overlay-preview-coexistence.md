---
id: roto-overlay-preview-coexistence
root: decisions
type: decision
status: current
summary: "In RotoVideoPanel, the point-placement overlay and clip preview coexist via showOverlay = !playing && atReferenceFrame: rest-on-frame-0 shows PointOverlay, playing/scrubbing off frame 0 shows a live preview <video>, and Rewind (|<) homes the playhead to re-show the overlay -- no lock/unlock mode."
created: 2026-06-07
updated: 2026-06-07
---

## Decision

RotoVideoPanel (T-010) shows ONE editor surface, not a mode switch. The SAM2
reference frame is implicitly clip frame 0 (`clipStart`, else 0; see
[[roto-reference-frame-is-clip-frame-zero]]). The point-placement overlay and the
transient clip-preview playback coexist via a single derived flag:

```
showOverlay = !playing && atReferenceFrame   // |currentTime - (clipStart ?? 0)| < ~0.04s
```

- At rest on the reference frame: render `PointOverlay` (points on frame 0).
- Playing, or scrubbed off the reference frame: hide the overlay and show a live
  preview `<video>` (the row-2 transport drives it).
- The Rewind button (`|<`) and any region re-anchor (dragging `clipStart`) home the
  playhead back to the reference frame, which restores the overlay. Points live in
  the store and are never cleared by playback, so they survive a preview round-trip.

Both `PointOverlay` (its own seeked `<video>`) and the preview `<video>` are kept
mounted at all times; only their CSS visibility toggles (`display:none`), so neither
reloads/reseeks on every play/pause.

## Why

PROJECT.md left this as an open question: row-2 has play/rewind/skip, but the
overlay is anchored to frame 0. A hard "lock/unlock" mode was explicitly rejected
in discovery (decision #4). The derived-flag approach gives "play to preview the
clip" and "points always on frame 0" without the user ever toggling a mode -- the
overlay simply appears whenever you are parked on the reference frame.

## Consequences

- The preview `<video>` is ALSO the only source of source `duration`: the store's
  `LoadedVideo.durationSeconds` is never probed (see [[roto-video-duration-fps-never-probed]]),
  so the seek track reads duration from the element's `loadedmetadata`. The element
  is kept mounted (display:none, not unmounted) partly so this fires.
- Clear / Select-Region drag write `clipStart`/`clipEnd`; setting `clipStart` while
  not playing homes the playhead so the overlay follows the new frame 0.
- Frame readout uses `video.fps` when probed, else the `~30fps` fallback wording;
  since fps is currently never probed it always shows `~30fps` today (correct per
  the acceptance criterion, and self-fixes if a probe lands).

Source: `.charm/PROJECT.md` (Roto Editor & Controls UX, open question #1) + ticket
T-010 + `src/components/RotoPanel/RotoVideoPanel.tsx`.
