// ZIP export/import for projects.
//
// A project is a folder under {appDataDir}/projects/{slug}/ (see projects.rs).
// Export zips that folder (entries prefixed with `{slug}/`) and writes the
// archive to a user-chosen path. Import reads a project zip, extracts it back
// under the projects root -- renaming on slug collision -- and returns the
// resulting Project so the UI can open it.
//
// Both file dialogs are driven from Rust via tauri_plugin_dialog::DialogExt.
// Calling the dialog from Rust bypasses the webview capability system, so this
// needs no `dialog:allow-*` capability entry -- only `dialog:default` (already
// present) to load the plugin.

use crate::commands::projects::Project;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// Sentinel error returned when the user dismisses a file dialog. The frontend
/// treats this specially (no error toast) -- a cancel is not a failure.
const CANCELLED: &str = "cancelled";

/// {documentDir}/ClaudeMotion/projects, created if missing. MUST match
/// projects.rs::projects_root(), claude_bridge.rs::project_dir(), and export.rs --
/// the four are hand-duplicated, so a move has to be applied to all of them or
/// import writes to a different folder than the live project store.
fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("failed to resolve document dir: {e}"))?
        .join("ClaudeMotion")
        .join("projects");
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create projects dir: {e}"))?;
    Ok(dir)
}

/// Recursively collect every file under `root`, returning each one's absolute
/// path paired with its path relative to `root` (forward-slash separated, the
/// zip convention). Empty directories are dropped -- the projects layout always
/// has files, and import recreates parent dirs on extraction.
fn collect_files(root: &Path, rel: &Path, out: &mut Vec<(PathBuf, String)>) -> Result<(), String> {
    let dir = root.join(rel);
    for entry in fs::read_dir(&dir).map_err(|e| format!("failed to read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("failed to read dir entry: {e}"))?;
        let name = entry.file_name();
        let child_rel = rel.join(&name);
        let file_type = entry
            .file_type()
            .map_err(|e| format!("failed to stat {}: {e}", entry.path().display()))?;
        if file_type.is_dir() {
            collect_files(root, &child_rel, out)?;
        } else if file_type.is_file() {
            // Normalize to forward slashes for cross-platform archives.
            let rel_str = child_rel
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            out.push((entry.path(), rel_str));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn export_project_zip(app: AppHandle, slug: String) -> Result<String, String> {
    let dir = projects_root(&app)?.join(&slug);
    if !dir.is_dir() {
        return Err(format!("project '{slug}' not found"));
    }

    // Gather files relative to the project dir, then prefix each archive entry
    // with `{slug}/` so the archive carries its own top-level folder. Import
    // relies on that prefix to recover the slug.
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    collect_files(&dir, Path::new(""), &mut files)?;

    let mut zip = ZipWriter::new(Cursor::new(Vec::<u8>::new()));
    let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);
    for (abs, rel) in &files {
        let data =
            fs::read(abs).map_err(|e| format!("failed to read {}: {e}", abs.display()))?;
        let entry_name = format!("{slug}/{rel}");
        zip.start_file(entry_name, opts)
            .map_err(|e| format!("failed to add zip entry: {e}"))?;
        zip.write_all(&data)
            .map_err(|e| format!("failed to write zip entry: {e}"))?;
    }
    let cursor = zip.finish().map_err(|e| format!("failed to finalize zip: {e}"))?;
    let bytes = cursor.into_inner();

    // Off-main-thread dialog: blocking_* deadlocks on the main thread where Tauri
    // runs sync commands.
    let chosen = {
        let app = app.clone();
        let slug = slug.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .add_filter("ZIP", &["zip"])
                .set_file_name(&format!("{slug}.zip"))
                .blocking_save_file()
        })
        .await
        .map_err(|e| format!("file dialog task failed: {e}"))?
    };
    let path = match chosen {
        Some(fp) => fp
            .into_path()
            .map_err(|e| format!("invalid save path: {e}"))?,
        None => return Err(CANCELLED.to_string()),
    };

    fs::write(&path, &bytes).map_err(|e| format!("failed to write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn import_project_zip(app: AppHandle) -> Result<Project, String> {
    let chosen = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .add_filter("ZIP", &["zip"])
                .blocking_pick_file()
        })
        .await
        .map_err(|e| format!("file dialog task failed: {e}"))?
    };
    let src = match chosen {
        Some(fp) => fp
            .into_path()
            .map_err(|e| format!("invalid open path: {e}"))?,
        None => return Err(CANCELLED.to_string()),
    };

    let bytes = fs::read(&src).map_err(|e| format!("failed to read {}: {e}", src.display()))?;
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a valid zip: {e}"))?;

    // Determine the archive's top-level folder (the original slug) from the
    // first path component shared by its entries. enclosed_name() rejects
    // absolute paths and `..` traversal, so extraction stays inside the dir.
    let mut original_slug: Option<String> = None;
    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| format!("failed to read zip entry: {e}"))?;
        let enclosed = file
            .enclosed_name()
            .ok_or_else(|| "zip entry has an unsafe path".to_string())?
            .to_path_buf();
        if let Some(first) = enclosed.components().next() {
            let comp = first.as_os_str().to_string_lossy().to_string();
            match &original_slug {
                None => original_slug = Some(comp),
                Some(existing) if existing != &comp => {
                    return Err("zip does not contain a single project folder".to_string());
                }
                _ => {}
            }
        }
    }
    let original_slug =
        original_slug.ok_or_else(|| "zip is empty or has no project folder".to_string())?;

    // Resolve a free slug: original, then -2, -3, ... on collision.
    let root = projects_root(&app)?;
    let mut slug = original_slug.clone();
    let mut n = 2;
    while root.join(&slug).exists() {
        slug = format!("{original_slug}-{n}");
        n += 1;
    }
    let dest = root.join(&slug);

    // Extract, rewriting the leading slug component to the resolved slug.
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("failed to read zip entry: {e}"))?;
        let enclosed = file
            .enclosed_name()
            .ok_or_else(|| "zip entry has an unsafe path".to_string())?
            .to_path_buf();
        // Strip the original top-level folder; skip the bare folder entry.
        let rel = match enclosed.strip_prefix(&original_slug) {
            Ok(r) if r.as_os_str().is_empty() => continue,
            Ok(r) => r.to_path_buf(),
            Err(_) => continue, // entry outside the project folder; ignore
        };
        let target = dest.join(&rel);
        if file.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|e| format!("failed to create {}: {e}", target.display()))?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
            }
            let mut buf = Vec::with_capacity(file.size() as usize);
            file.read_to_end(&mut buf)
                .map_err(|e| format!("failed to read zip entry: {e}"))?;
            fs::write(&target, &buf)
                .map_err(|e| format!("failed to write {}: {e}", target.display()))?;
        }
    }

    // Reconcile project.json with the resolved slug, then return it.
    let meta_path = dest.join("project.json");
    let raw = fs::read_to_string(&meta_path)
        .map_err(|e| format!("imported zip is missing project.json: {e}"))?;
    let mut project: Project =
        serde_json::from_str(&raw).map_err(|e| format!("failed to parse project.json: {e}"))?;
    if project.slug != slug {
        project.slug = slug.clone();
        let updated = serde_json::to_string_pretty(&project)
            .map_err(|e| format!("failed to serialize project.json: {e}"))?;
        fs::write(&meta_path, updated)
            .map_err(|e| format!("failed to write project.json: {e}"))?;
    }
    Ok(project)
}
