---
id: roto-panel-context-menu-reuses-inline-state
root: conventions
type: convention
status: current
summary: "Roto side panels persist grid/list view to per-panel localStorage keys, and their RotoContextMenu actions reuse each row's existing inline transient state (export-format picker, delete-confirm) rather than building menu-specific UI."
created: 2026-06-07
updated: 2026-06-07
---

The rotoscoping side panels (`RotoAssetsPanel`, `RotoOutputsPanel`) share two idioms
worth following when adding actions:

1. **View toggle persistence.** The grid/list toggle is component-local `useState`
   seeded from, and written back to, a per-panel `localStorage` key:
   `claude-motion:rotoAssetsView` and `claude-motion:rotoOutputsView`. Each panel
   persists independently; do not share one key.

2. **Context menu reuses inline state, never duplicates UI.** `RotoContextMenu`
   (the shared portal primitive) is purely presentational. Consumers do NOT build a
   second copy of any action's UI for the menu. Instead the menu item flips the SAME
   per-row state that the inline button would have:
   - "Export as..." sets `exportState[dir] = "picking"`, which renders the existing
     inline GIF/MP4/MOV format picker in the row/card.
   - "Delete" sets `confirmingDelete[dir] = true`, which renders the existing inline
     "Delete? This removes all frames..." confirm prompt -- the destructive call only
     fires after the user confirms there.

   This keeps a single source of truth per behavior and preserves the confirmation
   step regardless of whether the action was triggered inline or via right-click.

3. **Menu shape is stable: disable, don't hide.** Conditional actions (Compare with no
   source, Open video with no composed video) are emitted as `disabled` menu items, not
   omitted, so the menu's row order doesn't shift between outputs.
