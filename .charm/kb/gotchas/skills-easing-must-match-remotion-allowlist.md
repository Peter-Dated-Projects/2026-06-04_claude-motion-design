---
id: skills-easing-must-match-remotion-allowlist
root: gotchas
type: gotcha
status: current
summary: "remotion-skills.txt Section 3 EMOTION easing names must stay inside the Section 1 Remotion allowlist (Easing.bezier/linear/in|out|inOut(cubic|ease)); CSS-isms like ease-out-back/ease-out-expo/ease-in-out-sine are NOT Remotion APIs and error or silently fall back. Overshoot comes from the spring/scale, not the bezier."
created: 2026-06-08
updated: 2026-06-08
---

The skills prompt teaches Claude which easings to use per emotion (Section 3) but
the only easings Remotion actually exposes are listed in Section 1's allowlist:
`Easing.bezier`, `Easing.linear`, `Easing.out(Easing.ease)`, and
`Easing.in/out/inOut(Easing.cubic)`. Before F1, the EMOTION table named
`ease-out-back`, `ease-out-expo`, and `ease-in-out sine` -- none of which are
Remotion APIs. A model copying those produces a runtime error or a silent
fallback.

The fix (F1) maps each emotion to a real Remotion easing, using `Easing.bezier`
with the standard easeOutBack control points `(0.34, 1.56, 0.64, 1)` for the
bouncy ones. Note y2 > 1 is intentional and legal -- that is what produces the
overshoot in the curve.

Two things to keep straight when editing this table again:

1. Any easing you add MUST be expressible with the Section 1 allowlist. If you
   want a new feel, reach for a different `Easing.bezier(...)` control-point set,
   not a named CSS easing.
2. The table's "% overshoot" column is NOT always the bezier's doing. For
   "surprise" the curve is a plain decelerate `(0.0,0.0,0.2,1.0)` and the
   15-25% overshoot comes from the spring/scale animation, not the easing.
   Don't try to bake overshoot into a curve whose y stays in [0,1].

Sibling skills files (remotion-skills-motion.txt, remotion-skills-layout.txt)
share the same allowlist constraint and the same canonical preset names
(snappy-entrance, smooth-settle, emphasis-pop, heavy-drop, quick-tick) -- keep
them stable across all three files.
