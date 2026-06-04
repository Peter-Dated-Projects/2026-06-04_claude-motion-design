---
id: projects-root-resolved-in-four-places
root: gotchas
type: gotcha
status: current
summary: "The projects storage root is hand-duplicated in FOUR files (projects.rs, claude_bridge.rs, export.rs, zip.rs); they must all agree or create/list, the PTY+watcher, and export/import diverge onto different folders."
created: 2026-06-04
updated: 2026-06-04
---

There is no single shared `projects_root()` helper. The path to the project store
is copy-pasted into four separate functions, and they MUST resolve to the same
directory or different features silently operate on different folders:

- `commands/projects.rs::projects_root()` — create/list/open/delete/save/load + Reveal in Finder.
- `claude_bridge.rs::project_dir()` — PTY cwd and the animation.tsx file watcher.
- `commands/export.rs::projects_root()` — source folder for `export_project_zip`.
- `commands/zip.rs::projects_root()` — source/target for `export_project_zip`/`import_project_zip`.

T-007 moved the root from `app_data_dir/projects` to
`document_dir/ClaudeMotion/projects`. The ticket `touches` and decision note
(0002) both claimed the root lived in "two places" — that undercount missed
export.rs and zip.rs. The scope was expanded mid-ticket to cover all four (an
atomic move; leaving export/zip stale would have hit the old empty app_data
folder: export "project not found", imports landing where `list_projects` never
looks), so as of T-007 all four resolve `document_dir().join("ClaudeMotion").join("projects")`.

The trap is now latent, not active: the duplication remains. Any future move of
the projects root MUST touch all four call sites in lockstep, or features
silently diverge. Better long-term: collapse the four onto one shared helper so
the next move is a single edit -- not done here to keep T-007 within a bounded
scope, but worth a dedicated refactor.
