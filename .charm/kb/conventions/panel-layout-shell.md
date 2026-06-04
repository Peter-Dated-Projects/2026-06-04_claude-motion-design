---
id: panel-layout-shell
root: conventions
type: convention
status: current
summary: "The 3-panel studio layout owns sizing via .panel-slot wrappers in App.tsx; panel components must fill their slot, not set their own width/flex-basis."
created: 2026-06-04
updated: 2026-06-04
---

The UI shell (App.tsx) lays out the three panels as a flex row of `.panel-slot`
wrapper divs. Each slot carries the `flex-basis: <pct>%` that comes from
`useUIStore().panelWidths` (percentages `[chat, code, preview]`, persisted to
localStorage under `claude-motion:panelWidths`). Between slots are `.resize-handle`
divs whose drag conserves the combined width of the two adjacent panels and clamps
each to a 180px minimum.

Convention for the panel components (ChatPanel, CodePanel, PreviewPanel) that
wave-3/4 tickets fill in:

- Do NOT set width, flex-basis, or flex-grow on the panel root. Sizing belongs to
  the `.panel-slot` in App.tsx. The panel root should be `flex: 1 1 auto` with
  `min-width: 0` so it fills the slot and allows shrinking (the `.panel` class
  already does this). Setting your own basis will fight the resize logic.
- Keep `min-height: 0` / `min-width: 0` on internal scroll containers, otherwise
  flex children refuse to shrink and the panel overflows.

The safe-zone toggle in StatusBar is the live source of `showSafeZone` /
`safeZonePlatform` in the UI store; the overlay ticket should read those rather
than tracking its own state.
