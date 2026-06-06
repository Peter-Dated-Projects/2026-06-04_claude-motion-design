//! Interactive Claude CLI bridge over a pseudo-terminal.
//!
//! Replaces the old headless `claude -p` scrape-the-output approach: we spawn the
//! `claude` CLI *interactively* (no `-p`) inside a PTY, in the project working
//! dir, so it behaves like a real terminal session and edits files natively with
//! its own tools. The frontend renders the PTY with xterm.js; we no longer parse
//! `<code>` blocks. Animation changes flow back through the separate file watcher
//! (`file_watch.rs`), not this bridge.
//!
//! As with the previous bridge, spawning is done directly by the OS (here via
//! `portable-pty`), NOT through the Tauri shell plugin — so the shell capability
//! model is not involved and no extra permission is required.
//!
//! Single active session: a new `open` supersedes (kills) the previous one.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::claude_bridge;

// ---- Event payloads (snake_case, NO serde rename — matches the IPC contract) ----

#[derive(Clone, Serialize)]
struct DataPayload {
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    code: Option<i32>,
}

// ---- The bridge -----------------------------------------------------------

/// The active PTY session: the master (for resize), a writer into the child's
/// stdin, and a killer handle so `close`/supersede can terminate the child from
/// the command thread while the wait thread blocks on it.
struct Session {
    /// Generation tag so a stale wait-thread doesn't clear a newer session.
    generation: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Owns the single interactive `claude` PTY session. All internal state sits
/// behind `Arc`s so the bridge methods take `&self` and the reader/wait threads
/// can outlive a given call.
#[derive(Default)]
pub struct PtyBridge {
    session: Arc<Mutex<Option<Session>>>,
    generation: Arc<AtomicU64>,
}

impl PtyBridge {
    /// Spawn an interactive `claude` session in project `slug`'s working dir.
    /// Any existing session is killed first (single active session).
    ///
    /// `mode` selects a two-pass generation phase: `Some("layout")` /
    /// `Some("motion")` appends the matching phase skills file as a SECOND
    /// `--append-system-prompt-file` after the main one. `None` (and any
    /// unrecognized value) reproduces the normal single-prompt session exactly.
    pub fn open(&self, app: AppHandle, slug: String, mode: Option<String>) -> Result<(), String> {
        let config_dir = claude_bridge::claude_config_dir(&app)?;
        let mcp_config = config_dir.join(claude_bridge::MCP_CONFIG_FILE);
        let skills = config_dir.join(claude_bridge::SKILLS_FILE);
        // Resolve the optional phase skills file for the requested pass mode.
        let phase_skills = match mode.as_deref() {
            Some("layout") => Some(config_dir.join(claude_bridge::LAYOUT_SKILLS_FILE)),
            Some("motion") => Some(config_dir.join(claude_bridge::MOTION_SKILLS_FILE)),
            _ => None,
        };
        let project_dir = claude_bridge::project_dir(&app, &slug)?;
        std::fs::create_dir_all(&project_dir)
            .map_err(|e| format!("failed to create project dir: {e}"))?;

        let binary = claude_bridge::claude_binary(&app);

        // Reserve this session's generation, then kill any predecessor.
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.close();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open pty: {e}"))?;

        let mut cmd = CommandBuilder::new(&binary);
        cmd.arg("--mcp-config");
        cmd.arg(&mcp_config);
        cmd.arg("--append-system-prompt-file");
        cmd.arg(&skills);
        // In a two-pass session, layer the phase skills on top of the main prompt.
        if let Some(phase) = &phase_skills {
            cmd.arg("--append-system-prompt-file");
            cmd.arg(phase);
        }
        cmd.cwd(&project_dir);
        // Advertise a capable terminal so the CLI's interactive UI renders well.
        cmd.env("TERM", "xterm-256color");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn claude CLI: {e} (is `claude` on PATH?)"))?;
        // The slave fd must be dropped in the parent or the child never sees EOF.
        drop(pair.slave);

        let killer = child.clone_killer();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to clone pty reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to take pty writer: {e}"))?;

        *self
            .session
            .lock()
            .map_err(|_| "pty bridge lock poisoned".to_string())? = Some(Session {
            generation,
            master: pair.master,
            writer,
            killer,
        });

        // Reader thread: stream raw PTY output to the frontend.
        {
            let app = app.clone();
            std::thread::spawn(move || read_loop(app, reader));
        }

        // Wait thread: reap the child, report exit, clear the session if it's
        // still ours (generation guards against a racing supersede).
        {
            let app = app.clone();
            let session = self.session.clone();
            std::thread::spawn(move || {
                let code = child.wait().ok().map(|status| status.exit_code() as i32);
                let _ = app.emit("terminal://exit", ExitPayload { code });
                if let Ok(mut guard) = session.lock() {
                    if guard.as_ref().map(|s| s.generation) == Some(generation) {
                        *guard = None;
                    }
                }
            });
        }

        Ok(())
    }

    /// Write raw bytes (including control chars) to the PTY's stdin.
    pub fn input(&self, data: String) -> Result<(), String> {
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "pty bridge lock poisoned".to_string())?;
        match guard.as_mut() {
            Some(session) => {
                session
                    .writer
                    .write_all(data.as_bytes())
                    .map_err(|e| format!("pty write failed: {e}"))?;
                session
                    .writer
                    .flush()
                    .map_err(|e| format!("pty flush failed: {e}"))
            }
            None => Err("no active terminal session".to_string()),
        }
    }

    /// Resize the PTY so the CLI re-flows its UI.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self
            .session
            .lock()
            .map_err(|_| "pty bridge lock poisoned".to_string())?;
        match guard.as_ref() {
            Some(session) => session
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("pty resize failed: {e}")),
            None => Err("no active terminal session".to_string()),
        }
    }

    /// Kill the active session, if any. Safe to call when nothing is running.
    /// The wait thread observes the kill and emits `terminal://exit`.
    pub fn close(&self) {
        if let Ok(mut guard) = self.session.lock() {
            if let Some(mut session) = guard.take() {
                let _ = session.killer.kill();
            }
        }
    }
}

/// Read PTY output and emit `terminal://data` chunks. PTY bytes are UTF-8 but a
/// read can split a multi-byte char across chunks, so we buffer the incomplete
/// trailing bytes and only emit complete UTF-8 (substituting U+FFFD for any
/// genuinely invalid byte). ANSI escapes are ASCII, so splitting them is fine.
fn read_loop(app: AppHandle, mut reader: Box<dyn Read + Send>) {
    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF — child exited / pty closed
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                let chunk = drain_valid_utf8(&mut pending);
                if !chunk.is_empty() {
                    let _ = app.emit("terminal://data", DataPayload { data: chunk });
                }
            }
            Err(_) => break,
        }
    }
    // Flush whatever decodable bytes remain.
    if !pending.is_empty() {
        let chunk = String::from_utf8_lossy(&pending).into_owned();
        if !chunk.is_empty() {
            let _ = app.emit("terminal://data", DataPayload { data: chunk });
        }
    }
}

/// Pull the longest decodable prefix out of `pending`, returning it as a String
/// and leaving only an incomplete trailing multi-byte sequence behind.
fn drain_valid_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            // SAFETY: bytes [..valid] are validated UTF-8 by `valid_up_to`.
            let mut out = unsafe { std::str::from_utf8_unchecked(&pending[..valid]) }.to_string();
            match e.error_len() {
                // A genuinely invalid sequence: substitute and skip past it.
                Some(len) => {
                    out.push('\u{FFFD}');
                    pending.drain(..valid + len);
                }
                // Incomplete trailing sequence: keep it for the next read.
                None => {
                    pending.drain(..valid);
                }
            }
            out
        }
    }
}

// ---- Managed state + Tauri commands ---------------------------------------

/// Managed Tauri state wrapping the single [`PtyBridge`].
#[derive(Default)]
pub struct PtyState(pub PtyBridge);

#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<'_, PtyState>,
    slug: String,
    // Optional two-pass phase ("layout" | "motion"). Absent in a normal session
    // (the frontend's default `terminal_open` call omits it), which maps to None.
    mode: Option<String>,
) -> Result<(), String> {
    state.0.open(app, slug, mode)
}

#[tauri::command]
pub fn terminal_input(state: State<'_, PtyState>, data: String) -> Result<(), String> {
    state.0.input(data)
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    state.0.resize(cols, rows)
}

#[tauri::command]
pub fn terminal_close(state: State<'_, PtyState>) -> Result<(), String> {
    state.0.close();
    Ok(())
}
