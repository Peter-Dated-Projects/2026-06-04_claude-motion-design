---
id: ig-store-has-no-extraction-md-path
root: gotchas
type: gotcha
status: current
summary: "igStore (T-023) carries no dedicated extraction.md path field; the done-state save path can only be sourced by joining the matched IGExtractionListItem.dir + '/extraction.md', and that item only exists once the extraction is in the sidebar list -- a just-finished run may not be there yet."
created: 2026-06-06
updated: 2026-06-06
---

T-031's BriefPanel was asked to show the saved `extraction.md` path in the `done`
state "from the store's done-state, not re-derived." But `IGState` (T-023,
`src/store/igStore.ts`) has no field for it -- its done-state surface is just
`phase`, `brief`, `frames`, plus the sidebar's `extractions` /
`activeExtractionId`. There is no `extractionMdPath` / `extractionDir` on the
active run.

So the only in-scope source (BriefPanel's `touches` is its own file only) is:

```ts
const item = extractions.find((e) => e.id === activeExtractionId);
const mdPath = item ? `${item.dir.replace(/\/+$/, "")}/extraction.md` : null;
```

`dir` is `<out>/extractions/<date>_<id>/` and `extraction.md` is its well-known
leaf (see [[ig-extraction-md-frontmatter]]). The panel renders the path only when
that item exists and omits it otherwise.

Two consequences for the integration ticket (T-032), which owns events->store wiring:

1. A run that JUST finished Phase B is in `phase === "done"` but may not yet be in
   the `extractions` list (or `activeExtractionId` may not point at it), so the
   path silently won't show. If exact done-state path fidelity matters, T-032
   should either populate `extractions`/`activeExtractionId` for the fresh run as
   part of the `store`-stage event, or add a first-class `extractionMdPath` to the
   store done-state. The latter would let the panel stop deriving entirely.
2. The join assumes the `extraction.md` leaf name; it is not read back from the
   backend. If the store-stage filename ever changes, this derivation drifts.
