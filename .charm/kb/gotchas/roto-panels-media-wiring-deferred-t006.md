---
id: roto-panels-media-wiring-deferred-t006
root: gotchas
type: gotcha
status: superseded
summary: "(RESOLVED in T-006) The roto Assets/Outputs panels (T-005) shipped images-only + a store-driven outputs LIST; video listing, output thumbnails, and double-click PNG-sequence playback were deferred to T-006, which has now landed all three."
created: 2026-06-06
updated: 2026-06-06
related:
  - roto-media-wiring-landed-t006
---

> **RESOLVED by T-006** -- all three gaps below are now wired. See
> [[roto-media-wiring-landed-t006]] for what shipped. Kept for history.


RotoAssetsPanel and RotoOutputsPanel (T-005) deliberately ship a SUBSET. Three
behaviors the proposal/UX spec call for were cut because nothing backs them, and
the two-file frontend scope could not add the backing surface. They are marked
`// TODO(T-006):` in both files and owned by T-006 (depends on T-005 + T-004).

What is missing, and why each is a real blocker (not an oversight):

1. **List source VIDEOS with absolute paths.** `list_assets` filters to image
   extensions only and returns `{name, dataUri}` with NO path; `list_project_files`
   excludes `assets/` entirely; and source videos are referenced in place / never
   copied into the project (proposal). So there is no command that yields project
   videos, and `rotoStore.loadVideo` needs an ABSOLUTE path. T-006 needs either a
   new backend enumeration command or a file-picker (native drag-drop / dialog,
   like IG's VideoPreviewPanel `onDragDropEvent`) to source the path.

2. **Output thumbnails.** The first-PNG thumbnail needs a PNG filename, but
   `meta.json` carries `frame_count` only (no filenames) and nothing enumerates
   files under `assets/rotoscope_*/`. Asset-protocol scope already covers
   `assets/**` in tauri.conf.json, so once a command lists the PNGs,
   `convertFileSrc(absPath)` will render them.

3. **Double-click output -> looping stop-motion in the left preview.** rotoStore
   models only a single source `video` (one `LoadedVideo` path played via a
   `<video>` element in RotoVideoPanel). There is NO field/action for a loaded
   PNG SEQUENCE. T-006 must extend rotoStore (a sequence model) AND have
   RotoVideoPanel render it; a PNG sequence cannot be played through `<video>`.

The store contract that DOES work today: `rotoStore.outputs` (populated by
`jobComplete` after a successful `rotoscope_video`) drives the outputs LIST, so
the list auto-refreshes when a job completes -- no enumeration command needed
just to show rows (label + frame count).

Related: [[roto-output-under-assets-not-in-scope]] (asset-protocol scope, now
widened to assets/**), [[extraction-list-rows-text-only-by-design]] (the IG
analogue: a panel shipped text-only because convertFileSrc was out of scope).
