//! On-demand MP4-render toolchain.
//!
//! Rendering MP4 needs a Node runtime + the Remotion render deps (incl. a native
//! compositor binary). Rather than bloat the base app for every user, we ship
//! small and, the first time someone renders, download a self-contained archive
//! (Node + the render closure + scripts/render-mp4.mjs) into app-data and unpack
//! it. Subsequent renders reuse it. The archive is produced by
//! `scripts/build-render-toolchain.mjs`.
//!
//! macOS arm64 only for now. Other platforms need their own Node + their own
//! `@remotion/compositor-<platform>` -- a later step.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/// Where to fetch the toolchain and how to verify it. Built + reported by
/// `scripts/build-render-toolchain.mjs`; after uploading the archive as a release
/// asset, paste its url / sha256 / sizeMb here.
pub struct ToolchainManifest {
    /// Remotion version this toolchain renders with (all @remotion/* align).
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_mb: u32,
}

// Produced by `scripts/build-render-toolchain.mjs` and hosted as a GitHub release
// asset (the repo is public, so the asset downloads without auth). To publish a new
// toolchain: rebuild, upload, and update url + sha256 + size_mb + version here.
pub const TOOLCHAIN: ToolchainManifest = ToolchainManifest {
    version: "4.0.473",
    url: "https://github.com/Peter-Dated-Projects/2026-06-04_claude-motion-design/releases/download/render-toolchain-v4.0.473/render-toolchain-4.0.473-darwin-arm64.tar.gz",
    sha256: "9e902c9682b8412a8a96991689695834740349452ca78a63579f45661cb7a3a1",
    size_mb: 77,
};

/// Sentinel returned by `export_mp4` when no render toolchain is available (and
/// no dev fallback). The frontend matches this exact string to show the
/// first-render install prompt instead of an error toast.
pub const TOOLCHAIN_MISSING: &str = "TOOLCHAIN_MISSING";

/// `{appData}/render-toolchain/{version}` — versioned so a newer toolchain
/// installs alongside an old one rather than half-overwriting it.
fn toolchain_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(base.join("render-toolchain").join(TOOLCHAIN.version))
}

/// The install is complete only when this marker exists, so a download that dies
/// mid-unpack never looks installed.
fn ok_marker(dir: &std::path::Path) -> PathBuf {
    dir.join(".ok")
}

pub fn node_bin(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(toolchain_dir(app)?.join("bin").join("node"))
}

pub fn render_script(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(toolchain_dir(app)?.join("render-mp4.mjs"))
}

pub fn is_installed(app: &AppHandle) -> bool {
    let Ok(dir) = toolchain_dir(app) else {
        return false;
    };
    ok_marker(&dir).is_file()
        && dir.join("bin").join("node").is_file()
        && dir.join("render-mp4.mjs").is_file()
}

/// DEV FALLBACK: when running from the repo, render with its own
/// scripts/render-mp4.mjs + node_modules via a `node` on PATH, so contributors
/// can render without first downloading the toolchain. Returns `(script, cwd)`.
/// Never present in a packaged app (CARGO_MANIFEST_DIR won't point at a checkout).
pub fn dev_fallback() -> Option<(PathBuf, PathBuf)> {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let script = repo_root.join("scripts").join("render-mp4.mjs");
    if script.is_file() && repo_root.join("node_modules").is_dir() {
        Some((script, repo_root.to_path_buf()))
    } else {
        None
    }
}

#[derive(Serialize)]
pub struct ToolchainStatus {
    pub installed: bool,
    pub version: String,
    pub size_mb: u32,
}

#[tauri::command]
pub fn render_toolchain_status(app: AppHandle) -> ToolchainStatus {
    ToolchainStatus {
        // "installed" really means "can render now" -- the dev fallback counts, so
        // contributors running from the repo aren't nagged to download anything.
        installed: is_installed(&app) || dev_fallback().is_some(),
        version: TOOLCHAIN.version.to_string(),
        size_mb: TOOLCHAIN.size_mb,
    }
}

#[derive(Clone, Serialize)]
struct InstallProgress {
    /// "download" | "verify" | "extract"
    phase: &'static str,
    /// 0.0..1.0; for phases without a known total it stays at 0 (UI shows a
    /// spinner for that phase).
    progress: f64,
}

fn emit(app: &AppHandle, phase: &'static str, progress: f64) {
    let _ = app.emit("toolchain://progress", InstallProgress { phase, progress });
}

/// Download, verify, and unpack the toolchain. Idempotent: returns immediately if
/// already installed. Streams `toolchain://progress` events for the UI.
///
/// Runs the blocking work on the blocking pool: Tauri executes sync commands on
/// the main thread, and a multi-second download there would freeze the UI.
#[tauri::command]
pub async fn install_render_toolchain(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install_toolchain_blocking(app))
        .await
        .map_err(|e| format!("install task failed: {e}"))?
}

fn install_toolchain_blocking(app: AppHandle) -> Result<(), String> {
    if is_installed(&app) {
        return Ok(());
    }
    if TOOLCHAIN.url == "REPLACE_ME" || TOOLCHAIN.sha256 == "REPLACE_ME" {
        return Err(
            "Render toolchain is not configured yet. Build it with \
             `node scripts/build-render-toolchain.mjs`, upload the archive, and paste \
             its url + sha256 + sizeMb into TOOLCHAIN in render_toolchain.rs."
                .to_string(),
        );
    }

    let dir = toolchain_dir(&app)?;
    // Stage everything beside the final dir, then swap in atomically once the
    // .ok marker is written -- a partial download never poisons the install.
    let tmp_dir = dir.with_extension("incomplete");
    fs::remove_dir_all(&tmp_dir).ok();
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("failed to create staging dir: {e}"))?;

    // ---- download (streamed to a file, progress by content-length) ----
    emit(&app, "download", 0.0);
    let mut resp = reqwest::blocking::Client::builder()
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?
        .get(TOOLCHAIN.url)
        .send()
        .map_err(|e| format!("download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed: {e}"))?;
    let total = resp.content_length().unwrap_or(0);

    let archive_path = tmp_dir.join("toolchain.tar.gz");
    {
        let mut file = fs::File::create(&archive_path)
            .map_err(|e| format!("failed to create archive file: {e}"))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 256 * 1024];
        let mut read_total: u64 = 0;
        loop {
            let n = resp
                .read(&mut buf)
                .map_err(|e| format!("download read failed: {e}"))?;
            if n == 0 {
                break;
            }
            use std::io::Write;
            file.write_all(&buf[..n])
                .map_err(|e| format!("archive write failed: {e}"))?;
            hasher.update(&buf[..n]);
            read_total += n as u64;
            if total > 0 {
                emit(&app, "download", read_total as f64 / total as f64);
            }
        }

        // ---- verify ----
        emit(&app, "verify", 0.0);
        let got = format!("{:x}", hasher.finalize());
        if !got.eq_ignore_ascii_case(TOOLCHAIN.sha256) {
            fs::remove_dir_all(&tmp_dir).ok();
            return Err(format!(
                "toolchain checksum mismatch (expected {}, got {got}) -- aborting.",
                TOOLCHAIN.sha256
            ));
        }
    }

    // ---- extract ----
    emit(&app, "extract", 0.0);
    let tar_gz =
        fs::File::open(&archive_path).map_err(|e| format!("failed to reopen archive: {e}"))?;
    let extract_into = tmp_dir.join("payload");
    fs::create_dir_all(&extract_into).map_err(|e| format!("failed to create payload dir: {e}"))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(tar_gz));
    archive
        .unpack(&extract_into)
        .map_err(|e| format!("failed to unpack toolchain: {e}"))?;

    // Make the node binary executable (tar usually preserves this, but be sure).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let node = extract_into.join("bin").join("node");
        if let Ok(meta) = fs::metadata(&node) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(&node, perms);
        }
    }

    // Swap the finished payload into place, then write the .ok marker last.
    fs::remove_dir_all(&dir).ok();
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create toolchain root: {e}"))?;
    }
    fs::rename(&extract_into, &dir)
        .map_err(|e| format!("failed to move toolchain into place: {e}"))?;
    fs::write(ok_marker(&dir), TOOLCHAIN.version)
        .map_err(|e| format!("failed to write install marker: {e}"))?;

    fs::remove_dir_all(&tmp_dir).ok();
    emit(&app, "extract", 1.0);
    Ok(())
}
