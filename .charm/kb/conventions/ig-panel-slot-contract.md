---
id: ig-panel-slot-contract
root: conventions
type: convention
status: current
summary: "The IG stage exposes four fixed PanelId slots (ig-extraction-list/ig-preview/ig-frame-grid/ig-brief); a panel ticket fills one by adding its renderPanel case in App.tsx -- no registry, but the panel is mounted-once/detached-when-hidden (NOT remounted per stage entry) so per-project reset is the panel's own job."
created: 2026-06-06
updated: 2026-06-06
---

The Instagram workspace stage (added in T-024) defines four panel slots as
`PanelId` values in `SplitLayout.tsx`:

- `ig-extraction-list` -- left sidebar (title "Extractions")
- `ig-preview` -- top-left of main area (title "Reel")
- `ig-frame-grid` -- top-right of main area (title "Frames")
- `ig-brief` -- bottom of main area (title "Brief")

Arrangement lives in `IG_LAYOUT` in `workspaceStore.ts` (the `ig` WORKSPACE_DEF).

## How a panel ticket fills a slot

Add a `case "<slot-id>":` to the `renderPanel` switch in `App.tsx` returning the
real component. Today all four fall through to a shared `IgPanelPlaceholder`.
No registry -- a switch case is the whole wiring at this size. Each slot already
has its `PANEL_TITLES` entry and `PANEL_ORDER` position (after the three
singletons), so no further plumbing is needed.

## Lifecycle gotcha -- mounted-once, NOT remounted per entry

`SplitLayout`'s `mountedIds` is MONOTONIC: a panel id, once rendered, stays
mounted and merely DETACHES (its host div is removed from the visible tree) when
hidden -- it does NOT unmount on leaving the IG stage. So an IG panel behaves
like the terminal/preview/editor singletons: it retains React state across
workspace switches. Do NOT assume a fresh mount per stage entry to reset
project-scoped state. Reset on project switch is the panel component's own
responsibility (e.g. an effect keyed on the active project slug).

## Stage scoping

The `ig` def's `availablePanels` is exactly the four IG ids, so the stage's
show/hide menu offers only those; the `editing` stage still offers only
terminal/editor/preview. The stage is purely additive -- it does not touch the
shared singletons or the editing layout. See [[panel-layout-shell]] for how the
slot wrapper owns sizing.
