//! Watches a project's source `.ts`/`.tsx` files so the editor and preview stay
//! in sync with whatever the interactive Claude session (or the user) writes.
//!
//! Multi-file (T-067): the preview compiler bundles relative imports
//! (`./theme`, `./components/X`), so the watcher must track every `.ts`/`.tsx`
//! in the project, not just `animation.tsx`. We therefore:
//!   - watch the project directory RECURSIVELY (so edits to files in
//!     `components/` and other subdirs refresh the preview), and
//!   - filter events down to paths ending in `.ts`/`.tsx` by extension.
//!
//! We watch the *directory* rather than individual files: editors and tools
//! (including Claude's Write) frequently replace a file via rename, which can
//! drop a file-level watch. A burst of events is debounced (~150ms) and
//! COALESCED across files -- several files written in one window collapse to a
//! single emit -- then the set of changed project-relative paths is emitted so
//! the frontend can re-read them and re-push one compiler snapshot.
//!
//! Single active watch: a new `watch` supersedes the previous one — replacing
//! the stored watcher drops it, which disconnects the old channel and ends the
//! old debounce thread.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{recommended_watcher, Event, RecursiveMode, RecommendedWatcher, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::claude_bridge;

/// Debounce window: coalesce the burst of filesystem events a single save emits.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// True for files the preview compiler cares about: TypeScript / TSX sources.
fn is_source_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("ts") | Some("tsx")
    )
}

#[derive(Clone, Serialize)]
struct ChangedPayload {
    /// Project-relative, forward-slash paths of the `.ts`/`.tsx` files that
    /// changed in this debounced window (e.g. `animation.tsx`, `theme.ts`,
    /// `components/Card.tsx`). The frontend re-reads these to rebuild the map.
    paths: Vec<String>,
}

/// Owns the single active filesystem watcher. Holding the watcher keeps it
/// alive; dropping/replacing it stops watching and ends its debounce thread.
#[derive(Default)]
pub struct FileWatcher {
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
}

impl FileWatcher {
    /// Start watching project `slug`'s `.ts`/`.tsx` files (recursively),
    /// superseding any prior watch. Emits `animation://changed` with the set of
    /// changed project-relative paths after a debounced burst of writes.
    pub fn watch(&self, app: AppHandle, slug: String) -> Result<(), String> {
        let project_dir = claude_bridge::project_dir(&app, &slug)?;
        std::fs::create_dir_all(&project_dir)
            .map_err(|e| format!("failed to create project dir: {e}"))?;

        // The watcher callback forwards the absolute path of each changed
        // `.ts`/`.tsx` file; the debounce thread coalesces and re-maps them to
        // project-relative paths before emitting.
        let (tx, rx) = channel::<PathBuf>();
        let mut watcher = recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                for path in event.paths.iter().filter(|p| is_source_file(p)) {
                    // Receiver gone (watch superseded) -> ignore the send error.
                    let _ = tx.send(path.clone());
                }
            }
        })
        .map_err(|e| format!("failed to create file watcher: {e}"))?;

        // Recursive so edits to files in subdirectories (e.g. `components/`)
        // also refresh the preview; the extension filter still gates to sources.
        watcher
            .watch(&project_dir, RecursiveMode::Recursive)
            .map_err(|e| format!("failed to watch project dir: {e}"))?;

        // Install (and thereby drop any previous watcher) before spawning the
        // debounce thread so the old thread's channel is already disconnected.
        *self
            .watcher
            .lock()
            .map_err(|_| "file watcher lock poisoned".to_string())? = Some(watcher);

        std::thread::spawn(move || debounce_loop(app, project_dir, rx));

        Ok(())
    }
}

/// Block for an event, drain the debounce window collecting the set of changed
/// paths, then emit them as ONE event. Exits when the channel disconnects
/// (watcher dropped on supersede).
fn debounce_loop(app: AppHandle, project_dir: PathBuf, rx: std::sync::mpsc::Receiver<PathBuf>) {
    loop {
        // Wait for the first change.
        let first = match rx.recv() {
            Ok(p) => p,
            Err(_) => return, // watcher dropped
        };
        let mut changed: BTreeSet<PathBuf> = BTreeSet::new();
        changed.insert(first);
        // Coalesce: keep extending the window until it goes quiet, gathering
        // every distinct path touched in the burst (a multi-file save collapses
        // to a single emit).
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(p) => {
                    changed.insert(p);
                    continue;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        emit_changed(&app, &project_dir, &changed);
    }
}

/// Emit the changed files as project-relative, forward-slash paths. Paths that
/// fall outside the project dir (shouldn't happen) are skipped.
fn emit_changed(app: &AppHandle, project_dir: &Path, changed: &BTreeSet<PathBuf>) {
    let mut paths: Vec<String> = Vec::new();
    for abs in changed {
        if let Ok(rel) = abs.strip_prefix(project_dir) {
            // Normalize to forward slashes so keys match `list_project_files`.
            let rel = rel.to_string_lossy().replace('\\', "/");
            if !rel.is_empty() {
                paths.push(rel);
            }
        }
    }
    if !paths.is_empty() {
        let _ = app.emit("animation://changed", ChangedPayload { paths });
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
