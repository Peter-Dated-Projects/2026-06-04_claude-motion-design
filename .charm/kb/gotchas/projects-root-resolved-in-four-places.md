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
`document_dir/ClaudeMotion/projects`, but its `touches` scope only covered
`projects.rs` and `claude_bridge.rs`. The decision note (0002) and ticket both
claimed the root lived in "two places" — that undercount missed export.rs and
zip.rs. After T-007, projects are created/read under `~/Documents` while export
and zip still read/write `app_data_dir/projects`, so export finds no project
("project not found") and an import lands where `list_projects` never looks.

Fix: update `export.rs::projects_root()` and `zip.rs::projects_root()` to the
same `document_dir().join("ClaudeMotion").join("projects")`. Better long-term:
collapse all four onto one shared helper so the next move is a single edit.
