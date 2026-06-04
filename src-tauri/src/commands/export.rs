// TSX export: write a project's animation.tsx to a user-chosen location,
// alongside a copy of its assets/ folder so the exported file is self-contained.
//
// A project is a folder under {appDataDir}/projects/{slug}/ (see projects.rs)
// holding project.json, animation.tsx, conversation.json, and assets/. Export
// reads animation.tsx, prompts for a save path, writes the TSX there, and copies
// assets/ into the same directory.
//
// The save dialog is driven from Rust via tauri_plugin_dialog::DialogExt, which
// bypasses the webview capability system -- it needs only `dialog:default`
// (already present) to load the plugin, no extra `dialog:allow-*` entry.
//
// NOTE: like the other command files, this is not yet registered in lib.rs's
// invoke_handler -- wiring it in (and mounting ExportMenu in the toolbar) is left
// to the integration pass, since lib.rs and Toolbar.tsx are outside this ticket's
// scope.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// Sentinel error returned when the user dismisses the file dialog. The frontend
/// treats this specially (no error toast) -- a cancel is not a failure.
const CANCELLED: &str = "cancelled";

/// {documentDir}/ClaudeMotion/projects, created if missing. MUST match
/// projects.rs::projects_root(), claude_bridge.rs::project_dir(), and zip.rs --
/// the four are hand-duplicated, so a move has to be applied to all of them or
/// export reads a different folder than the live project store.
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

/// Recursively copy every file under `src` into `dest`, recreating the directory
/// structure. Existing files at the destination are overwritten.
fn copy_dir_all(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("failed to create {}: {e}", dest.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("failed to read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("failed to read dir entry: {e}"))?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("failed to stat {}: {e}", from.display()))?;
        if file_type.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to)
                .map_err(|e| format!("failed to copy {} -> {}: {e}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn export_tsx(app: AppHandle, slug: String) -> Result<String, String> {
    let dir = projects_root(&app)?.join(&slug);
    if !dir.is_dir() {
        return Err(format!("project '{slug}' not found"));
    }

    // Read the current animation source. Projects always seed an empty
    // animation.tsx, so a missing file means a corrupt project rather than a
    // first-run gap -- surface it as an error.
    let tsx_path = dir.join("animation.tsx");
    let code = fs::read_to_string(&tsx_path)
        .map_err(|e| format!("failed to read animation.tsx: {e}"))?;

    let chosen = app
        .dialog()
        .file()
        .add_filter("TypeScript", &["tsx"])
        .set_file_name(&format!("{slug}.tsx"))
        .blocking_save_file();
    let path = match chosen {
        Some(fp) => fp
            .into_path()
            .map_err(|e| format!("invalid save path: {e}"))?,
        None => return Err(CANCELLED.to_string()),
    };

    fs::write(&path, &code).map_err(|e| format!("failed to write {}: {e}", path.display()))?;

    // Copy assets/ next to the exported file so it carries its referenced media.
    // Skip silently if the project has no assets dir (older/empty projects).
    let assets_src = dir.join("assets");
    if assets_src.is_dir() {
        let dest_parent = path
            .parent()
            .ok_or_else(|| "chosen path has no parent directory".to_string())?;
        copy_dir_all(&assets_src, &dest_parent.join("assets"))?;
    }

    Ok(path.to_string_lossy().to_string())
}
