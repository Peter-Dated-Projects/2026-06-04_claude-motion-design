---
id: skills-prompt-cached-write-if-absent
root: gotchas
type: gotcha
status: current
summary: "ensure_claude_config copies the embedded remotion-skills.txt to appDataDir/claude-config ONLY if absent, so editing the bundled prompt does NOT update an existing install -- the cached copy is what claude actually reads; delete it (or use a fresh profile) to retest."
created: 2026-06-04
updated: 2026-06-04
---

`remotion-skills.txt` is the system prompt the embedded Claude session runs
with. It is embedded into the binary via `include_str!` (claude_bridge.rs) and
materialized at runtime into `{appDataDir}/claude-config/remotion-skills.txt` by
`ensure_claude_config`, which the PTY bridge points Claude at.

The trap: `ensure_claude_config` writes the file with a `if !skills.exists()`
guard. It is a one-time seed, not a sync. So once a copy exists in
`claude-config/`, changing the bundled `src-tauri/resources/remotion-skills.txt`
and rebuilding has **zero effect on that install** -- the stale on-disk copy is
what Claude reads. The same applies to `remotion-mcp-config.json` (same guard).

Consequences:
- Editing the prompt (e.g. T-006's direct-file-editing rewrite) is NOT testable
  by just rebuilding. You must delete the cached
  `{appDataDir}/claude-config/remotion-skills.txt` (or run with a fresh app data
  dir / profile) so the new contents get re-seeded on next launch.
- A user who upgrades the app keeps their old prompt silently. If prompt updates
  ever need to ship to existing users, this guard must change (e.g. version the
  file or overwrite when the embedded content differs).

Related: [[canonical-canvas-is-vertical]] (remotion-skills.txt is the canonical
prompt), [[terminal-is-pty-io-not-code-source]].
