---
id: panel-visibility-tree-surgery
root: conventions
type: convention
status: current
summary: "Showing/hiding mosaic panels is manual MosaicNode tree surgery in App.tsx: getLeaves() is the source of truth for which panels are visible, removeLeaf collapses a hidden panel's parent into its sibling, addLeaf docks a re-added panel as a new row split, and a null layout (all hidden) renders an empty state."
created: 2026-06-04
updated: 2026-06-04
---

react-mosaic has no built-in "remove this leaf by id" or "add this leaf" helper,
so panel show/hide in `App.tsx` is done by hand on the `MosaicNode<PanelId>` tree:

- `getLeaves(layout)` (exported by `react-mosaic-component`) is the single source
  of truth for which panels are currently shown -- there is no separate "visible"
  state to keep in sync. It drives the menu checkmarks and the last-panel lock.
- `removeLeaf(tree, id)` walks the tree and, when it drops the target leaf,
  collapses the now-only-child parent into the surviving sibling -- this preserves
  the rest of the user's split arrangement. Returns `null` when the last panel is
  removed.
- `addLeaf(tree, id)` splices a hidden panel back in as a new `row` split, docking
  it left/right per the canonical `PANEL_ORDER` (`["terminal","editor","preview"]`).
- The layout state is `MosaicNode<PanelId> | null`. A `null` layout means every
  panel is hidden; App renders a dedicated empty state with a Reset button instead
  of mounting `<Mosaic value={null}>`. Hiding the last visible panel is disabled in
  the menu, so `null` normally only arises from corrupt/empty persisted state.
- All visibility/reset changes route through the same `applyLayout` that persists
  drags/resizes to `localStorage` (`claude-motion:panelLayout`), so they survive
  reloads identically. `loadLayout()` can now return `null` (stored "null") in
  addition to the default.
- The panel show/hide + reset controls live as a floating cluster on the panels
  region itself, not in the Toolbar (`Toolbar` is a separate component).

Related: [[panel-layout-shell]]. The T-045 `.panels--dragging` pointer-events rule
is independent and must not be altered by panel-management work.
