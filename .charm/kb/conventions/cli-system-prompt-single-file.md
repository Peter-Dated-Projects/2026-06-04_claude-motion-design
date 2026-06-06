---
id: cli-system-prompt-single-file
root: conventions
type: convention
status: current
summary: "Extra Claude-CLI system-prompt content is concatenated into the single SKILLS_FILE at materialize time (claude_bridge.rs), not delivered as a new --append-system-prompt-file."
created: 2026-06-05
updated: 2026-06-05
---

The bundled system-prompt content shipped to the `claude` CLI is delivered as
**one** materialized file (`SKILLS_FILE` = `remotion-skills.txt`) passed via a
single `--append-system-prompt-file` flag in `pty_bridge.rs::open`.

When you need to add more skill/prompt content, the convention is to
**concatenate it into that one file** inside `claude_bridge.rs::ensure_claude_config`
(joining embedded `include_str!` sources with a labelled ASCII divider and a clean
newline seam), NOT to materialize a second file and add a second
`--append-system-prompt-file`. The single-file path keeps the delivery site in
`pty_bridge.rs` untouched.

Concrete instance: `IMAGE_SKILLS_CONTENTS` (`remotion-image-skills.txt`) is
concatenated onto `SKILLS_CONTENTS` rather than delivered separately.

Mechanics that must be preserved:
- Materialization is overwrite-on-change via `write_if_changed`, NOT
  seed-if-absent — so a fix to any embedded source reaches users who already
  launched a prior build. Keep the combined string deterministic (no timestamps)
  so the no-op-when-unchanged behavior holds.
- Normalize the seam (`trim_end_matches('\n')` on the preceding section) so the
  last line never fuses with the divider regardless of trailing-newline state.
- Add a `cargo:rerun-if-changed` directive in `build.rs` for each new embedded
  resource (mirrors the existing entries; `include_str!` already creates an
  implicit rebuild dep, but the explicit directive matches the pattern).
