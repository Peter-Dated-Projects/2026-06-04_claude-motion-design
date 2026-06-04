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
const SKILLS_CONTENTS: &str = include_str!("../resources/remotion-skills.txt");

// ---- Config / path helpers ------------------------------------------------

/// `{appDataDir}/claude-config` — where the MCP config and skills file live.
pub fn claude_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(base.join("claude-config"))
}

/// `{appDataDir}/projects/{slug}` — the working directory a Claude run executes in.
/// Mirrors the project layout owned by T-021 (Local Project Storage).
pub fn project_dir(app: &AppHandle, slug: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(base.join("projects").join(slug))
}

/// Copy the embedded MCP config and skills file into `{appDataDir}/claude-config/`
/// if they are not already present. Call once from the Tauri `setup` hook.
pub fn ensure_claude_config(app: &AppHandle) -> Result<(), String> {
    let dir = claude_config_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create claude-config dir: {e}"))?;

    let mcp = dir.join(MCP_CONFIG_FILE);
    if !mcp.exists() {
        std::fs::write(&mcp, MCP_CONFIG_CONTENTS)
            .map_err(|e| format!("failed to write {MCP_CONFIG_FILE}: {e}"))?;
    }

    let skills = dir.join(SKILLS_FILE);
    if !skills.exists() {
        std::fs::write(&skills, SKILLS_CONTENTS)
            .map_err(|e| format!("failed to write {SKILLS_FILE}: {e}"))?;
    }

    Ok(())
}
