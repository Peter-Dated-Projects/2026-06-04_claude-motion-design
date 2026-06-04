// Local project storage: project CRUD backed by the local filesystem.
// No database -- each project is a folder under
// {documentDir}/ClaudeMotion/projects/{slug}/ containing project.json,
// animation.tsx, conversation.json, and assets/. Projects live in the user's
// Documents folder (not the hidden app_data_dir) because they are user-owned
// React source the user wants to open and edit; only the Claude config stays
// in app_data_dir. The same root is resolved in claude_bridge.rs::project_dir()
// (PTY cwd + animation.tsx watcher) and MUST stay in agreement.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

// --- std-only id + time helpers ---------------------------------------------
// This ticket's scope deliberately excludes Cargo.toml, so we avoid the uuid /
// chrono crates and derive both from the standard library. Project ids only
// need to be unique within one local install, and timestamps only need to be
// RFC3339 strings that sort lexicographically by recency.

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Nanoseconds since the UNIX epoch (best-effort entropy/ordering source).
fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Whole seconds since the UNIX epoch.
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A UUIDv4-shaped identifier. Not cryptographically random, but collision-safe
/// for a single-user local store: 128 bits seeded from the nanosecond clock and
/// a monotonic counter, with the version/variant bits set per RFC 4122.
fn new_id() -> String {
    let nanos = now_nanos();
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let hi = (nanos as u64) ^ counter.rotate_left(32);
    let lo = ((nanos >> 64) as u64) ^ counter.wrapping_mul(0x9E37_79B9_7F4A_7C15);

    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&hi.to_be_bytes());
    bytes[8..].copy_from_slice(&lo.to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// Format UNIX epoch seconds as a UTC RFC3339 timestamp (e.g. 2026-06-04T12:30:00Z).
/// Uses Howard Hinnant's civil_from_days algorithm for the date part.
fn rfc3339(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let secs_of_day = epoch_secs % 86_400;
    let (hh, mm, ss) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };

    format!("{year:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Current time as a UTC RFC3339 string.
fn now_rfc3339() -> String {
    rfc3339(now_secs())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub created_at: String,
    pub updated_at: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

/// One entry in a project's source tree. `path` is project-relative and always
/// uses forward slashes so the frontend can split it uniformly across platforms.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub path: String,
    pub is_dir: bool,
}

/// Names excluded from the source tree: project metadata, the (vestigial)
/// conversation log, the media folder, and a future per-project chats folder.
/// Everything else under the project dir is treated as editable source.
const NON_SOURCE: [&str; 4] = ["project.json", "conversation.json", "assets", "chats"];

// --- path helpers -----------------------------------------------------------

/// {documentDir}/ClaudeMotion/projects, created if missing. Resolved via Tauri's
/// `document_dir()` so projects land in the user's visible Documents folder.
/// Must match `claude_bridge.rs::project_dir()`, which feeds the PTY cwd and the
/// animation.tsx watcher.
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

fn project_dir(app: &AppHandle, slug: &str) -> Result<PathBuf, String> {
    Ok(projects_root(app)?.join(slug))
}

/// kebab-case: lowercase, non-alphanumeric runs collapse to a single hyphen,
/// leading/trailing hyphens trimmed.
fn kebab_case(name: &str) -> String {
    let mut out = String::new();
    let mut prev_hyphen = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_hyphen = false;
        } else if !prev_hyphen && !out.is_empty() {
            out.push('-');
            prev_hyphen = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed
    }
}

fn read_project_meta(dir: &PathBuf) -> Result<Project, String> {
    let path = dir.join("project.json");
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("failed to parse project.json: {e}"))
}

fn write_project_meta(dir: &PathBuf, project: &Project) -> Result<(), String> {
    let path = dir.join("project.json");
    let raw = serde_json::to_string_pretty(project)
        .map_err(|e| format!("failed to serialize project.json: {e}"))?;
    fs::write(&path, raw).map_err(|e| format!("failed to write project.json: {e}"))
}

// --- commands ---------------------------------------------------------------

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectMeta>, String> {
    let root = projects_root(&app)?;
    let mut metas: Vec<ProjectMeta> = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| format!("failed to read projects dir: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to read dir entry: {e}"))?;
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        // Skip folders without a valid project.json rather than failing the whole list.
        if let Ok(project) = read_project_meta(&dir) {
            metas.push(ProjectMeta {
                id: project.id,
                name: project.name,
                slug: project.slug,
                updated_at: project.updated_at,
            });
        }
    }
    // Most recently updated first.
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

#[tauri::command]
pub fn create_project(app: AppHandle, name: String) -> Result<Project, String> {
    let root = projects_root(&app)?;
    let base = kebab_case(&name);

    // Resolve slug collision by appending a timestamp suffix.
    let mut slug = base.clone();
    if root.join(&slug).exists() {
        slug = format!("{base}-{}", now_nanos() / 1_000_000);
    }

    let dir = root.join(&slug);
    fs::create_dir_all(dir.join("assets"))
        .map_err(|e| format!("failed to create project dirs: {e}"))?;

    let now = now_rfc3339();
    let project = Project {
        id: new_id(),
        name,
        slug,
        created_at: now.clone(),
        updated_at: now,
        session_id: None,
    };

    write_project_meta(&dir, &project)?;
    // Seed empty animation + conversation so loads never miss.
    fs::write(dir.join("animation.tsx"), "")
        .map_err(|e| format!("failed to seed animation.tsx: {e}"))?;
    fs::write(dir.join("conversation.json"), "[]")
        .map_err(|e| format!("failed to seed conversation.json: {e}"))?;

    Ok(project)
}

#[tauri::command]
pub fn open_project(app: AppHandle, slug: String) -> Result<Project, String> {
    let dir = project_dir(&app, &slug)?;
    if !dir.is_dir() {
        return Err(format!("project '{slug}' not found"));
    }
    read_project_meta(&dir)
}

#[tauri::command]
pub fn delete_project(app: AppHandle, slug: String) -> Result<(), String> {
    let dir = project_dir(&app, &slug)?;
    if !dir.is_dir() {
        return Err(format!("project '{slug}' not found"));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("failed to delete project: {e}"))
}

#[tauri::command]
pub fn save_animation(app: AppHandle, slug: String, code: String) -> Result<(), String> {
    let dir = project_dir(&app, &slug)?;
    if !dir.is_dir() {
        return Err(format!("project '{slug}' not found"));
    }
    fs::write(dir.join("animation.tsx"), code)
        .map_err(|e| format!("failed to write animation.tsx: {e}"))?;
    touch_updated_at(&dir)
}

#[tauri::command]
pub fn load_animation(app: AppHandle, slug: String) -> Result<String, String> {
    let dir = project_dir(&app, &slug)?;
    let path = dir.join("animation.tsx");
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|e| format!("failed to read animation.tsx: {e}"))
}

// --- generalized per-path file access ---------------------------------------

/// Resolve a project-relative path to an absolute path inside `dir`, rejecting
/// anything that could escape the project directory. Only "normal" path
/// components are allowed -- absolute paths, `..`, and Windows prefixes/root
/// components are all refused, so the result is guaranteed to stay under `dir`.
fn safe_join(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err("empty path".to_string());
    }
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err(format!("absolute paths are not allowed: {rel}"));
    }
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(format!("path may not contain '..' or root segments: {rel}")),
        }
    }
    Ok(dir.join(candidate))
}

/// Recursively collect a project's source files (and the directories that hold
/// them), excluding metadata, assets, chats, and dotfiles. Paths are
/// project-relative with forward slashes. Today most projects are just
/// `animation.tsx`; the tree still renders cleanly with a single file.
fn collect_files(base: &Path, dir: &Path, out: &mut Vec<ProjectFile>) -> Result<(), String> {
    let entries =
        fs::read_dir(dir).map_err(|e| format!("failed to read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("failed to read dir entry: {e}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Skip non-source entries and anything hidden (e.g. .DS_Store).
        if name.starts_with('.') || NON_SOURCE.contains(&name.as_ref()) {
            continue;
        }
        let path = entry.path();
        let rel = path
            .strip_prefix(base)
            .map_err(|e| format!("failed to relativize path: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        let is_dir = path.is_dir();
        out.push(ProjectFile {
            path: rel,
            is_dir,
        });
        if is_dir {
            collect_files(base, &path, out)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_project_files(app: AppHandle, slug: String) -> Result<Vec<ProjectFile>, String> {
    let dir = project_dir(&app, &slug)?;
    if !dir.is_dir() {
        return Err(format!("project '{slug}' not found"));
    }
    let mut files = Vec::new();
    collect_files(&dir, &dir, &mut files)?;
    // Directories first, then files; alphabetical within each. This gives the
    // frontend a stable, tree-friendly order without re-sorting.
    files.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.path.cmp(&b.path),
    });
    Ok(files)
}

#[tauri::command]
pub fn read_file(app: AppHandle, slug: String, path: String) -> Result<String, String> {
    let dir = project_dir(&app, &slug)?;
    if !dir.is_dir() {
        return Err(format!("project '{slug}' not found"));
    }
    let target = safe_join(&dir, &path)?;
    if !target.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&target).map_err(|e| format!("failed to read {path}: {e}"))
}

#[tauri::command]
pub fn write_file(
    app: AppHandle,
    slug: String,
    path: String,
    contents: String,
) -> Result<(), String> {
    let dir = project_dir(&app, &slug)?;
    if !dir.is_dir() {
        return Err(format!("project '{slug}' not found"));
    }
    let target = safe_join(&dir, &path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent dirs for {path}: {e}"))?;
    }
    fs::write(&target, contents).map_err(|e| format!("failed to write {path}: {e}"))?;
    touch_updated_at(&dir)
}

#[tauri::command]
pub fn save_conversation(
    app: AppHandle,
    slug: String,
    messages: Vec<Message>,
) -> Result<(), String> {
    let dir = project_dir(&app, &slug)?;
    if !dir.is_dir() {
        return Err(format!("project '{slug}' not found"));
    }
    let raw = serde_json::to_string_pretty(&messages)
        .map_err(|e| format!("failed to serialize conversation: {e}"))?;
    fs::write(dir.join("conversation.json"), raw)
        .map_err(|e| format!("failed to write conversation.json: {e}"))?;
    touch_updated_at(&dir)
}

#[tauri::command]
pub fn load_conversation(app: AppHandle, slug: String) -> Result<Vec<Message>, String> {
    let dir = project_dir(&app, &slug)?;
    let path = dir.join("conversation.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read conversation.json: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("failed to parse conversation.json: {e}"))
}

/// Reveal a project folder in Finder (macOS). With a `slug`, opens that
/// project's folder; without one (or if it no longer exists), falls back to the
/// projects root so there is always something to show. Spawns `open` directly
/// via std::process -- no shell-plugin capability needed, same rationale as the
/// Claude PTY bridge.
#[tauri::command]
pub fn reveal_project(app: AppHandle, slug: Option<String>) -> Result<(), String> {
    let root = projects_root(&app)?;
    let target = match slug {
        Some(s) if root.join(&s).is_dir() => root.join(&s),
        _ => root,
    };
    std::process::Command::new("open")
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to reveal {}: {e}", target.display()))
}

/// Bump updated_at on project.json after a mutating write.
fn touch_updated_at(dir: &PathBuf) -> Result<(), String> {
    let mut project = read_project_meta(dir)?;
    project.updated_at = now_rfc3339();
    write_project_meta(dir, &project)
}
