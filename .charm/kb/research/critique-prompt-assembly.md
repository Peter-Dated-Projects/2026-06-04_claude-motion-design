---
id: critique-prompt-assembly
root: research
type: research
status: current
summary: "Critical audit of prompt assembly and context delivery: what the model receives and what is missing"
created: 2026-06-07
updated: 2026-06-07
---

# Critique: Prompt Assembly and Context Delivery

This is a reading of `claude_bridge.rs` and `pty_bridge.rs` against the
questions in T-008. Quotes are from the actual source.

---

## What works well

### 1. `write_if_changed` + `include_str!` on skills files is cache-correct

The skills files are embedded at compile time via `include_str!` and materialized
into `{appDataDir}/claude-config/` only when the on-disk copy differs from the
embedded const. Because the on-disk content is a deterministic function of the
binary (no runtime interpolation), the file hash is stable across every process
launch until the app is updated. This is exactly what prompt-cache warmth requires:
the file on disk does not change between sessions unless the binary changes.

The concatenation seam is also clean:

```rust
let combined = format!(
    "{}\n\n{}\n\n{}",
    SKILLS_CONTENTS.trim_end_matches('\n'),
    SKILLS_SECTION_DIVIDER,
    IMAGE_SKILLS_CONTENTS,
);
```

`trim_end_matches('\n')` ensures the last line of `remotion-skills.txt` never
fuses with the divider regardless of how the source file ends.

### 2. Phase skills conditional append is implemented correctly

`pty_bridge.rs::open` resolves the optional phase skills file from the `mode`
argument before spawning the child:

```rust
let phase_skills = match mode.as_deref() {
    Some("layout") => Some(config_dir.join(claude_bridge::LAYOUT_SKILLS_FILE)),
    Some("motion") => Some(config_dir.join(claude_bridge::MOTION_SKILLS_FILE)),
    _ => None,
};
```

And appends it only when present:

```rust
if let Some(phase) = &phase_skills {
    cmd.arg("--append-system-prompt-file");
    cmd.arg(phase);
}
```

So in a normal session the CLI receives one `--append-system-prompt-file` (the
main+image combined file). In a layout/motion pass it receives two. This matches
the design intent.

### 3. Session-open is fail-safe for the context listing

```rust
match claude_bridge::write_project_context(&app, &slug) {
    Ok(context_file) => {
        cmd.arg("--append-system-prompt-file");
        cmd.arg(&context_file);
    }
    Err(e) => {
        eprintln!("project-context generation failed, continuing without it: {e}");
    }
}
```

If disk I/O fails for any reason, the session opens without the listing rather
than aborting. A session without the listing is worse but recoverable; a session
that never starts is not. The correct failure mode.

---

## What does not work

### 1. Project context goes stale mid-session (the main gap)

`write_project_context` is called once at PTY open. It lists whatever files exist
at that moment. If the model (or the user) creates a new component during the
session — say `components/AnimatedWord.tsx` — that file is invisible to the
listing for the rest of the session.

The consequence: the PREFER-EXISTING instruction in the combined skills file
("Import only from files listed below. If a component is not listed, it does not
exist yet") becomes false for files born mid-session. The model has been told to
treat a missing listing entry as proof the file does not exist. When a file it
just created is absent from the listing it may implement the same component
inline on the next request rather than importing it.

There is no mechanism to refresh the listing short of killing and reopening the
session.

### 2. `project-context.txt` is written with `std::fs::write`, not `write_if_changed`

The comment acknowledges this:

> "Written with a plain `std::fs::write` (not `write_if_changed`) because there
> is no embedded const to diff against — the listing is recomputed from disk each
> call."

But the argument for `write_if_changed` on skills files was prompt-cache
stability, not just "we have a const to diff against." If the Claude CLI caches
system prompt content by file hash, rewriting an identical `project-context.txt`
on every session open invalidates that cache entry unnecessarily. On a project
where files have not changed since the last session, the listing is identical —
but the file is still rewritten.

A simple fix: hash the directory tree before writing (e.g., a sorted list of
`filename:mtime` pairs), store the hash as a sidecar, and skip the write when the
hash matches.

### 3. The image-skills divider is structural noise

The combined prompt contains this sequence:

```
[end of remotion-skills.txt content]

===== APPENDED SKILL MODULE: IMAGE REFERENCE =====

================================================================
IMAGE REFERENCE MODE
================================================================
```

The model sees the `SKILLS_SECTION_DIVIDER` banner immediately followed by the
image-skills section's own `================================================================ IMAGE REFERENCE MODE ================================================================` header. This creates two consecutive headers for the same section. The divider adds no information the section header does not already provide; it is redundancy that the model must parse around.

The divider was added to prevent the last line of the main skills file fusing with
the image section. But `trim_end_matches('\n')` already handles that, and a blank
line alone would be sufficient. The divider can be replaced with the blank
separator that is already in the format string.

### 4. The model never sees animation.tsx at session start

`project-context.txt` lists file names only. When a user opens Claude Motion and
types their first prompt, the model has no idea what is currently in
`animation.tsx`. Its first observable action is often to read the file with its
own Read tool — which is correct, but it costs a round trip and the user sees a
pause before any output.

More significantly, on the second or third user message in a long session, the
model has the file contents in its context window from its earlier Read. But on a
fresh session continuing the same project, the model starts cold again. There is no
mechanism to inject the current file contents at session start.

This means every session begins with Claude in an unknown state relative to the
project, and the model bears the cost of self-orientation on the first turn.

### 5. No export annotations for known shared modules

The listing for a project with `theme.ts`, `motion.ts`, and `components/` looks like:

```
  animation.tsx      <- entry point
  motion.ts
  theme.ts
  components/
    AnimatedWord.tsx
```

The skills prompt's Section 10 (COMPONENT VOCABULARY) documents what these files
export — `import { P, DISPLAY, BODY } from './theme'`, etc. — but that
documentation is static. If the user customizes `theme.ts` (changes the palette
tokens, adds a new export), the skills file's static description is stale and the
model may generate import statements that no longer compile.

The listing knows `theme.ts` exists but cannot tell the model what it exports.
Reading the file on every session open to extract its exports would resolve this,
but adds I/O cost.

### 6. `CONTEXT_NON_SOURCE` is kept in sync by hand

```rust
/// Source-file exclusions mirrored from `commands/projects.rs::collect_files`
/// (its `NON_SOURCE`): ... Kept in sync by hand because `collect_files` lives
/// in a different module (and a different ticket's touch scope); both must agree
/// on what counts as a source file.
const CONTEXT_NON_SOURCE: [&str; 4] = ["project.json", "conversation.json", "assets", "chats"];
```

There is no test asserting both lists agree. If a new metadata category is added
to `collect_files` without a matching update here, the model will see metadata
files it was not supposed to and may try to import from them. The unit tests for
`walk_context` cover the current exclusions but would not catch a divergence at
the `collect_files` level.

---

## Specific recommendations

**R1 — Refresh context on file-system changes, not just on session open.**
Wire the file watcher (`animation://changed`) or a separate directory watcher to
call `write_project_context` when new source files appear. This does not require
restarting the PTY; the updated file will be read by the CLI on the model's next
tool invocation. Alternatively, a frontend command could call a Rust command that
regenerates and overwrites `project-context.txt` in place — Claude's next Read
of that path gets the updated listing.

**R2 — Apply `write_if_changed` to `project-context.txt`.**
Hash the directory snapshot (sorted `filename:mtime` tuples) and skip the write
when the hash matches the stored value. Keeps the file hash stable across sessions
where files have not changed, protecting any cache the CLI might maintain over the
context listing.

**R3 — Remove or simplify the `SKILLS_SECTION_DIVIDER`.**
The blank-line separator already in the format string is sufficient to prevent
line fusion. The banner between the two sections creates a redundant third header.
Replacing it with a commented marker (e.g., `# --- image skills ---`) or dropping
it entirely and relying on the image section's own `=====` header would be cleaner.

**R4 — Inject animation.tsx contents at session start.**
The cleanest approach: expand `project-context.txt` to include a `CURRENT STATE`
block containing the full text of `animation.tsx` as of PTY open. This is the one
file the model is certain to need on every turn. It removes the cold-start Read
round trip and gives the model immediate orientation. The file is typically small
(~200-400 lines); the token cost is low relative to the benefit.

**R5 — Add export annotations to known shared-module entries.**
When `theme.ts` or `motion.ts` appears in the listing, annotate the entry with
its top-level exports extracted at session start. Even a one-line summary
(`theme.ts    <- exports P, DISPLAY, BODY`) is enough for the model to confirm
its static memory of Section 10 is still accurate without issuing a Read.

**R6 — Add a test that `CONTEXT_NON_SOURCE` matches `NON_SOURCE` in `collect_files`.**
Either a Rust integration test that reads both definitions and asserts equality,
or a doc comment on both constants referencing the other as the canonical list
and instructing reviewers to update both on any change.
