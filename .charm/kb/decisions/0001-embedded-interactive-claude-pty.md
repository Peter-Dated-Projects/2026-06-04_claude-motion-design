---
id: 0001-embedded-interactive-claude-pty
root: decisions
type: decision
status: current
summary: "Pivoted from headless `claude -p` NDJSON scraping to an EMBEDDED interactive claude session in a PTY; Claude edits files with its own tools and we sync via a file watcher on animation.tsx instead of parsing code blocks."
created: 2026-06-04
updated: 2026-06-04
---

## Decision

The app spawns the `claude` CLI **interactively** (no `-p`) inside a pseudo-terminal
(`portable-pty`), in the project working dir, and renders it with xterm.js on the
frontend. Claude edits `animation.tsx` natively with its own tools. The editor and
preview stay in sync via a separate filesystem watcher (`notify`) on
`{project_dir}/animation.tsx`, NOT by parsing `<code>` blocks out of the model's
output.

## Why

The old approach (`claude -p --output-format stream-json`, parse NDJSON, extract a
code block, write it to disk) fought the grain of the CLI: it threw away Claude's
own tool-use UI, required scraping/validating/retrying generated code, and could
only ever produce whole-file rewrites. Embedding the real interactive session gives
native multi-file edits, the CLI's own diff/permission UX, and removes the entire
parse-and-validate layer. File-watching is the natural sync primitive once Claude
writes to disk directly.

## What this replaced (now removed)

- `claude_bridge.rs::ClaudeBridge` (`send`/`cancel`), `handle_event`,
  `extract_text_delta`, and the `claude://token|done|error` events.
- The `invoke_claude` / `cancel_claude` commands and `ClaudeState`.

`claude_bridge.rs` now keeps only the shared plumbing both halves need:
`claude_binary` (+ override), `claude_config_dir`, `project_dir`,
`ensure_claude_config`, and the embedded MCP-config / skills-prompt resources.

## IPC contract (frozen — frontend is built to it)

Commands: `terminal_open(slug)`, `terminal_input(data)`, `terminal_resize(cols,rows)`,
`terminal_close()`, `watch_animation(slug)`.
Events (plain snake_case payloads, NO `#[serde(rename_all)]`):
`terminal://data {data}`, `terminal://exit {code}`, `animation://changed {code}`.

Single active session for both the PTY and the watcher: a new open/watch supersedes
the previous one. Spawning is direct-via-OS (`portable-pty`), not the Tauri shell
plugin, so no shell capability is needed — same rationale as the old bridge
(see [[tauri-plugin-three-place-wiring]]).

Supersedes [[claude-cli-stream-json-flags]] and
[[claude-bridge-event-payloads-snake-case]] — both described the removed print-mode
bridge. See also [[portable-pty-drop-slave-for-eof]].
