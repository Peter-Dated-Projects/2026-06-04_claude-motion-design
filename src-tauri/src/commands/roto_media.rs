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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::commands::render_toolchain;

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

// ---------------------------------------------------------------------------
// Post-job artifacts: composed video + archived source clip (T-016)
// ---------------------------------------------------------------------------

/// Presence/paths of the post-job artifacts the microservice now produces for a
/// completed rotoscope (T-016): the PNG zip, the composed transparent WebM, and
/// the archived source clip. Each is `None` when that file is not in `dir`.
///
/// CROSS-STAGE NOTE: the composed `output.webm` and `source_clip.mp4` are written
/// into the microservice's server-side work_dir and reaped after `/result` serves
/// the zip. The client bridge (commands/rotoscoping.rs) currently extracts only
/// the PNGs into `assets/rotoscope_*/`, so for those folders `video`/`sourceClip`
/// come back null until that bridge is taught to pull the extra artifacts across.
/// This command is the read-side contract that wiring will satisfy.
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RotoOutputFiles {
    /// Absolute path to the PNG-sequence zip (`result.zip` or any `*.zip`), or null.
    pub zip: Option<String>,
    /// Absolute path to the composed transparent video (`*.webm`), or null.
    pub video: Option<String>,
    /// Absolute path to the archived source clip (`source_clip.mp4`), or null.
    pub source_clip: Option<String>,
}

/// The first directory entry whose filename (case-insensitively) satisfies
/// `pred`, as an absolute path string. Used to locate post-job artifacts by name
/// without assuming a single canonical filename.
fn find_file(dir: &Path, pred: impl Fn(&str) -> bool) -> Option<String> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| pred(&n.to_ascii_lowercase()))
                .unwrap_or(false)
        })
        .map(|p| p.to_string_lossy().to_string())
}

/// Report which post-job artifacts are present in a rotoscope output `dir`: the
/// PNG zip, the composed transparent video, and the archived source clip. A
/// missing file is reported as null rather than an error; only an unreadable /
/// non-existent directory errors.
#[tauri::command]
pub fn get_rotoscope_output_files(dir: String) -> Result<RotoOutputFiles, String> {
    let d = Path::new(&dir);
    if !d.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    Ok(RotoOutputFiles {
        // Prefer the canonical result.zip but accept any zip the bridge dropped.
        zip: find_file(d, |n| n == "result.zip")
            .or_else(|| find_file(d, |n| n.ends_with(".zip"))),
        video: find_file(d, |n| n == "output.webm")
            .or_else(|| find_file(d, |n| n.ends_with(".webm"))),
        source_clip: find_file(d, |n| n == "source_clip.mp4"),
    })
}

// ---------------------------------------------------------------------------
// open_path (reveal a file or folder in the OS)
// ---------------------------------------------------------------------------

/// Open a file or folder with the OS default handler (a video in the default
/// player, a folder in the file browser). Cross-platform via std::process --
/// `open` on macOS, `explorer` on Windows, `xdg-open` on Linux -- mirroring
/// projects.rs::reveal_project's no-shell-plugin approach (no extra capability).
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // `explorer` ignores its own exit code, so we don't inspect status below.
        let mut c = std::process::Command::new("explorer");
        c.arg(&path);
        c
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut cmd = std::process::Command::new("xdg-open");

    #[cfg(not(target_os = "windows"))]
    cmd.arg(&path);

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open {path}: {e}"))
}

// ---------------------------------------------------------------------------
// trim_video (clip-range trim before upload)
// ---------------------------------------------------------------------------

/// Resolve the ffmpeg binary: prefer the bundled one from the render toolchain
/// (the app must NOT assume ffmpeg is on PATH -- see CLAUDE.md). Falls back to a
/// bare `ffmpeg` only as a dev convenience when the toolchain isn't installed.
/// Mirrors `resolve_ffmpeg` in rotoscoping.rs (kept local to avoid widening that
/// module's surface for one more caller).
fn resolve_ffmpeg(app: &AppHandle) -> PathBuf {
    if let Ok(bundled) = render_toolchain::ffmpeg_bin(app) {
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from("ffmpeg")
}

/// A short locally-unique id for the scratch filename: nanos-since-epoch plus a
/// process-lifetime atomic counter, so two trims in the same nanosecond differ.
fn next_local_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{nanos}_{n}")
}

// ---------------------------------------------------------------------------
// export_roto_output: convert an output folder to GIF / MP4 / MOV
// ---------------------------------------------------------------------------

/// Sentinel returned when the user cancels the save dialog — not an error.
const EXPORT_CANCELLED: &str = "cancelled";

/// Run `ffmpeg -hide_banner -i <webm>` and extract the video width from its
/// stderr stream info line ("…, 1280x720,…"). Returns `None` if ffmpeg can't
/// be run or the width can't be parsed (callers fall back to a default).
fn probe_webm_width(ffmpeg: &Path, webm: &Path) -> Option<u32> {
    let out = std::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-i"])
        .arg(webm)
        .output()
        .ok()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stderr.lines() {
        if line.contains("Video:") {
            for word in line.split_whitespace() {
                let word = word.trim_end_matches(',');
                if let Some((w, _h)) = word.split_once('x') {
                    if w.chars().all(|c| c.is_ascii_digit()) {
                        if let Ok(width) = w.parse::<u32>() {
                            return Some(width);
                        }
                    }
                }
            }
        }
    }
    None
}

/// Open a native save dialog for a roto export and return the chosen absolute
/// path, or `"cancelled"` when the user dismisses the dialog. `name` is the
/// folder stem (used as the default filename), `format` is "gif", "mp4", or
/// "mov".
#[tauri::command]
pub async fn choose_roto_export_path(
    app: AppHandle,
    name: String,
    format: String,
) -> Result<String, String> {
    let (desc, ext): (&str, &str) = match format.to_ascii_lowercase().as_str() {
        "gif" => ("GIF Image", "gif"),
        "mp4" => ("MPEG-4 Video", "mp4"),
        "mov" => ("QuickTime / ProRes", "mov"),
        other => return Err(format!("unsupported format: {other}")),
    };

    let default_name = format!("{name}.{ext}");
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(desc, &[ext])
            .set_file_name(&default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("save dialog task failed: {e}"))?;

    match chosen {
        Some(fp) => Ok(fp
            .into_path()
            .map_err(|e| format!("invalid save path: {e}"))?
            .to_string_lossy()
            .to_string()),
        None => Ok(EXPORT_CANCELLED.to_string()),
    }
}

/// Convert an output folder to a user-chosen format (GIF, MP4, or MOV) and
/// write the result to `dest_path`. Emits `export://progress` events (0.0 at
/// start, 0.5 between GIF passes, 1.0 on success). Returns immediately on
/// success or propagates an error string.
///
/// Source preference: `output.webm` in `dir`; falls back to the PNG frame
/// sequence (`frame_*.png`, 1-based naming) if the WebM is absent.
#[tauri::command]
pub fn export_roto_output(
    app: AppHandle,
    dir: String,
    format: String,
    dest_path: String,
) -> Result<(), String> {
    let d = Path::new(&dir);
    if !d.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    if dest_path == EXPORT_CANCELLED {
        return Ok(()); // user cancelled the dialog — not an error
    }

    let ffmpeg = resolve_ffmpeg(&app);

    let _ = app.emit("export://progress", serde_json::json!({ "progress": 0.0 }));

    // Determine the effective fps from meta.json for GIF palettegen.
    let (_, frame_skip) = read_meta(d);
    let skip = frame_skip.unwrap_or(3);
    let fps = 30u32 / (skip + 1);

    // Resolve the input source: prefer output.webm, fall back to PNG frames.
    let webm_path = d.join("output.webm");
    let use_webm = webm_path.is_file();

    let input_args: Vec<String>;
    if use_webm {
        input_args = vec!["-i".to_string(), webm_path.to_string_lossy().to_string()];
    } else {
        // Build PNG sequence source (-framerate N -i frame_%04d.png, 1-based).
        if ordered_frames(d).is_empty() {
            return Err("no output.webm and no PNG frames found in output folder".to_string());
        }
        let pattern = d
            .join("frame_%04d.png")
            .to_string_lossy()
            .to_string();
        input_args = vec![
            "-framerate".to_string(),
            fps.to_string(),
            "-start_number".to_string(),
            "1".to_string(),
            "-i".to_string(),
            pattern,
        ];
    }

    let fmt = format.to_ascii_lowercase();
    match fmt.as_str() {
        "gif" => {
            // Two-pass palettegen.
            // Probe width for scaling; default to 480 if unavailable.
            let width = if use_webm {
                probe_webm_width(&ffmpeg, &webm_path).unwrap_or(480)
            } else {
                480u32
            };
            let scale = format!("fps={fps},scale={width}:-1:flags=lanczos");
            let palette = Path::new(&dest_path)
                .with_extension("palette.png");
            let palette_s = palette.to_string_lossy().to_string();

            // Pass 1: generate palette
            let mut args1: Vec<String> = vec!["-y".to_string()];
            args1.extend(input_args.clone());
            args1.extend([
                "-vf".to_string(),
                format!("{scale},palettegen"),
                palette_s.clone(),
            ]);
            run_ffmpeg(&ffmpeg, &args1, "palettegen")?;

            let _ = app.emit("export://progress", serde_json::json!({ "progress": 0.5 }));

            // Pass 2: apply palette
            let lavfi = format!("{scale} [x]; [x][1:v] paletteuse");
            let mut args2: Vec<String> = vec!["-y".to_string()];
            args2.extend(input_args);
            args2.extend([
                "-i".to_string(),
                palette_s.clone(),
                "-lavfi".to_string(),
                lavfi,
                dest_path.clone(),
            ]);
            run_ffmpeg(&ffmpeg, &args2, "gif paletteuse")?;

            // Clean up temp palette.
            let _ = std::fs::remove_file(&palette);
        }
        "mp4" => {
            let mut args: Vec<String> = vec!["-y".to_string()];
            args.extend(input_args);
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
                dest_path.clone(),
            ]);
            run_ffmpeg(&ffmpeg, &args, "mp4")?;
        }
        "mov" => {
            let mut args: Vec<String> = vec!["-y".to_string()];
            args.extend(input_args);
            args.extend([
                "-c:v".to_string(),
                "prores_ks".to_string(),
                "-profile:v".to_string(),
                "4".to_string(),
                dest_path.clone(),
            ]);
            run_ffmpeg(&ffmpeg, &args, "mov/prores")?;
        }
        other => return Err(format!("unsupported format: {other}")),
    }

    let _ = app.emit("export://progress", serde_json::json!({ "progress": 1.0 }));
    Ok(())
}

/// Run ffmpeg with `args`, collecting stderr. On non-zero exit, return the last
/// 8 stderr lines as an error message.
fn run_ffmpeg(ffmpeg: &Path, args: &[String], label: &str) -> Result<(), String> {
    let output = std::process::Command::new(ffmpeg)
        .args(args)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                render_toolchain::TOOLCHAIN_MISSING.to_string()
            } else {
                format!("failed to launch ffmpeg: {e}")
            }
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(8).collect();
        let msg = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg {label} failed: {msg}"));
    }
    Ok(())
}

/// Trim a source video to the half-open range [start_secs, end_secs) into a
/// throwaway temp file, returning its absolute path. Re-encodes with x264 at a
/// near-lossless CRF (a stream copy can't cut at an arbitrary, non-keyframe
/// boundary), matching the no-compress path of rotoscoping.rs::clip_video. The
/// caller (RotoVideoPanel's submit flow) uploads the returned clip; the
/// downstream `rotoscope_video` re-clips it frame-accurately from the rebased
/// reference frame, so this only needs to bound the range.
///
/// NOTE: the returned file lives in the OS temp dir and is NOT cleaned up here --
/// `rotoscope_video` removes only its own scratch clip, not this input. The OS
/// reclaims temp eventually; a future ticket could delete it post-job.
#[tauri::command]
pub fn trim_video(
    app: AppHandle,
    path: String,
    start_secs: f64,
    end_secs: f64,
) -> Result<String, String> {
    if !(end_secs > start_secs) {
        return Err(format!(
            "invalid clip range: end ({end_secs}) must be greater than start ({start_secs})"
        ));
    }
    let start = start_secs.max(0.0);
    let duration = end_secs - start;

    let ffmpeg = resolve_ffmpeg(&app);
    let dest = std::env::temp_dir().join(format!("claudemotion_trim_{}.mp4", next_local_id()));
    let dest_s = dest.to_string_lossy().to_string();
    let start_s = format!("{start}");
    // `-t` (duration) instead of `-to` so the seek (`-ss`) and length compose
    // correctly when both are output options.
    let dur_s = format!("{duration}");

    let output = std::process::Command::new(&ffmpeg)
        .args([
            "-y",
            "-i",
            &path,
            "-ss",
            &start_s,
            "-t",
            &dur_s,
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            &dest_s,
        ])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                render_toolchain::TOOLCHAIN_MISSING.to_string()
            } else {
                format!("failed to launch ffmpeg: {e}")
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(8).collect();
        let msg = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg trim failed: {msg}"));
    }
    Ok(dest_s)
}
