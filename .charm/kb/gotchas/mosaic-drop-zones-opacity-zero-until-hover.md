---
id: mosaic-drop-zones-opacity-zero-until-hover
root: gotchas
type: gotcha
status: current
summary: "react-mosaic renders all 5 drop zones but keeps each at opacity:0, flipping only the hovered one to opacity:1 -- so styling .drop-target's background/border alone does nothing until hover; show the edge zones via the .-dragging container and style .drop-target-hover for the active preview."
created: 2026-06-04
updated: 2026-06-04
---

When dragging a MosaicWindow, react-mosaic renders five `.drop-target` zones
(`.left`/`.right`/`.top`/`.bottom` + an unclassed center) inside
`.drop-target-container` on the hovered tile. Stock CSS
(`react-mosaic-component.css`) sets every zone to `opacity: 0` and flips ONLY the
zone under the cursor to `opacity: 1` via `.drop-target-hover`.

Consequence: setting `background`/`border` on
`.drop-target-container .drop-target` (the old App.css rule did exactly this)
changes nothing visible until you hover a zone, and even then only that one zone
shows -- there is no up-front "here are the dock regions" preview. That faintness
is why the indicator went unnoticed (T-015).

Two levers to make it obvious, both CSS-only against the stock markup:
- Hint the four edge zones during a drag by raising their opacity under
  `.drop-target-container.-dragging` (the container gets `-dragging` while a drag
  is active). Leave the center zone hidden until hovered -- it spans the full
  tile and would blanket the edge zones.
- Style `.drop-target-hover` as the strong, high-contrast preview of the landing
  region. The hovered edge zone also grows from a 30% to a 50% inset, so
  transitioning `top/right/bottom/left` animates a "snap into place" preview.

The MosaicWindow toolbar is the default drag source; `toolbarControls={<></>}`
only empties the right-side controls and does NOT disable header dragging.
Related: [[mosaic-blueprint-theme-overrides-dark]].
