---
id: image-skills-absolute-px-coords
root: gotchas
type: gotcha
status: current
summary: "remotion-image-skills.txt scene descriptions deliberately use ABSOLUTE px (cx_px/cy_px on the fixed 1080x1920 canvas), not fractional (cx:0.5); do not 'fix' it back to fractions -- there is no portability benefit and fractions add a per-element conversion step."
created: 2026-06-08
updated: 2026-06-08
---

# Image-skills scene coordinates are absolute px, on purpose

`src-tauri/resources/remotion-image-skills.txt` Step 1 tells the model to describe
element positions in **absolute pixels** (`cx_px` / `cy_px` for centers, `w_px` /
`h_px` for sizes) on the fixed 1080x1920 canvas, and the Step 2 UI Card recipe
consumes them directly (`left: cx_px - w_px/2`).

This replaced an earlier fractional convention (`cx: 0.5`, `cy: 0.3`) plus a
`cx * 1080` / `cy * 1920` conversion formula. Do not revert it.

**Why fractional looks tempting but is wrong here:** the general image-to-code
literature is genuinely split, and several VLM systems report that *normalized*
coordinates extract more reliably from an image of arbitrary size. But that benefit
is about portability across unknown canvas sizes. This canvas is **fixed** at
1080x1920 -- there is no other size to port to. Fractional coords buy nothing and
cost a multiply-before-you-can-use-it arithmetic step on every element, which
accumulates error and is a frequent source of off-by-canvas-size bugs.

**Related design call (F18):** Step 1 was also changed from a hidden 50-field JSON
schema ("produce this internally, do not paste") to a *visible* 2-3 sentence
analysis. Hidden structured generation is unreliable without extended thinking;
visible output guarantees the step happens. So if you go looking for the old
JSON schema to edit its coordinate fields, it no longer exists -- the px convention
now lives in the prose analysis guidance and the Step 2 recipe instead.

The P-role color mapping in the BRANDED SLIDE recipe (darkest dominant -> bg,
lightest ground -> surface, primary text -> ink, secondary -> muted, distinctive
brand color -> accent; light-on-dark -> P1/P2/P3 base, dark-on-light -> P4/P5) uses
the role names defined in `remotion-skills.txt` Section 5 -- keep them in sync if
that palette token set ever changes.
