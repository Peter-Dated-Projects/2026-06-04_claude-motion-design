---
id: split-resize-needs-fixed-shield-over-iframe
root: gotchas
type: gotcha
status: current
summary: "Pointer-driven gutter resize in the custom SplitLayout needs a position:fixed full-viewport shield (with the SAME pointermove/up handlers as the gutter) mounted while resizing -- setPointerCapture alone is unreliable in WKWebView when the cursor crosses the preview iframe / Monaco."
created: 2026-06-04
updated: 2026-06-04
---

`src/components/PanelLayout/SplitLayout.tsx` renders the three-panel layout and
handles gutter RESIZE with pointer events (it replaced react-mosaic's `<Mosaic>`
renderer, whose react-dnd HTML5-drag backend was swallowed by the preview iframe
/ Monaco -- see [[mosaic-drag-swallowed-by-iframe]]).

The trap: `setPointerCapture` on the gutter is NOT enough on its own. In
WKWebView, when the drag crosses the preview `<iframe>` or the Monaco editor,
pointer capture is flaky and those heavy children can still intercept the
pointermove stream, so the split jumps or freezes mid-drag.

Fix (the crux): while `resizing` is true, mount a `position: fixed; inset: 0;`
transparent shield at a very high z-index with `pointer-events: auto`, and bind
the SAME `onPointerMove` / `onPointerUp` / `onPointerCancel` handlers to BOTH the
gutter and the shield. The shield physically covers the iframe so it can never
see the pointer; the duplicated handlers mean whichever element actually receives
the event (gutter when capture holds, shield when it doesn't) still drives the
resize. Removing the shield, or putting handlers only on the gutter, reintroduces
the swallow.

Other non-obvious bits:
- The shield must be `position: fixed`, not absolute -- it has to escape the
  panel's `overflow: hidden` and cover the whole viewport.
- Pane sizing uses `flexGrow: pct` / `flexGrow: 100 - pct` with `flexBasis: 0`
  (not width %), so the 6px gutter is subtracted from available space
  automatically and the ratio stays exact.
- The percentage is computed from the resizing PARENT's container rect
  (`getBoundingClientRect`), not the viewport, so nested splits resize correctly.

Resize feel over the iframe is a human gate -- it is not observable in the
headless WKWebView test harness.
