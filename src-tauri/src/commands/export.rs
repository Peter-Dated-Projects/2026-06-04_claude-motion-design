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

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::commands::render_toolchain;

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
pub async fn export_tsx(app: AppHandle, slug: String) -> Result<String, String> {
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

    // Off-main-thread dialog (see choose_render_output for why).
    let chosen = {
        let app = app.clone();
        let slug = slug.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .add_filter("TypeScript", &["tsx"])
                .set_file_name(&format!("{slug}.tsx"))
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

// ---- MP4 export -----------------------------------------------------------
//
// Renders the project's animation.tsx to an H.264 MP4 by shelling out to the
// repo's Node render script (scripts/render-mp4.mjs), which drives Remotion's
// bundler + renderer (headless Chrome + ffmpeg). We spawn `node` directly --
// like pty_bridge spawns `claude` -- so the Tauri shell-capability model is not
// involved.
//
// LOCAL-NODE APPROACH (dev / dogfooding): the script and its node_modules live
// in the repo, located here via CARGO_MANIFEST_DIR (the src-tauri dir) -> its
// parent is the repo root. This works when running from the repo (npm run
// tauri dev / a dev build). Shipping to users with nothing installed needs a
// bundled Node+Chromium sidecar instead -- a separate step.

/// Progress event payload (0.0..1.0). Emitted on `export://progress` as the
/// render advances so the UI can show a determinate bar instead of a spinner.
#[derive(Clone, Serialize)]
struct RenderProgress {
    progress: f64,
}

/// Resolve which Node + render script to run, as `(node, script, cwd)`.
///
/// Preference order:
///   1. The installed on-demand toolchain in app-data (the shipped path).
///   2. DEV FALLBACK: the repo's own scripts/render-mp4.mjs + node_modules via a
///      `node` on PATH, so contributors can render without first downloading the
///      toolchain. Only viable when running from the repo (CARGO_MANIFEST_DIR
///      still points at a real checkout) -- never true in a packaged app.
///
/// Returns `Err(TOOLCHAIN_MISSING)` when neither is available; the frontend turns
/// that into the first-render install prompt rather than an error.
fn resolve_runner(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    if render_toolchain::is_installed(app) {
        let node = render_toolchain::node_bin(app)?;
        let script = render_toolchain::render_script(app)?;
        let cwd = node
            .parent()
            .and_then(|p| p.parent())
            .ok_or_else(|| "bad toolchain layout".to_string())?
            .to_path_buf();
        return Ok((node, script, cwd));
    }

    if let Some((script, cwd)) = render_toolchain::dev_fallback() {
        return Ok((PathBuf::from("node"), script, cwd));
    }

    Err(render_toolchain::TOOLCHAIN_MISSING.to_string())
}

/// Open a native save dialog for the render output and return the chosen path
/// (or `None` if the user cancelled). The render modal calls this for its
/// "Choose location" step -- file selection is decoupled from `export_mp4` so it
/// can happen in the modal before the user commits to rendering.
#[tauri::command]
pub async fn choose_render_output(
    app: AppHandle,
    slug: String,
    ext: String,
) -> Result<Option<String>, String> {
    // The dialog plugin's blocking_* APIs deadlock if called on the main thread,
    // and Tauri runs *sync* commands there -- so run the dialog on the blocking
    // pool (this command is async, but the panel itself must be off the main thread).
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let label = format!("{} Video", ext.to_uppercase());
        app.dialog()
            .file()
            .add_filter(&label, &[ext.as_str()])
            .set_file_name(&format!("{slug}.{ext}"))
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("file dialog task failed: {e}"))?;
    match chosen {
        Some(fp) => Ok(Some(
            fp.into_path()
                .map_err(|e| format!("invalid save path: {e}"))?
                .to_string_lossy()
                .to_string(),
        )),
        None => Ok(None),
    }
}

/// Render the project's animation to `out_path` with the given codec + quality.
/// File selection happens earlier via `choose_render_output`; this just renders.
#[tauri::command]
pub async fn export_mp4(
    app: AppHandle,
    slug: String,
    out_path: String,
    codec: String,
    quality: String,
    // GIF target frame rate. Only meaningful for codec == "gif"; the script drops
    // frames to hit it. None for video codecs (and older callers).
    gif_fps: Option<f64>,
    // GIF lossy-compression level ("none" | "light" | "strong"). gifsicle post-process.
    gif_compression: Option<String>,
) -> Result<String, String> {
    let dir = projects_root(&app)?.join(&slug);
    if !dir.is_dir() {
        return Err(format!("project '{slug}' not found"));
    }

    // Guard against rendering an empty project: an empty animation.tsx has no
    // default export and Remotion would fail with a cryptic message.
    let tsx_path = dir.join("animation.tsx");
    let code = fs::read_to_string(&tsx_path)
        .map_err(|e| format!("failed to read animation.tsx: {e}"))?;
    if code.trim().is_empty() {
        return Err("animation.tsx is empty -- generate an animation first.".to_string());
    }

    // Resolve the renderer; if neither the toolchain nor a dev fallback is
    // available, bail with TOOLCHAIN_MISSING so the frontend can prompt to install.
    let (node, script, cwd) = resolve_runner(&app)?;
    let out = PathBuf::from(&out_path);

    // The render is a multi-second/-minute blocking pipeline -- run it on the
    // blocking pool so it never freezes the UI (Tauri runs sync commands on the
    // main thread). Progress events are emitted from inside.
    let out_for_render = out.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_render(
            &app,
            &node,
            &script,
            &cwd,
            &dir,
            &out_for_render,
            &codec,
            &quality,
            gif_fps,
            gif_compression.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("render task failed: {e}"))?
}

/// Spawn the Node render process, stream `PROGRESS` lines as `export://progress`
/// events, and return the output path on success or the stderr tail on failure.
/// Blocking; call from `spawn_blocking`, never directly on a command thread.
fn run_render(
    app: &AppHandle,
    node: &Path,
    script: &Path,
    cwd: &Path,
    dir: &Path,
    out: &Path,
    codec: &str,
    quality: &str,
    gif_fps: Option<f64>,
    gif_compression: Option<&str>,
) -> Result<String, String> {
    let mut cmd = Command::new(node);
    cmd.arg(script)
        .arg(dir)
        .arg(out)
        .arg(codec)
        .arg(quality);
    // Positional GIF args: 5th = target fps, 6th = lossy-compression level. Pass
    // them only when set so video renders keep the 4-arg shape the script expects.
    // They travel together for GIF (the modal always sends both), so the 6th arg
    // never lands in the 5th's slot.
    if let Some(fps) = gif_fps {
        cmd.arg(fps.to_string());
        if let Some(level) = gif_compression {
            cmd.arg(level);
        }
    }
    let mut child = cmd
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch the render process: {e}"))?;

    // Drain stderr on a separate thread so a chatty render (e.g. the first-run
    // Chrome download) can't fill the pipe buffer and deadlock the child while
    // we block reading stdout.
    let stderr = child.stderr.take();
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut se) = stderr {
            let _ = se.read_to_string(&mut buf);
        }
        buf
    });

    // Parse `PROGRESS <0..1>` lines off stdout and forward them as events.
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("PROGRESS ") {
                if let Ok(progress) = rest.trim().parse::<f64>() {
                    let _ = app.emit("export://progress", RenderProgress { progress });
                }
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("render process failed: {e}"))?;
    let stderr_text = stderr_handle.join().unwrap_or_default();

    if status.success() {
        Ok(out.to_string_lossy().to_string())
    } else {
        // Surface the last few stderr lines -- the real Remotion error tail.
        let tail: Vec<&str> = stderr_text.lines().rev().take(8).collect();
        let msg: String = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        Err(if msg.trim().is_empty() {
            "MP4 render failed.".to_string()
        } else {
            msg
        })
    }
}
