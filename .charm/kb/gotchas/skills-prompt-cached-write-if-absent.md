---
id: skills-prompt-cached-write-if-absent
root: gotchas
type: gotcha
status: current
summary: "ensure_claude_config now OVERWRITES the cached remotion-skills.txt / MCP config in appDataDir/claude-config whenever the embedded content differs (was seed-if-absent, fixed in T-011), so a prompt edit + rebuild ships to existing installs on next launch -- no need to delete the cached copy to retest."
created: 2026-06-04
updated: 2026-06-04
---

`remotion-skills.txt` is the system prompt the embedded Claude session runs
with. It is embedded into the binary via `include_str!` (claude_bridge.rs) and
materialized at runtime into `{appDataDir}/claude-config/remotion-skills.txt` by
`ensure_claude_config`, which the PTY bridge points Claude at (same for
`remotion-mcp-config.json`). The cached on-disk copy -- not the embedded const
directly -- is what Claude actually reads.

History of the trap (now fixed): `ensure_claude_config` originally wrote each
file behind a `if !exists()` guard -- a one-time seed, not a sync. So once a copy
existed in `claude-config/`, changing the bundled
`src-tauri/resources/remotion-skills.txt` and rebuilding had **zero effect** on
any install that had launched even once. Prompt fixes silently never shipped.

T-011 replaced this with overwrite-on-change: `ensure_claude_config` compares
the on-disk contents to the embedded const (`SKILLS_CONTENTS` /
`MCP_CONFIG_CONTENTS`) via a `write_if_changed` helper and rewrites only when
they differ (or the file is absent). Consequences now:

- Editing the bundled prompt and rebuilding DOES reach existing installs: the
  stale cached copy is overwritten on the next launch. You no longer need to
  delete the cached file or use a fresh profile to retest a prompt change.
- An unchanged file is left untouched (the content compare short-circuits), so
  there's no needless write each launch.
- Only these two app-managed files are overwritten; no other user state in
  `claude-config/` is touched.

If you re-add a seed-if-absent style guard here, you reintroduce the
prompt-delivery bug -- the comment in `ensure_claude_config` spells out why
overwrite-on-change is required.

Related: [[canonical-canvas-is-vertical]] (remotion-skills.txt is the canonical
prompt), [[terminal-is-pty-io-not-code-source]].
