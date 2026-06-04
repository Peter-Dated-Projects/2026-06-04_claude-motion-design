//! Tauri commands for inspecting and configuring the `claude` CLI path.
//!
//! The interactive session lives in `pty_bridge.rs`; these commands back the
//! Settings panel's "Claude CLI path" row (detect / override / availability).

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::AppHandle;

use crate::claude_bridge::{self, CLI_PATH_FILE};

/// `which {name}` -> the resolved absolute path, if the CLI can find it.
fn which(name: &str) -> Option<String> {
    let out = Command::new("which").arg(name).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Whether `bin` can actually be run: an explicit path must point at a file;
/// a bare name must resolve on PATH.
fn binary_available(bin: &str) -> bool {
    if bin.contains('/') {
        Path::new(bin).is_file()
    } else {
        which(bin).is_some()
    }
}

/// Whether the effective `claude` binary (override or PATH default) is runnable.
#[tauri::command]
pub fn check_claude_installed(app: AppHandle) -> bool {
    binary_available(&claude_bridge::claude_binary(&app))
}

/// Diagnostics for the Settings panel's "Claude CLI path" row.
#[derive(Serialize)]
pub struct ClaudeCliInfo {
    /// `which claude` result — the binary that would be used with no override.
    detected: Option<String>,
    /// User-supplied override path, if one is saved.
    override_path: Option<String>,
    /// The binary that will actually be spawned (override if set, else `claude`).
    effective: String,
    /// Whether `effective` is currently runnable.
    available: bool,
}

/// Report the detected and overridden `claude` paths plus what will run.
#[tauri::command]
pub fn get_claude_cli(app: AppHandle) -> ClaudeCliInfo {
    let effective = claude_bridge::claude_binary(&app);
    ClaudeCliInfo {
        detected: which("claude"),
        override_path: claude_bridge::claude_path_override(&app),
        available: binary_available(&effective),
        effective,
    }
}

/// Save (or, with `None`/empty, clear) the `claude` binary override. The next
/// `terminal_open` picks it up — no restart needed.
#[tauri::command]
pub fn set_claude_cli(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let dir = claude_bridge::claude_config_dir(&app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create claude-config dir: {e}"))?;
    let file = dir.join(CLI_PATH_FILE);

    match path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        Some(p) => std::fs::write(&file, p)
            .map_err(|e| format!("failed to write {CLI_PATH_FILE}: {e}"))?,
        None => {
            // Clearing the override: remove the file (ignore "not found").
            if let Err(e) = std::fs::remove_file(&file) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("failed to clear {CLI_PATH_FILE}: {e}"));
                }
            }
        }
    }
    Ok(())
}
