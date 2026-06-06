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

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// File names of the bundled resources once copied into the app config dir.
pub const MCP_CONFIG_FILE: &str = "remotion-mcp-config.json";
pub const SKILLS_FILE: &str = "remotion-skills.txt";

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

    Ok(())
}
