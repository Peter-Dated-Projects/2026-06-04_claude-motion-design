---
id: 0003-react-mosaic-panel-layout
root: decisions
type: decision
status: current
summary: "Replace the hand-rolled fixed 3-panel resize layout with react-mosaic-component tiling so the user can drag panels by their headers to rearrange into any horizontal/vertical split; chosen over a zero-dep custom toggle and over full dockview IDE docking."
related:
  - conventions/panel-layout-shell
  - conventions/app-owns-loop-state
created: 2026-06-04
updated: 2026-06-04
---

## Decision

Use the `react-mosaic-component` library for the 3-panel shell (terminal | editor |
preview). Each panel becomes a draggable mosaic tile; the user drags a tile by its
header to re-tile into any horizontal/vertical arrangement, with resizable dividers.
This replaces the hand-rolled `.panels` / `.panel-slot` / `.resize-handle` drag logic
in `App.tsx` and the `panelWidths` plumbing.

## Why

The user wants VS Code-style "grab a window and reposition it, stacked horizontally
or vertically." Three options were weighed:

- **react-mosaic (chosen)** — a tiling window manager whose model (drag tiles to
  re-split) matches the request most directly; MIT, well-maintained, modest dep.
- **Lightweight custom** (row/col toggle + drag-reorder, zero-dep) — simpler but
  not free-form; rejected as not matching the "drag anywhere" ask.
- **dockview** (full IDE docking: tabs, floating, arbitrary nesting) — more powerful
  than 3 panels need; rejected as heavier than warranted.

## Implementation notes

- Add `react-mosaic-component` (+ its `react-dnd` / `react-dnd-html5-backend` peers
  if the installed version requires them) to `package.json`; import the library CSS.
- It ships a **light** theme by default — must apply `mosaic-blueprint-theme` or a
  custom dark override so it matches the app's dark palette (no white chrome).
- Keep the existing panel components and their props/wiring unchanged
  (see [panel-state-via-parent-props](../conventions/panel-state-via-parent-props.md));
  only the shell that arranges them changes.
- Persisting the layout to localStorage is a nice-to-have (mirrors the old
  `panelWidths` persistence), not required for v1.
