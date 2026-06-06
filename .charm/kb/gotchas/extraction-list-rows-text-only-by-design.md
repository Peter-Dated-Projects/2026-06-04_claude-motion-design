---
id: extraction-list-rows-text-only-by-design
root: gotchas
type: gotcha
status: current
summary: "ExtractionListPanel (T-030) renders TEXT-ONLY file-tree rows and deliberately ignores IGExtractionListItem.thumbnailPath -- displaying a local frame needs convertFileSrc (Tauri asset protocol), which was outside the panel's Tauri-free scope; the integration pass should swap in the image, not 'fix' a missing thumbnail."
created: 2026-06-06
updated: 2026-06-06
---

`src/components/IGWorkspace/ExtractionListPanel.tsx` lists past extractions as
plain `date + id` rows with a neutral glyph placeholder. `IGExtractionListItem`
carries a `thumbnailPath` (absolute path to a representative frame), but the panel
never dereferences it.

This is intentional, not an oversight. Rendering a local file in the Tauri webview
requires `convertFileSrc` from `@tauri-apps/api/core` (which only resolves because
the asset protocol is enabled by T-028). T-030's scope was strictly presentational
+ dispatch -- "no `invoke`/`listen`, no Tauri/FS access" -- so loading the image
was deferred rather than smuggling a Tauri import into the panel.

For the integration ticket: to show real thumbnails, wrap `item.thumbnailPath` in
`convertFileSrc(...)` and render an `<img>` with an `onError` fallback to the
existing placeholder glyph. Do NOT add disk reads/parsing here -- the store list
is populated upstream (enumeration of `extractions/` + `extraction.md` frontmatter
is the integration hook + backend command's job).
