//! Watches a project's `animation.tsx` so the editor and preview stay in sync
//! with whatever the interactive Claude session writes in the terminal.
//!
//! We watch the project *directory* (non-recursively) rather than the file
//! itself: editors and tools (including Claude's Write) frequently replace a
//! file via rename, which can drop a file-level watch. Events are filtered down
//! to `animation.tsx` by file name, debounced (~150ms) to coalesce the burst a
//! single save produces, then the file is read and emitted.
//!
//! Single active watch: a new `watch` supersedes the previous one — replacing
//! the stored watcher drops it, which disconnects the old channel and ends the
//! old debounce thread.

use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{recommended_watcher, Event, RecursiveMode, RecommendedWatcher, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::claude_bridge;

/// Debounce window: coalesce the burst of filesystem events a single save emits.
const DEBOUNCE: Duration = Duration::from_millis(150);

const ANIMATION_FILE: &str = "animation.tsx";

#[derive(Clone, Serialize)]
struct ChangedPayload {
    code: String,
}

/// Owns the single active filesystem watcher. Holding the watcher keeps it
/// alive; dropping/replacing it stops watching and ends its debounce thread.
#[derive(Default)]
pub struct FileWatcher {
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
}

impl FileWatcher {
    /// Start watching project `slug`'s `animation.tsx`, superseding any prior
    /// watch. Emits `animation://changed` with the file's contents after writes.
    pub fn watch(&self, app: AppHandle, slug: String) -> Result<(), String> {
        let project_dir = claude_bridge::project_dir(&app, &slug)?;
        std::fs::create_dir_all(&project_dir)
            .map_err(|e| format!("failed to create project dir: {e}"))?;
        let file = project_dir.join(ANIMATION_FILE);

        // The watcher callback signals the debounce thread; it carries no data,
        // we just re-read the file once the burst settles.
        let (tx, rx) = channel::<()>();
        let mut watcher = recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                let touches_animation = event
                    .paths
                    .iter()
                    .any(|p| p.file_name().and_then(|n| n.to_str()) == Some(ANIMATION_FILE));
                if touches_animation {
                    // Receiver gone (watch superseded) -> ignore the send error.
                    let _ = tx.send(());
                }
            }
        })
        .map_err(|e| format!("failed to create file watcher: {e}"))?;

        watcher
            .watch(&project_dir, RecursiveMode::NonRecursive)
            .map_err(|e| format!("failed to watch project dir: {e}"))?;

        // Install (and thereby drop any previous watcher) before spawning the
        // debounce thread so the old thread's channel is already disconnected.
        *self
            .watcher
            .lock()
            .map_err(|_| "file watcher lock poisoned".to_string())? = Some(watcher);

        std::thread::spawn(move || debounce_loop(app, file, rx));

        Ok(())
    }
}

/// Block for an event, drain the debounce window, then read + emit. Exits when
/// the channel disconnects (watcher dropped on supersede).
fn debounce_loop(app: AppHandle, file: std::path::PathBuf, rx: std::sync::mpsc::Receiver<()>) {
    loop {
        // Wait for the first change.
        if rx.recv().is_err() {
            return; // watcher dropped
        }
        // Coalesce: keep extending the window until it goes quiet.
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        emit_current(&app, &file);
    }
}

fn emit_current(app: &AppHandle, file: &Path) {
    if let Ok(code) = std::fs::read_to_string(file) {
        let _ = app.emit("animation://changed", ChangedPayload { code });
    }
}

// ---- Managed state + Tauri command ----------------------------------------

/// Managed Tauri state wrapping the single [`FileWatcher`].
#[derive(Default)]
pub struct WatchState(pub FileWatcher);

#[tauri::command]
pub fn watch_animation(
    app: AppHandle,
    state: State<'_, WatchState>,
    slug: String,
) -> Result<(), String> {
    state.0.watch(app, slug)
}
