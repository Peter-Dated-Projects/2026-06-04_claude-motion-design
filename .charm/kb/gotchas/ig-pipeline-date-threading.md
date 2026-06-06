---
id: ig-pipeline-date-threading
root: gotchas
type: gotcha
status: current
summary: "ig-pipeline download() and resolveExtractionPaths() each default `date` to a fresh new Date(); a composer that calls them separately can derive two different `<YYYY-MM-DD>_<id>` folder names across a midnight boundary. The orchestrator must resolve ONE Date and thread it to both."
created: 2026-06-06
updated: 2026-06-06
---

Both `download(input, outDir, { date })` (download.ts) and
`resolveExtractionPaths(outRoot, id, { date })` (lib/paths.ts) accept an optional
`date` and **independently default it to `new Date()`**. The extraction folder
name is `<YYYY-MM-DD>_<sourceId>`, so the date is part of the path identity.

The footgun: the URL branch of `download()` resolves its own paths internally
(to write `source.mp4`), and the orchestrator resolves them again afterward to
hand to the later stages. If each call defaults its own `date`, a run that
crosses midnight between the two calls writes `source.mp4` into one dated folder
and then runs clip/frames/store against a *different* dated folder -- the source
file silently goes missing from the folder the rest of the pipeline uses.

Fix (what `run.ts` does): resolve `const date = new Date()` once at the top of
the run and pass that same instance to **both** `download(..., { date })` and
`resolveExtractionPaths(..., { date })`. Any future code that composes these two
stages must thread one shared Date, never let each default its own.

Related: [[ig-frames-4digit-vs-store-3digit]] (the other shared-layout constraint
between stages).
