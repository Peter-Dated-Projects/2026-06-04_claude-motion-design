---
id: mosaic-drag-swallowed-by-iframe
root: gotchas
type: gotcha
status: current
summary: "react-mosaic tile drags snap back because the preview iframe / Monaco swallow the native HTML5 drag as the cursor crosses them; fix is pointer-events:none on .mosaic-window-body while a `panels--dragging` class is set."
created: 2026-06-04
updated: 2026-06-04
---

The three-panel layout is a controlled `<Mosaic value={layout} onChange=...>` in
`src/App.tsx`. The `onChange`/localStorage-persist wiring is correct, yet
dragging a tile by its header used to snap back to the original layout.

Cause: react-mosaic uses react-dnd's HTML5 backend (native HTML5 drag). When the
drag cursor passes over the preview `<iframe>` or the Monaco editor, those heavy
children capture the native drag events, so react-mosaic never registers a valid
drop over a `.drop-target` zone and reverts. The drop-zone overlay CSS only
appears once a drag actually progresses, so it looked like the overlays were
broken too -- they weren't.

Fix (App.tsx + App.css only):
- App.tsx: an `isDragging` state toggled by React `onDragStart`/`onDragEnd`/`onDrop`
  on the `.panels` wrapper (the native drag events bubble through these synthetic
  handlers). It adds a `panels--dragging` class.
- App.css: `.panels--dragging .mosaic-window-body { pointer-events: none; }` drops
  pointer capture on tile *content* for the duration of the drag.

Key DOM fact (verified in node_modules/react-mosaic-component/lib/MosaicWindow.js):
`.drop-target-container` is a SIBLING of `.mosaic-window-body` inside
`.mosaic-window`, not a child. So disabling pointer events on the body does NOT
disable the 5 drop-zone overlays -- they keep receiving dragover/drop. Don't
move the rule up to `.mosaic-window` or you'll kill the drop targets too.
