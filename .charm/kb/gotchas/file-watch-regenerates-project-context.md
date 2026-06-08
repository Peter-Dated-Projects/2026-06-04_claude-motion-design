---
id: file-watch-regenerates-project-context
root: gotchas
type: gotcha
status: current
summary: "file_watch.rs's debounce loop now calls claude_bridge::write_project_context after every burst, so the CLI's project-context.txt (file listing + embedded animation.tsx) stays fresh mid-session; safe from a feedback loop only because that file lives in the app-data claude-config dir, NOT the watched project dir."
created: 2026-06-08
updated: 2026-06-08
---

`debounce_loop` in `file_watch.rs` does two things per coalesced burst now: it emits
`animation://changed` for the preview (as before), and it calls
`claude_bridge::write_project_context(&app, &slug)` to refresh the per-session context
file the CLI reads via `--append-system-prompt-file` (F13).

Why this matters:

- The watcher thread carries the project `slug` (threaded through `watch()` ->
  `debounce_loop`) specifically so it can regenerate context. Don't drop it.
- It regenerates on EVERY burst, not just create/delete. That's intentional and cheap:
  `write_project_context` writes through `write_if_changed`, so a pure modify that
  doesn't change the source-file set or `animation.tsx` contents is a no-op and won't
  churn the CLI's prompt cache. A create/delete (listing changes) or an `animation.tsx`
  edit (embedded contents change) does trigger a rewrite. Detecting create/delete via
  `notify` event kinds was avoided because FSEvents on macOS reports them coarsely.
- No feedback loop: `project-context.txt` is written to the app-data
  `claude-config/` dir, while the watcher watches the project dir under
  `~/Documents/ClaudeMotion/projects/<slug>/`. Writing it never re-triggers the watcher.
  If anyone ever moves the context file into the project dir, this becomes an infinite
  loop -- keep it out.

See [[project-context-write-if-changed]] for why the write goes through `write_if_changed`.
