---
id: project-context-non-source-duplicated
root: gotchas
type: gotcha
status: current
summary: "claude_bridge::write_project_context's CONTEXT_NON_SOURCE exclusion list is a hand-copy of projects.rs::NON_SOURCE (project.json, conversation.json, assets, chats); they live in different modules and must be kept in sync or the per-session context file and the editor file tree disagree on what counts as a source file."
created: 2026-06-05
updated: 2026-06-05
---

The per-session project-context listing (`claude_bridge::write_project_context`,
appended as a third `--append-system-prompt-file` in `pty_bridge.rs::open`) walks
the project dir to tell Claude what source files actually exist. It excludes
metadata/assets exactly like the editor's file tree does -- but the exclusion
list is **hand-duplicated**:

- `commands/projects.rs::NON_SOURCE` -> drives `collect_files` (the file tree).
- `claude_bridge.rs::CONTEXT_NON_SOURCE` -> drives `walk_context` (the prompt listing).

Both are `["project.json", "conversation.json", "assets", "chats"]` plus a
`name.starts_with('.')` dotfile skip. They are duplicated because the two walks
live in different modules and `projects.rs` is outside `pty_bridge`/`claude_bridge`'s
ticket touch scope, so the listing reimplements a small walk rather than calling
`collect_files`. If you change what counts as a non-source file, change BOTH or
the editor tree and Claude's context will disagree (e.g. Claude told a file
exists that the tree hides, or vice versa). Same hand-duplication hazard family
as [[projects-root-resolved-in-four-places]].

Two more load-bearing choices in this path:
- The context file is written to the **config dir** (`claude-config/project-context.txt`),
  NOT the project dir -- deliberately, so the `animation.tsx` file watcher never
  fires on it and it never appears in the project file tree.
- It uses plain `std::fs::write`, NOT `write_if_changed` -- there is no embedded
  `include_str!` const to diff against; the listing is recomputed from disk on
  every PTY open (v1 does not track mid-session file creation).
