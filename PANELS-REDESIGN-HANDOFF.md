# Panels Redesign -- Handoff Notes

A self-contained record of the panels layout redesign: why we replaced
react-mosaic, the architecture we chose, and what shipped. The redesign is now
code-complete (see Status); the only open item is a human drag-feel check in the
running app.

## The problem we're solving

The 3-panel workspace (Chat/Claude | Code | Preview) used `react-mosaic-component`
for its draggable tiling layout. Two things were broken:

1. **Drag never worked.** react-mosaic 6.2 drives drag-and-drop through
   react-dnd's HTML5 native-drag backend. Native HTML5 drag breaks the moment the
   cursor crosses the preview `<iframe>` or the Monaco editor -- those children
   capture the drag events, react-mosaic never registers a valid drop, and the
   layout snaps back. An earlier patch (pointer-events:none on the tile body
   during drag) did not hold in WKWebView, whose HTML5-DnD implementation is
   flaky.
2. **Theming fought us.** We maintained ~28 `.mosaic-*` CSS overrides just to drag
   the library's built-in chrome into our theme.

## Decision

Replace react-mosaic with a custom layout built on **pointer events** (not HTML5
drag), using a **full-viewport transparent shield overlay** during any
drag/resize. The shield sits above the iframe/Monaco (z-index 9999), so those
children never see the pointer -- which is exactly why this works where native
drag failed. Chosen layout model: **full free-form tiling** (any panel into any
edge/center zone, nested splits), rebuilt on pointer events.

## Architecture

- **Keep the existing layout tree shape.** `LayoutNode` is identical to the old
  `MosaicNode<PanelId>`: a leaf is a panel id string; a parent is
  `{ direction: 'row'|'column', first, second, splitPercentage? }`. Keeping the
  shape means the persisted layout, `removeLeaf`/`addLeaf`, `DEFAULT_LAYOUT`, the
  localStorage persistence, and the Panels show/hide/reset menu all keep working
  unchanged. We swapped only the renderer and the drag mechanism, not the model.
- **The shield overlay is the crux.** During a gutter resize (and, once built, a
  panel drag), a `position:fixed; inset:0; z-index:9999` transparent div is
  mounted to capture all pointer moves. Pointer capture on the gutter handles the
  same-document case; the shield guarantees coverage over the heavy iframe/Monaco
  children where pointer capture across browsing contexts is unreliable.

## Status (commits on `main`)

The redesign was completed across three tickets. All code is committed and the
combined production build passes (tsc + vite).

- **T-051 -- DONE and VALIDATED.** Commit `2778401`. Custom `SplitLayout`
  (recursive renderer + pointer-driven gutter resize + shield). Confirmed live
  that dragging a gutter to resize works smoothly, including over the preview --
  so the shield technique is proven in WKWebView. This was the whole gamble of
  the redesign; it paid off.
- **T-054 -- DONE.** Commit `c07dd93`. Pointer-driven drag-to-rearrange: drag a
  panel by its header, hit-test the 5 edge/center drop zones, show a live drop
  indicator, restructure the tree on drop (immutable surgery mirroring
  `removeLeaf`; Escape / `pointercancel` abort cleanly). Uses the same shield
  mechanism as T-051. `tsc` clean. (Originally tracked as T-052.)
- **T-055 -- DONE.** Commit `82df3a7`. Removed the `react-mosaic-component`
  dependency (lockfile updated), deleted the dead `.mosaic-*` / `.drop-target*` /
  `.panels--dragging` CSS overrides in `App.css` (-138 lines), and stripped the
  dead HTML5-drag scaffolding (`isDragging`, `onDragStart`/`onDragEnd`/`onDrop`,
  the `mosaic-light` class) from `App.tsx`. (Originally tracked as T-053.)

**Open item:** the live drag-and-drop *feel* in WKWebView -- drop-zone
highlighting, the 25% edge bands, center-swap -- can only be confirmed by a human
in the running app; it is not headlessly observable. Resize over the preview is
already validated, and drag reuses the same shield, so it is expected to work.

## Key files

- `src/components/PanelLayout/SplitLayout.tsx` -- the custom layout component
  (exports `PanelId`, `LayoutNode`, `getLeaves`; recursive render; gutter resize;
  shield).
- `src/components/PanelLayout/SplitLayout.css` -- its styles (gutters, shield,
  light theme).
- `src/App.tsx` -- holds the layout state, `DEFAULT_LAYOUT`, `removeLeaf`/`addLeaf`,
  the `PanelsControls` show/hide/reset menu, and the all-hidden empty state.
- `src/App.css` -- still contains the old react-mosaic overrides (removed in T-053).

## Live validation

Live drag/resize behavior is only testable by a human in the running app --
WKWebView pointer behavior can't be validated headlessly. Resize (T-051) is
confirmed; the remaining check is the drag-to-rearrange feel (T-054), which
reuses the same shield mechanism.
