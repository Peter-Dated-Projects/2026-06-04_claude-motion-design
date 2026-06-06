//! Rotoscoping media enumeration: the read-side companion to the rotoscoping
//! bridge (commands/rotoscoping.rs writes the output folders; this lists them).
//!
//! ## Command (registered in lib.rs)
//!   - `list_rotoscope_outputs(app, slug) -> Vec<RotoOutput>`
//!       Enumerate `<project>/assets/rotoscope_*/`, and for each folder collect
//!       its ordered `frame_*.png` absolute paths, surface the first as a
//!       thumbnail, and read `meta.json` for the source path + frame_skip (used
//!       by the frontend to play the sequence back as stop-motion at the
//!       effective output fps). Folders are listed even if meta.json is missing
//!       or malformed -- the on-disk PNGs are authoritative; meta is enrichment.
//!
//! ## Schema casing
//! `RotoOutput` is `#[serde(rename_all = "camelCase")]` to match the rest of the
//! Tauri command surface (see ig_pipeline.rs / rotoscoping.rs). The on-disk
//! `meta.json` is snake_case (written by rotoscoping.rs::RotoMeta), so the struct
//! that DESERIALIZES it is left snake_case (no rename).
//!
//! Source videos are intentionally NOT listed here: per the proposal they are
//! referenced in place and never copied into the project, so there is no project
//! video registry to enumerate -- the frontend loads a source via a file picker.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Payload schema (crosses to the frontend -- camelCase)
// ---------------------------------------------------------------------------

/// One completed rotoscope job: an `assets/rotoscope_<stem>/` folder plus its
/// ordered PNG sequence. Mirrors the frontend `RotoOutput` (defined in
/// RotoOutputsPanel.tsx). `frameCount` and `frames` reflect what is actually on
/// disk; `source` / `frameSkip` come from `meta.json` and are null when it is
/// absent or unreadable.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotoOutput {
    /// Folder name, e.g. `rotoscope_clip` -- the displayed label.
    pub name: String,
    /// Absolute path to the output folder under the project's assets.
    pub dir: String,
    /// Absolute source video path from meta.json, or null if unknown.
    pub source: Option<String>,
    /// `frame_skip` from meta.json (drives effective-fps playback), or null.
    pub frame_skip: Option<u32>,
    /// Number of `frame_*.png` files actually present on disk.
    pub frame_count: u32,
    /// Absolute path to the first PNG (the thumbnail), or null if none.
    pub thumbnail: Option<String>,
    /// Ordered absolute PNG paths for looping stop-motion playback.
    pub frames: Vec<String>,
}

/// The subset of `meta.json` (rotoscoping.rs::RotoMeta) this module reads. Other
/// keys (points, model, generated_at, frame_count) are ignored -- the on-disk
/// PNG count is authoritative, not meta's recorded count.
#[derive(Deserialize)]
struct RotoMetaRead {
    source: Option<String>,
    frame_skip: Option<u32>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// {documentDir}/ClaudeMotion/projects/<slug>. MUST match the hand-duplicated
/// derivation in projects.rs / export.rs / ig_pipeline.rs / rotoscoping.rs /
/// claude_bridge.rs / zip.rs -- moving it requires changing all of them or this
/// reads a different folder than the project store.
fn project_dir(app: &AppHandle, slug: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("failed to resolve document dir: {e}"))?
        .join("ClaudeMotion")
        .join("projects")
        .join(slug);
    if !dir.is_dir() {
        return Err(format!("project '{slug}' not found"));
    }
    Ok(dir)
}

/// Ordered `frame_*.png` absolute paths in `dir`, sorted by filename. The
/// microservice zero-pads frame indices (`frame_0001.png`), so a lexical sort is
/// also the numeric (playback) order.
fn ordered_frames(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.starts_with("frame_") && n.to_ascii_lowercase().ends_with(".png"))
            .collect(),
        Err(_) => return Vec::new(),
    };
    names.sort();
    names
        .into_iter()
        .map(|n| dir.join(n).to_string_lossy().to_string())
        .collect()
}

/// Read `meta.json` in `dir` for the source path + frame_skip. Missing or
/// malformed meta is not an error -- the folder is still a valid output, just
/// without enrichment (returns None/None).
fn read_meta(dir: &Path) -> (Option<String>, Option<u32>) {
    let raw = match std::fs::read_to_string(dir.join("meta.json")) {
        Ok(s) => s,
        Err(_) => return (None, None),
    };
    match serde_json::from_str::<RotoMetaRead>(&raw) {
        Ok(meta) => (meta.source, meta.frame_skip),
        Err(_) => (None, None),
    }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/// List a project's completed rotoscope outputs for the Outputs pane: enumerate
/// `<project>/assets/rotoscope_*/`, and for each folder gather its ordered PNG
/// sequence + thumbnail + (best-effort) meta. Folders not matching the
/// `rotoscope_` prefix are ignored; a missing `assets/` dir yields an empty list.
#[tauri::command]
pub fn list_rotoscope_outputs(app: AppHandle, slug: String) -> Result<Vec<RotoOutput>, String> {
    let assets_dir = project_dir(&app, &slug)?.join("assets");
    if !assets_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut outputs = Vec::new();
    for entry in std::fs::read_dir(&assets_dir)
        .map_err(|e| format!("failed to read assets dir: {e}"))?
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("rotoscope_") {
            continue;
        }

        let frames = ordered_frames(&dir);
        let (source, frame_skip) = read_meta(&dir);
        outputs.push(RotoOutput {
            name,
            dir: dir.to_string_lossy().to_string(),
            source,
            frame_skip,
            frame_count: frames.len() as u32,
            thumbnail: frames.first().cloned(),
            frames,
        });
    }

    // Stable, deterministic order for the pane (newest-naming is not encoded in
    // the folder, so sort by name).
    outputs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(outputs)
}
