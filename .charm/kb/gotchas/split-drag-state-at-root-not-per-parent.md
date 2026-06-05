---
id: split-drag-state-at-root-not-per-parent
root: gotchas
type: gotcha
status: current
summary: "SplitLayout's header drag-to-rearrange keeps its state at the ROOT component (not per-ParentNode like resize) because a drag spans the whole tree; it captures the header pointer for the 4px threshold then RELEASES capture and hands off to a fixed full-viewport shield so the preview iframe / Monaco never swallow the move stream."
created: 2026-06-04
updated: 2026-06-04
---

`src/components/PanelLayout/SplitLayout.tsx` has two distinct pointer
interactions that look similar but are scoped differently:

- **Gutter resize** state (`resizing`) lives in `ParentNode` -- a resize is local
  to one split's gutter.
- **Header drag-to-rearrange** state (`dragId` / `dragStarted` / `dropTarget`)
  MUST live in the top-level `SplitLayout` component, because a drag starts on
  one leaf's header and ends on a *different* leaf. Pushing it into the leaf or
  ParentNode would scope it to the wrong subtree. The leaves only receive a small
  `drag` API threaded down through `Node` props.

Non-obvious mechanics worth knowing before you touch this:

- **Capture-then-release handoff.** On header `pointerdown` we `setPointerCapture`
  on the header so the first moves can't be missed if the cursor leaves the
  header fast. The moment travel exceeds `DRAG_THRESHOLD` (4px) we `measureLeaves`,
  flip `dragStarted`, and immediately `releasePointerCapture` so the next move
  hits the fixed `.split-drag-shield` instead. Keeping capture on the header would
  starve the shield. This is the same WKWebView shield trick resize uses
  (see [[split-resize-needs-fixed-shield-over-iframe]] and
  [[mosaic-drag-swallowed-by-iframe]]) -- the shield physically covers the
  preview iframe / Monaco so they can never intercept the pointer.

- **Leaf rects are frozen at drag start.** `measureLeaves()` snapshots each
  `[data-panel-id]` element's `getBoundingClientRect` into a ref once, at threshold
  crossing. The tree doesn't mutate until drop, so these viewport-coord rects stay
  valid for the whole gesture and drive both the drop-zone hit test and the
  fixed-position highlight overlay. The highlight (`z-index:10000`,
  `pointer-events:none`) sits ABOVE the shield (`z-index:9999`) but is inert so it
  never eats the drag's events.

- **Zone classification is nearest-edge, not first-match.** `zoneFromRect` takes
  the min normalized distance to the four edges; if that min is under the 0.25
  band it's that edge, else center. This resolves corners deterministically
  instead of letting left/top win by accident.

- **Tree surgery mirrors App.tsx exactly.** Edge drops do `removeLeaf(dragged)`
  (collapsing the dragged panel's old parent into its sibling, same as App.tsx's
  removeLeaf / [[panel-visibility-tree-surgery]]) then `insertBeside` wraps the
  target leaf in a new row/column split (`splitPercentage:50`). Center does an
  in-place `swapLeaves` that preserves all existing split percentages. Dropping on
  your own leaf, or a single visible panel, is a no-op (target === dragId yields a
  null dropTarget). Escape and `pointercancel` abort with no `onChange`.

Live drag feel over the iframe is a human gate -- not observable in the headless
WKWebView harness. Type-clean + compiling is the automated bar.
