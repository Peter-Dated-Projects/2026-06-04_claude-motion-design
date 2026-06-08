---
id: project-context-write-if-changed
root: decisions
type: decision
status: current
summary: "F14 was implemented by routing write_project_context through the existing write_if_changed helper (full-content read+compare) rather than the proposal's suggested sorted filename:size sidecar-hash; the embedded animation.tsx contents (F12) are part of the compared content, so an entry-point edit triggers a rewrite while an identical regeneration no-ops and preserves the CLI prompt cache."
created: 2026-06-08
updated: 2026-06-08
---

The skills-prompt-fixes proposal (F14) suggested guarding `project-context.txt` writes
with a "sorted `filename:size` snapshot" hash stored in a sidecar file. We did not do that.

Decision: `write_project_context` now calls the existing `write_if_changed(path, contents, label)`
helper (the same one used for the skills/MCP config files) instead of a raw `std::fs::write`.

Why this is better than the sidecar hash:

- `write_if_changed` already reads the on-disk file and compares full contents, then skips
  the write when identical. That is precisely "the existing write_if_changed pattern" the
  ticket named -- the helper is literally that pattern.
- The compared content includes the embedded `animation.tsx` contents (F12). A
  `filename:size` hash would miss same-size edits to the entry point; full-content compare
  catches them. So F14's "animation.tsx must feed the change detection" requirement is met
  for free, more correctly than the proposed hash.
- No sidecar file to manage, no hash-collision surface, nothing extra cluttering the
  claude-config dir.

The goal (don't rewrite identical content, so the CLI's prompt-cache entry for the appended
context file isn't needlessly invalidated) is fully satisfied: identical regeneration leaves
the file's bytes and mtime untouched.

This is why the file watcher can safely regenerate context on every burst -- see
[[file-watch-regenerates-project-context]].
