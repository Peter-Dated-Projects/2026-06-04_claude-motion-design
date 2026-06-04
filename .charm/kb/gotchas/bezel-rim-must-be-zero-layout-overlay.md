---
id: bezel-rim-must-be-zero-layout-overlay
root: gotchas
type: gotcha
status: current
summary: "PhoneBezel's visible screen-edge rim is a pointer-events:none absolute overlay, NOT a border on the screen container -- a border would move the padding box the safe-zone overlay anchors to and shift/scale it."
created: 2026-06-04
updated: 2026-06-04
---

The phone screen's visible edge rim in `PhoneBezel.tsx` is drawn as a separate
`position:absolute; inset:0; pointer-events:none` overlay div layered on top of the
screen content, not as a `border` on the screen container.

Why it can't be a border: the safe-zone overlay and other absolutely-positioned
children anchor to the screen container's padding box. Adding a `border` (even with
`box-sizing:border-box`) moves that padding box inward by the border width, so the
overlay shifts and rescales relative to the 1080x1920 frame -- exactly the
misalignment the ticket warns against. A zero-layout overlay adds no box, so the
exported geometry (`SCREEN_WIDTH/HEIGHT`, `BEZEL_OUTER_WIDTH/HEIGHT`) and the
overlay's coordinate frame are untouched.

Related: [[preview-stage-scaled-overlays]] -- the rim is sized in composition
pixels (~6px) so it survives PreviewPanel's CSS scale-down instead of vanishing.
