//! Claude CLI bridge: spawns the `claude` CLI as a subprocess and streams its
//! NDJSON (`--output-format stream-json`) output to the frontend as Tauri events.
//!
//! Spawning is done with `std::process::Command` directly (Rust-side), NOT via the
//! Tauri shell plugin. This is deliberate: the shell plugin's `shell:default`
//! capability does not permit executing arbitrary binaries, and we would otherwise
//! need a scoped `shell:allow-execute` permission. Driving the process from Rust
//! sidesteps the capability model entirely and keeps the child handle here so we
//! can cancel it.
//!
//! ## Wiring contract (done by the `lib.rs` owner / integration ticket)
//!
//! This module is not reachable from the crate root until `lib.rs` declares it. To
//! activate the bridge, `src-tauri/src/lib.rs` must:
//!
//! ```ignore
//! mod claude_bridge;
//! mod commands; // commands/mod.rs must `pub mod claude;`
//!
//! tauri::Builder::default()
//!     // ...existing plugins...
//!     .manage(commands::claude::ClaudeState::default())
//!     .setup(|app| {
//!         claude_bridge::ensure_claude_config(app.handle())?;
//!         Ok(())
//!     })
//!     .invoke_handler(tauri::generate_handler![
//!         // ...existing commands...
//!         commands::claude::invoke_claude,
//!         commands::claude::cancel_claude,
//!         commands::claude::check_claude_installed,
//!     ])
//! ```

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

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

// ---- Event payloads -------------------------------------------------------

#[derive(Clone, Serialize)]
struct TokenPayload {
    text: String,
}

#[derive(Clone, Serialize)]
struct DonePayload {
    full_text: String,
    cost_usd: Option<f64>,
    session_id: Option<String>,
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    message: String,
}

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

// ---- The bridge -----------------------------------------------------------

/// Owns the in-flight `claude` child process. A single bridge serializes runs:
/// starting a new `send` cancels any previous one. The child sits behind an
/// `Arc<Mutex<...>>` so the stdout-reader thread can reap it on EOF while
/// `cancel()` can kill it from the command thread.
pub struct ClaudeBridge {
    child: Arc<Mutex<Option<Child>>>,
}

impl Default for ClaudeBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeBridge {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
        }
    }

    /// Spawn `claude -p` for `prompt` in `project_dir`, streaming output as events.
    ///
    /// Resumes `session_id` when provided so multi-turn conversations keep context.
    pub fn send(
        &mut self,
        app: AppHandle,
        prompt: String,
        session_id: Option<String>,
        project_dir: String,
    ) -> Result<(), String> {
        // A new run supersedes any previous one.
        self.cancel();

        let config_dir = claude_config_dir(&app)?;
        let mcp_config = config_dir.join(MCP_CONFIG_FILE);
        let skills = config_dir.join(SKILLS_FILE);

        let mut cmd = Command::new(claude_binary(&app));
        cmd.arg("-p")
            .arg("--mcp-config")
            .arg(&mcp_config)
            .arg("--append-system-prompt-file")
            .arg(&skills)
            .arg("--output-format")
            .arg("stream-json")
            // `stream-json` in print mode requires `--verbose`, and incremental
            // text_delta tokens (the `stream_event` lines we parse below) only
            // appear with `--include-partial-messages`. Both are mandatory for the
            // token-streaming behavior this ticket specifies.
            .arg("--verbose")
            .arg("--include-partial-messages");

        if let Some(sid) = session_id.as_ref() {
            cmd.arg("--resume").arg(sid);
        }

        cmd.arg(&prompt)
            .current_dir(&project_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn claude CLI: {e} (is `claude` on PATH?)"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture claude stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture claude stderr".to_string())?;

        *self
            .child
            .lock()
            .map_err(|_| "claude bridge lock poisoned".to_string())? = Some(child);

        // Drain stderr in its own thread so a chatty CLI can't deadlock by filling
        // the pipe buffer. We keep the tail for error reporting.
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        {
            let stderr_buf = stderr_buf.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if let Ok(mut buf) = stderr_buf.lock() {
                        buf.push_str(&line);
                        buf.push('\n');
                    }
                }
            });
        }

        // Read stdout line-by-line, parse NDJSON, emit events.
        let child_arc = self.child.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut full_text = String::new();
            let mut terminal_seen = false;

            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let value: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue, // ignore non-JSON noise
                };
                if handle_event(&app, &value, &mut full_text) {
                    terminal_seen = true;
                }
            }

            // stdout closed. Reap the child and, if it failed without emitting a
            // terminal event, surface the error.
            let status = {
                match child_arc.lock() {
                    Ok(mut guard) => guard.take().and_then(|mut c| c.wait().ok()),
                    Err(_) => None,
                }
            };

            if !terminal_seen {
                let failed = status.map(|s| !s.success()).unwrap_or(true);
                if failed {
                    let stderr_tail = stderr_buf
                        .lock()
                        .map(|b| b.trim().to_string())
                        .unwrap_or_default();
                    let message = if stderr_tail.is_empty() {
                        "claude CLI exited without producing a result".to_string()
                    } else {
                        stderr_tail
                    };
                    let _ = app.emit("claude://error", ErrorPayload { message });
                }
            }
        });

        Ok(())
    }

    /// Kill the in-flight child, if any. Safe to call when nothing is running.
    pub fn cancel(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Parse one NDJSON event and emit the matching Tauri event.
/// Returns `true` when the event is terminal (a `result` or `error`), so the
/// reader can tell whether the stream ended cleanly.
fn handle_event(app: &AppHandle, value: &Value, full_text: &mut String) -> bool {
    match value.get("type").and_then(Value::as_str) {
        Some("stream_event") => {
            if let Some(text) = extract_text_delta(value) {
                full_text.push_str(&text);
                let _ = app.emit("claude://token", TokenPayload { text });
            }
            false
        }
        Some("result") => {
            let is_success = value.get("subtype").and_then(Value::as_str) == Some("success")
                && value.get("is_error").and_then(Value::as_bool) != Some(true);

            if is_success {
                // Prefer the CLI's final `result` text; fall back to accumulated deltas.
                let text = value
                    .get("result")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| full_text.clone());
                let cost_usd = value
                    .get("total_cost_usd")
                    .or_else(|| value.get("cost_usd"))
                    .and_then(Value::as_f64);
                let session_id = value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let _ = app.emit(
                    "claude://done",
                    DonePayload {
                        full_text: text,
                        cost_usd,
                        session_id,
                    },
                );
            } else {
                let message = value
                    .get("result")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("error").and_then(Value::as_str))
                    .unwrap_or("claude run failed")
                    .to_string();
                let _ = app.emit("claude://error", ErrorPayload { message });
            }
            true
        }
        Some("error") => {
            let message = value
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .unwrap_or("unknown claude error")
                .to_string();
            let _ = app.emit("claude://error", ErrorPayload { message });
            true
        }
        _ => false,
    }
}

/// Pull the text out of a `stream_event` carrying an Anthropic
/// `content_block_delta` with a `text_delta`. Lenient: returns the delta text
/// wherever it appears under `event.delta`.
fn extract_text_delta(value: &Value) -> Option<String> {
    let delta = value.get("event")?.get("delta")?;
    // Only text deltas carry user-visible tokens; ignore input_json_delta etc.
    match delta.get("type").and_then(Value::as_str) {
        Some("text_delta") | None => delta
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}
