//! Claude CLI configuration and path helpers.
//!
//! The interactive session itself lives in `pty_bridge.rs`; this module owns the
//! shared plumbing both it and the Settings panel need: resolving the `claude`
//! binary (with a user override), locating the config/project dirs, and
//! materializing the bundled MCP config + skills prompt into the app config dir.
//!
//! Both this plumbing and the PTY bridge spawn `claude` directly via the OS, NOT
//! through the Tauri shell plugin — sidestepping the shell capability model, so no
//! `shell:allow-execute` permission is needed.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// File names of the bundled resources once copied into the app config dir.
pub const MCP_CONFIG_FILE: &str = "remotion-mcp-config.json";
pub const SKILLS_FILE: &str = "remotion-skills.txt";

/// Phase-specific skills files appended (in addition to `SKILLS_FILE`) during a
/// two-pass generation session — see `pty_bridge.rs::open`'s `mode` arg. Each is
/// materialized alongside the main skills file by `ensure_claude_config`.
pub const LAYOUT_SKILLS_FILE: &str = "remotion-skills-layout.txt";
pub const MOTION_SKILLS_FILE: &str = "remotion-skills-motion.txt";

/// Per-session file listing of the project's actual source files, regenerated on
/// every PTY open and appended to the CLI prompt — see `write_project_context`.
pub const PROJECT_CONTEXT_FILE: &str = "project-context.txt";

/// Stores a user-supplied override for the `claude` binary (absolute path or a
/// name on PATH). Absent / empty -> fall back to the default `claude`. Written
/// by `set_claude_cli`, read by `claude_binary` / `get_claude_cli`.
pub const CLI_PATH_FILE: &str = "cli-path.txt";

/// Read the configured `claude` binary: the user override from `cli-path.txt`
/// if present and non-empty, otherwise the default `"claude"` resolved on PATH.
pub fn claude_binary(app: &AppHandle) -> String {
    claude_path_override(app)
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "claude".to_string())
}

/// The raw override string the user saved, if any (trimmed). `None` when no
/// override is set or the file is empty/unreadable.
pub fn claude_path_override(app: &AppHandle) -> Option<String> {
    let path = claude_config_dir(app).ok()?.join(CLI_PATH_FILE);
    let contents = std::fs::read_to_string(path).ok()?;
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// The resource files are embedded into the binary at compile time. `include_str!`
// creates an implicit rebuild dependency, and build.rs adds explicit
// `rerun-if-changed` directives for them as well.
const MCP_CONFIG_CONTENTS: &str = include_str!("../resources/remotion-mcp-config.json");
// The skills prompt is delivered as the concatenation of two embedded sources:
// the main animation skills and the image-reference skills. They are joined at
// materialize time (see `ensure_claude_config`) into the single `SKILLS_FILE`,
// which `pty_bridge.rs` passes to the CLI via one `--append-system-prompt-file`.
const SKILLS_CONTENTS: &str = include_str!("../resources/remotion-skills.txt");
const IMAGE_SKILLS_CONTENTS: &str = include_str!("../resources/remotion-image-skills.txt");
// Phase skills for the two-pass flow. Materialized as their own files (NOT
// concatenated into SKILLS_FILE) so `open` can append exactly one of them as a
// second `--append-system-prompt-file` only when a pass mode is active.
const LAYOUT_SKILLS_CONTENTS: &str = include_str!("../resources/remotion-skills-layout.txt");
const MOTION_SKILLS_CONTENTS: &str = include_str!("../resources/remotion-skills-motion.txt");

/// Labelled divider inserted between the main and image skill sections in the
/// combined skills file, so the CLI reads two distinct blocks rather than one
/// run-on document. Chosen to not appear verbatim in either source file.
const SKILLS_SECTION_DIVIDER: &str = "===== APPENDED SKILL MODULE: IMAGE REFERENCE =====";

// ---- Config / path helpers ------------------------------------------------

/// `{appDataDir}/claude-config` — where the MCP config and skills file live.
pub fn claude_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(base.join("claude-config"))
}

/// `{documentDir}/ClaudeMotion/projects/{slug}` — the working directory a Claude
/// run executes in (PTY cwd) and the folder the animation.tsx watcher observes.
/// MUST match `commands/projects.rs::projects_root()`, the project store: if these
/// diverge, the terminal and watcher operate on a different folder than the one
/// projects are created/read in.
pub fn project_dir(app: &AppHandle, slug: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .document_dir()
        .map_err(|e| format!("failed to resolve document dir: {e}"))?;
    Ok(base.join("ClaudeMotion").join("projects").join(slug))
}

/// Write `contents` to `path` only when it would change the file: the file is
/// absent, or its current contents differ from `contents`. Returns without
/// touching disk when they already match, so an unchanged config is never
/// needlessly rewritten.
fn write_if_changed(path: &std::path::Path, contents: &str, label: &str) -> Result<(), String> {
    // A read failure (missing file, etc.) is treated as "needs write" rather
    // than an error -- the subsequent write surfaces any real I/O problem.
    if std::fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    std::fs::write(path, contents).map_err(|e| format!("failed to write {label}: {e}"))
}

/// Materialize the embedded MCP config and skills file into
/// `{appDataDir}/claude-config/`, overwriting the cached copy whenever the
/// embedded content differs from what's on disk. Call once from the Tauri
/// `setup` hook.
///
/// This is overwrite-on-change, NOT seed-if-absent, and that distinction is
/// load-bearing: the skills prompt and MCP config are embedded at compile time
/// via `include_str!` and delivered to the `claude` CLI from these cached files.
/// With seed-if-absent, any user who had launched the app even once would keep a
/// stale copy forever -- so fixes to `remotion-skills.txt` / the MCP config would
/// silently never reach them. Comparing against the embedded const and rewriting
/// on change ships those fixes on the next launch while leaving an up-to-date
/// file untouched. Only these two app-managed files are written; no user-owned
/// state in the dir is touched. The skills file is the runtime concatenation of
/// the main and image-reference skill sources (joined by `SKILLS_SECTION_DIVIDER`),
/// still materialized as the single `SKILLS_FILE`.
pub fn ensure_claude_config(app: &AppHandle) -> Result<(), String> {
    let dir = claude_config_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create claude-config dir: {e}"))?;

    // Normalize the seam: drop any trailing newlines from the main section, then
    // rejoin with a clean blank-line boundary so the last main line never fuses
    // with the divider regardless of how `remotion-skills.txt` ends. Pure const
    // concatenation -> deterministic, so `write_if_changed` still no-ops when
    // unchanged and rewrites whenever either embedded source changes.
    let combined = format!(
        "{}\n\n{}\n\n{}",
        SKILLS_CONTENTS.trim_end_matches('\n'),
        SKILLS_SECTION_DIVIDER,
        IMAGE_SKILLS_CONTENTS,
    );

    write_if_changed(&dir.join(MCP_CONFIG_FILE), MCP_CONFIG_CONTENTS, MCP_CONFIG_FILE)?;
    write_if_changed(&dir.join(SKILLS_FILE), &combined, SKILLS_FILE)?;
    // Phase skills files for the two-pass flow, materialized standalone so a
    // layout/motion pass can append exactly one alongside the main skills file.
    write_if_changed(&dir.join(LAYOUT_SKILLS_FILE), LAYOUT_SKILLS_CONTENTS, LAYOUT_SKILLS_FILE)?;
    write_if_changed(&dir.join(MOTION_SKILLS_FILE), MOTION_SKILLS_CONTENTS, MOTION_SKILLS_FILE)?;

    Ok(())
}

// ---- Per-session project context listing ----------------------------------

/// Source-file exclusions mirrored from `commands/projects.rs::collect_files`
/// (its `NON_SOURCE`): project metadata, conversation history, the assets dir,
/// and the chats dir are not source the model should try to import. Kept in sync
/// by hand because `collect_files` lives in a different module (and a different
/// ticket's touch scope); both must agree on what counts as a source file.
const CONTEXT_NON_SOURCE: [&str; 4] = ["project.json", "conversation.json", "assets", "chats"];

/// Generate a per-session listing of the source files that actually exist in
/// project `slug`, and write it to `{appDataDir}/claude-config/project-context.txt`.
///
/// Passed to the `claude` CLI as an additional `--append-system-prompt-file`
/// (see `pty_bridge.rs::open`) so the model knows what it can import *right now*,
/// closing the gap between what the static skills prompt says could exist and
/// what this project actually contains. Regenerated fresh on every PTY open;
/// v1 does not track files created mid-session.
///
/// Lives in the config dir (alongside the skills file), NOT the project dir, so
/// the `animation.tsx` file watcher never picks it up and it never shows in the
/// project file tree. Written with a plain `std::fs::write` (not
/// `write_if_changed`) because there is no embedded const to diff against — the
/// listing is recomputed from disk each call. Returns the written path.
pub fn write_project_context(app: &AppHandle, slug: &str) -> Result<PathBuf, String> {
    let project = project_dir(app, slug)?;

    let mut body = String::new();
    // A brand-new project may not have its dir created yet — that's fine, we
    // simply emit an empty listing rather than failing.
    if project.is_dir() {
        walk_context(&project, 1, &mut body)?;
    }
    if body.is_empty() {
        body.push_str("  (no source files yet)\n");
    }

    let contents = format!(
        "================================================================\n\
         CURRENT PROJECT FILES\n\
         ================================================================\n\
         These are the source files that exist in this project right now.\n\
         Import only from files listed below. If a component is not listed, it\n\
         does not exist yet — implement it inline rather than importing a module\n\
         that is not here (a missing import breaks the live preview).\n\n\
         {body}"
    );

    let dir = claude_config_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create claude-config dir: {e}"))?;
    let path = dir.join(PROJECT_CONTEXT_FILE);
    std::fs::write(&path, contents)
        .map_err(|e| format!("failed to write {PROJECT_CONTEXT_FILE}: {e}"))?;
    Ok(path)
}

/// Recursively append an indented listing of `dir`'s source files to `body`,
/// mirroring `collect_files`' exclusions (dotfiles + `CONTEXT_NON_SOURCE`).
/// Files are listed before directories, alphabetical within each group; nested
/// directories recurse at a deeper indent. `depth` is the indent level (1 =
/// top level). File names use forward slashes implicitly (a bare `file_name`
/// has no separator), so Windows paths never leak backslashes.
fn walk_context(dir: &Path, depth: usize, body: &mut String) -> Result<(), String> {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();

    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("failed to read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("failed to read dir entry: {e}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || CONTEXT_NON_SOURCE.contains(&name.as_ref()) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        } else {
            files.push(path);
        }
    }
    files.sort();
    dirs.sort();

    let indent = "  ".repeat(depth);
    for f in &files {
        let name = f.file_name().unwrap_or_default().to_string_lossy();
        // Flag the entry point so the model knows which file is the composition.
        if depth == 1 && name == "animation.tsx" {
            body.push_str(&format!("{indent}{name}      <- entry point\n"));
        } else {
            body.push_str(&format!("{indent}{name}\n"));
        }
    }
    for d in &dirs {
        let name = d.file_name().unwrap_or_default().to_string_lossy();
        body.push_str(&format!("{indent}{name}/\n"));
        walk_context(d, depth + 1, body)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::walk_context;
    use std::fs;

    /// Build a unique temp dir under the OS temp root. (Avoids a dev-dependency
    /// on `tempfile`; cleaned up at the end of the test.)
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("ctx-test-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scaffolded_project_lists_sources_excludes_metadata_and_assets() {
        let dir = temp_dir("scaffold");
        // A scaffolded project: animation.tsx + theme.ts + motion.ts, plus the
        // metadata/assets that must NOT appear, plus a nested components dir.
        fs::write(dir.join("animation.tsx"), "").unwrap();
        fs::write(dir.join("theme.ts"), "").unwrap();
        fs::write(dir.join("motion.ts"), "").unwrap();
        fs::write(dir.join("project.json"), "{}").unwrap();
        fs::write(dir.join("conversation.json"), "[]").unwrap();
        fs::write(dir.join(".DS_Store"), "").unwrap();
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets").join("logo.png"), "").unwrap();
        fs::create_dir_all(dir.join("components")).unwrap();
        fs::write(dir.join("components").join("AnimatedWord.tsx"), "").unwrap();

        let mut body = String::new();
        walk_context(&dir, 1, &mut body).unwrap();

        // Source files present; entry point annotated.
        assert!(body.contains("animation.tsx      <- entry point"), "body:\n{body}");
        assert!(body.contains("theme.ts"), "body:\n{body}");
        assert!(body.contains("motion.ts"), "body:\n{body}");
        // Nested dir + its child are shown, indented.
        assert!(body.contains("components/"), "body:\n{body}");
        assert!(body.contains("    AnimatedWord.tsx"), "body:\n{body}");
        // Excluded entries never appear.
        assert!(!body.contains("project.json"), "body:\n{body}");
        assert!(!body.contains("conversation.json"), "body:\n{body}");
        assert!(!body.contains(".DS_Store"), "body:\n{body}");
        assert!(!body.contains("assets"), "body:\n{body}");
        assert!(!body.contains("logo.png"), "body:\n{body}");
        // Files are listed before directories.
        assert!(
            body.find("animation.tsx").unwrap() < body.find("components/").unwrap(),
            "files should precede dirs, body:\n{body}"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn entry_point_only_project_lists_just_animation() {
        let dir = temp_dir("entry-only");
        fs::write(dir.join("animation.tsx"), "").unwrap();

        let mut body = String::new();
        walk_context(&dir, 1, &mut body).unwrap();

        assert_eq!(body, "  animation.tsx      <- entry point\n", "body:\n{body}");

        fs::remove_dir_all(&dir).unwrap();
    }
}
