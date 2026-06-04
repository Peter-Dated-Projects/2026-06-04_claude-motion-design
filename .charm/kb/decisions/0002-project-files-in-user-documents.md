---
id: 0002-project-files-in-user-documents
root: decisions
type: decision
status: current
summary: "Project files move from the hidden app_data_dir to ~/Documents/ClaudeMotion/projects/ because they are user-owned source documents the user wants to see and edit; the claude-config (MCP + skills) stays in app_data_dir."
related:
  - decisions/0001-embedded-interactive-claude-pty
created: 2026-06-04
updated: 2026-06-04
---

## Decision

Store each project at `~/Documents/ClaudeMotion/projects/<slug>/` (resolved via
Tauri's `app.path().document_dir()` + `ClaudeMotion/projects`), not under
`app_data_dir()/projects/`. Each project folder keeps the same contents:
`animation.tsx`, `assets/`, `project.json`, `conversation.json`.

The MCP config + skills prompt (`claude_config_dir()` -> `app_data_dir/claude-config`)
do NOT move — only the projects root moves.

## Why

The files are React source the user explicitly wants to open, see, and edit. That
makes them **user documents**, not hidden app state. The macOS convention is two
buckets:

- App-managed/hidden state -> `~/Library/Application Support/<bundle-id>/`
  (this is what `app_data_dir()` resolves to, and where projects lived before —
  hence the "buried / stored somewhere compressed" complaint).
- User-owned documents -> a visible location like `~/Documents/<AppName>/`.

Writing user data **inside the `.app` bundle** was explicitly rejected: it breaks
code-signing/notarization (the signature hashes bundle contents), the bundle is
often not user-writable (installed in /Applications, or translocated to a read-only
path), and an app update replaces the whole bundle and wipes it. `~/Documents` is
visible, user-editable, survives updates, and works identically in a shipped build.

## Consequences / implementation notes

- The storage root is resolved in **two** places that MUST agree, or the terminal
  and the file watcher operate on a different folder than the project store:
  `commands/projects.rs::projects_root()` and `claude_bridge.rs::project_dir()`
  (the latter feeds the PTY cwd and the `animation.tsx` watcher — see
  [0001](0001-embedded-interactive-claude-pty.md)).
- No migration of pre-existing app_data projects (early stage; acceptable).
- A "Reveal in Finder" command (`reveal_project(slug)`) opens the folder via
  `std::process::Command::new("open")` on macOS — direct OS spawn, no new crate,
  same rationale as the PTY bridge avoiding the shell plugin.
