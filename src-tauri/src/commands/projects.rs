// Local project storage: project CRUD backed by the local filesystem.
// No database -- each project is a folder under {appDataDir}/projects/{slug}/
// containing project.json, animation.tsx, conversation.json, and assets/.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
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

// --- path helpers -----------------------------------------------------------

/// {appDataDir}/projects, created if missing.
fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?
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

/// Bump updated_at on project.json after a mutating write.
fn touch_updated_at(dir: &PathBuf) -> Result<(), String> {
    let mut project = read_project_meta(dir)?;
    project.updated_at = now_rfc3339();
    write_project_meta(dir, &project)
}
