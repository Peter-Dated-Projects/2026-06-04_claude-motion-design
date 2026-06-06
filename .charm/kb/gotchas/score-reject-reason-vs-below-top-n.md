---
id: score-reject-reason-vs-below-top-n
root: gotchas
type: gotcha
status: current
summary: "score.ts has THREE not-kept outcomes but the frozen RejectReason has only two values; a survivor that ranks outside the top MAX_KEPT_FRAMES comes back kept:false with NO rejectReason (below-top-N is the ABSENCE of a reason, not a third enum value)."
created: 2026-06-06
updated: 2026-06-06
---

The ticket prose for the score stage described three reject reasons --
`low-delta`, `low-sharpness`, and `below-top-N` -- but the FROZEN `RejectReason`
in `scripts/ig-pipeline/types.ts` has exactly two values:
`"insufficient_change"` (low delta) and `"low_sharpness"`. There is no
`below-top-N` value, and `types.ts` is a frozen Wave-1 contract (and outside the
score ticket's `touches`), so it can't be extended locally.

The resolution `score.ts` ships with: a frame has THREE possible not-kept
outcomes, mapped onto the two-value contract like this:

- rejected by the delta filter  -> `kept:false`, `rejectReason:"insufficient_change"`
- rejected by the sharpness floor -> `kept:false`, `rejectReason:"low_sharpness"`
- passed BOTH filters but ranked outside the top `MAX_KEPT_FRAMES`
  -> `kept:false`, and **`rejectReason` is left `undefined`**.

So "below-top-N" is represented as the *absence* of a reject reason, not as a
third enum value. The distinction is meaningful: a below-top-N frame was good
enough to survive every quality gate; it just lost the ranking. It was not
rejected for quality.

Consumer implications:
- Do NOT assume `kept === false` implies a `rejectReason` exists. Test
  `rejectReason === undefined` to detect the below-top-N case.
- The CLI table (`score.ts formatTable`) prints the literal string
  `below-top-N` for these rows for human readability, but that string is a
  display label only -- it is never stored on the `ScoredFrame` and is not a
  `RejectReason`.
- If a future change really needs below-top-N as a first-class reason, that is a
  `types.ts` contract change (raise it), not a local patch in `score.ts`.
