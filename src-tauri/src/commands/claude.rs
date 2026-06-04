//! Tauri commands for the Claude CLI bridge.
//!
//! Register these in `lib.rs` (see the wiring contract in `claude_bridge.rs`):
//! `.manage(ClaudeState::default())` plus the three commands in
//! `generate_handler!`.

use std::process::Command;
use std::sync::Mutex;

use tauri::{AppHandle, State};

use crate::claude_bridge::{self, ClaudeBridge};

/// Managed Tauri state wrapping the single, serialized [`ClaudeBridge`].
#[derive(Default)]
pub struct ClaudeState(pub Mutex<ClaudeBridge>);

/// Start a Claude run for `prompt` against project `slug`, resuming
/// `session_id` when given. Streams output via the `claude://token`,
/// `claude://done`, and `claude://error` events.
#[tauri::command]
pub fn invoke_claude(
    app: AppHandle,
    state: State<'_, ClaudeState>,
    slug: String,
    prompt: String,
    session_id: Option<String>,
) -> Result<(), String> {
    let project_dir = claude_bridge::project_dir(&app, &slug)?
        .to_string_lossy()
        .into_owned();
    let mut bridge = state
        .0
        .lock()
        .map_err(|_| "claude bridge lock poisoned".to_string())?;
    bridge.send(app.clone(), prompt, session_id, project_dir)
}

/// Kill the in-flight Claude run, if any.
#[tauri::command]
pub fn cancel_claude(state: State<'_, ClaudeState>) -> Result<(), String> {
    let mut bridge = state
        .0
        .lock()
        .map_err(|_| "claude bridge lock poisoned".to_string())?;
    bridge.cancel();
    Ok(())
}

/// Whether the `claude` CLI is resolvable on PATH (`which claude`).
#[tauri::command]
pub fn check_claude_installed() -> bool {
    Command::new("which")
        .arg("claude")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
