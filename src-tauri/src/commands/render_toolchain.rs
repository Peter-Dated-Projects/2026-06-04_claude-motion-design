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
//
// VERSION NOTE: `version` keys the install dir (`toolchain_dir`). It is NOT just
// the Remotion version anymore -- it carries a `-r<N>` revision suffix
// (TOOLCHAIN_REVISION in the build script) so a contents-only rebuild (e.g.
// re-pinning bundled CLIs without changing Remotion) still produces a new dir and
// forces existing installs to re-fetch. Bumping this is what invalidates a stale
// install that predates the bundled IG CLIs. Keep it in lockstep with the build
// script's printed `version`.
//
// CONTENTS: node + the Remotion render closure, plus the four CLIs the IG
// pipeline spawns (bun, yt-dlp, ffmpeg, ffprobe). Built by
// scripts/build-render-toolchain.mjs (macOS arm64) and published as the release
// asset below. ffmpeg/ffprobe are osxexperts.net darwin-arm64 8.1 static builds
// (evermeet.cx is x86_64-only). When rebuilding, paste the script's printed
// sha256 + sizeMb here; a mismatched/REPLACE_ME sha makes `install_render_*`
// report "not configured" rather than silently failing the checksum.
pub const TOOLCHAIN: ToolchainManifest = ToolchainManifest {
    version: "4.0.473-r2",
    url: "https://github.com/Peter-Dated-Projects/2026-06-04_claude-motion-design/releases/download/render-toolchain-v4.0.473-r2/render-toolchain-4.0.473-r2-darwin-arm64.tar.gz",
    sha256: "7cad9c4e9dfd8be63bf05173c2ec7dc8db680f7529d01f694334bb581b728df1",
    size_mb: 174,
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

/// The unpacked `bin/` dir holding all bundled executables (node + the IG CLIs).
///
/// This is the primitive the IG-pipeline subprocess layer needs: the Bun stages
/// resolve `bun`/`yt-dlp`/`ffmpeg`/`ffprobe` by BARE NAME off PATH (see
/// scripts/ig-pipeline/lib/spawn.ts), so the spawning code prepends this dir to
/// the child's PATH rather than injecting absolute paths per binary.
pub fn toolchain_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(toolchain_dir(app)?.join("bin"))
}

// Per-binary absolute-path accessors. The IG subprocess layer spawns by bare name
// off a PATH built from `toolchain_bin_dir`, so these are for presence checks /
// direct invocation by the future IG command layer (registered in lib.rs by a
// separate ticket); hence #[allow(dead_code)] until that lands.

/// Absolute path to the bundled `bun` runtime (may not exist yet -- callers that
/// need a presence guarantee use [`ig_tools_installed`]).
#[allow(dead_code)]
pub fn bun_bin(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(toolchain_bin_dir(app)?.join("bun"))
}

/// Absolute path to the bundled `yt-dlp` binary.
#[allow(dead_code)]
pub fn ytdlp_bin(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(toolchain_bin_dir(app)?.join("yt-dlp"))
}

/// Absolute path to the bundled `ffmpeg` binary.
#[allow(dead_code)]
pub fn ffmpeg_bin(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(toolchain_bin_dir(app)?.join("ffmpeg"))
}

/// Absolute path to the bundled `ffprobe` binary.
#[allow(dead_code)]
pub fn ffprobe_bin(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(toolchain_bin_dir(app)?.join("ffprobe"))
}

/// Whether all four IG-pipeline CLIs (bun + yt-dlp + ffmpeg + ffprobe) are present
/// in the installed toolchain.
///
/// Deliberately SEPARATE from [`is_installed`] (which gates MP4 render on node +
/// render-mp4.mjs). Folding the CLI checks into `is_installed` would make an
/// older MP4-only toolchain -- or the dev fallback -- read as not-installed and
/// regress MP4 render. This keys off the actual binary files, so a stale install
/// dir that predates the bundled CLIs reads as "IG tools missing" (rather than
/// falsely present off a `.ok` marker alone), prompting a re-fetch.
pub fn ig_tools_installed(app: &AppHandle) -> bool {
    let Ok(bin) = toolchain_bin_dir(app) else {
        return false;
    };
    bin.join("bun").is_file()
        && bin.join("yt-dlp").is_file()
        && bin.join("ffmpeg").is_file()
        && bin.join("ffprobe").is_file()
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
    /// Whether the bundled IG-pipeline CLIs (bun + yt-dlp + ffmpeg + ffprobe) are
    /// present. Reported separately from `installed` (which is about MP4 render)
    /// so the two capabilities can be surfaced independently in the UI.
    pub ig_tools_installed: bool,
}

#[tauri::command]
pub fn render_toolchain_status(app: AppHandle) -> ToolchainStatus {
    ToolchainStatus {
        // "installed" really means "can render now" -- the dev fallback counts, so
        // contributors running from the repo aren't nagged to download anything.
        installed: is_installed(&app) || dev_fallback().is_some(),
        version: TOOLCHAIN.version.to_string(),
        size_mb: TOOLCHAIN.size_mb,
        ig_tools_installed: ig_tools_installed(&app),
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

    // Make the bundled binaries executable (tar usually preserves this, but be
    // sure). The IG CLIs are fetched mach-o files (not copied from a running
    // process like `node`), so re-marking them after unpack matters more here.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin = extract_into.join("bin");
        for name in ["node", "bun", "yt-dlp", "ffmpeg", "ffprobe"] {
            let path = bin.join(name);
            if let Ok(meta) = fs::metadata(&path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = fs::set_permissions(&path, perms);
            }
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
