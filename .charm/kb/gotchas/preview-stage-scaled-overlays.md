---
id: preview-stage-scaled-overlays
root: gotchas
type: gotcha
status: current
summary: "The preview phone stage renders at composition size (1080x1920) then CSS-scales to fit; overlays drawn inside it must divide stroke widths and font sizes by the scale factor or they vanish/balloon."
created: 2026-06-04
updated: 2026-06-04
---

# Preview stage is rendered at composition size, then scaled

`PreviewPanel` renders the phone bezel + iframe at the canonical composition size (1080x1920, plus bezel chrome) and applies a single CSS `transform: scale(...)` to fit the container. The scale factor is typically ~0.2-0.3.

Consequence for anything drawn *inside* that scaled stage (e.g. `SafeZoneOverlay`, future caption/marker overlays):

- A `1px` border becomes sub-pixel (~0.2px) and effectively invisible.
- A `12px` font renders at ~3px and is unreadable.

Fix: such components take the `scale` prop and divide fixed visual sizes by it (`px(n) => n / scale`) so the on-screen result is the intended size. Region geometry (the safe-zone insets) stays in composition px — only strokes/text need the division.

The fit math lives in `PreviewPanel`'s ResizeObserver effect and fits `BEZEL_OUTER_WIDTH/HEIGHT` (exported from `PhoneBezel`), not the bare 1080x1920, so the bezel chrome never clips against the container edge.

Two soft requirements from T-029's spec were deliberately left for the integration pass, both because their inputs do not exist yet:

- "Safe Zone toggle defaults on during editing" — `useUIStore.showSafeZone` defaults to `false` and `uiStore.ts` was outside T-029's `touches`. Flip the default during integration (T-032) if desired.
- "auto-off on play" — there is no playback state wired into `useUIStore` yet (comes with the replay controls, T-030). Hook `showSafeZone` off the play state once it lands.
