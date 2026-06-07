//! Rotoscoping microservice bridge: the Tauri backend engine.
//!
//! Bridges the app to an optional Windows/GPU SAM2 microservice over HTTP. The
//! service runs an ASYNC job model (port fixed at 7080, host from Settings,
//! default localhost):
//!   - GET    /health                          -> service + model + VRAM status
//!   - POST   /rotoscope                        -> multipart upload; returns 202
//!       {job_id} IMMEDIATELY and runs the job in the background (it does NOT
//!       stream the ZIP back).
//!   - GET    /rotoscope/{job_id}/progress      -> SSE progress stream; terminal
//!       stages are `done|error|cancelled`.
//!   - GET    /rotoscope/{job_id}/result        -> the PNG ZIP once stage==done;
//!       `425` while still running, `409` cancelled, `500` error, `404` unknown.
//!   - DELETE /rotoscope/{job_id}               -> cancel an in-flight job.
//!
//! ## Commands (registered in lib.rs)
//!   - `check_rotoscoping_service(host) -> RotoscopingStatus`
//!       Never errors. Unreachable service is a NORMAL state (the workspace just
//!       hides), so this returns `available: false` rather than an Err.
//!   - `rotoscope_video(app, slug, host, sourcePath, jobId, startFrame, points,
//!       frameSkip, compress, quality) -> RotoscopeResult`
//!       Clips the source from startFrame to end with the bundled ffmpeg, POSTs
//!       the clip (registering the job under the client-supplied `jobId`), drives
//!       the SSE stream to completion, fetches the result ZIP and unpacks it into
//!       the project's assets, writes meta.json. Streams progress on
//!       `roto://progress`. Resolves only when the whole job is done.
//!   - `cancel_rotoscope(host, jobId)` -> DELETE the job. `jobId` is the SAME id
//!       the client passed to `rotoscope_video`, so the DELETE reaches the real job.
//!
//! ## Event channel
//!   - `roto://progress`  RotoProgress  (per SSE tick from the microservice)
//!
//! ## Schema casing
//! Every payload struct crossing to the frontend is `#[serde(rename_all =
//! "camelCase")]`, matching the rest of the Tauri command surface (see
//! ig_pipeline.rs). The microservice's own JSON (health, SSE) uses snake_case
//! keys, so the structs that DESERIALIZE service responses are left in plain
//! snake_case field order (no rename) and mapped into the camelCase payloads.
//!
//! ## HTTP layer
//! reqwest is built `default-features = false` with only `blocking`, `rustls-tls`,
//! and `stream` (see Cargo.toml) -- no async client and no `multipart` feature.
//! So every request goes through `reqwest::blocking` inside `spawn_blocking`, and
//! the multipart upload body is assembled BY HAND (boundary + parts) rather than
//! via `reqwest::blocking::multipart`, which the `multipart` feature would be
//! needed for. The SSE stream is read as plain lines off the blocking response
//! (`Response` implements `Read`).

use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::render_toolchain;

/// Fixed microservice port (per the proposal; only the host is configurable).
const PORT: u16 = 7080;

/// The SAM2 model name recorded in meta.json when /health does not report one.
const DEFAULT_MODEL: &str = "sam2_hiera_large";

// ---------------------------------------------------------------------------
// Payload schema (crosses to the frontend -- camelCase)
// ---------------------------------------------------------------------------

/// A user-placed prompt point on the reference frame. `label`: 1 = foreground,
/// 0 = background exclusion. Round-trips unchanged into the multipart `points`
/// field and into meta.json.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotoPoint {
    pub x: f64,
    pub y: f64,
    pub label: u8,
}

/// Result of `check_rotoscoping_service`. `available` is the only field the UI
/// needs to decide whether to show the workspace; the model/VRAM fields are
/// informational and absent when the service is unreachable.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotoscopingStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vram_used_gb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vram_total_gb: Option<f64>,
    #[serde(rename = "gpuProfile", skip_serializing_if = "Option::is_none")]
    pub gpu_profile: Option<GpuProfile>,
}

/// The service's startup GPU probe, surfaced through /health and forwarded to the
/// frontend. Serialized camelCase (frontend contract); the service's own JSON is
/// snake_case, so the deserialize side is `GpuProfileBody` and we map between them
/// in `check_blocking` (same split as `HealthBody` -> `RotoscopingStatus`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuProfile {
    pub name: String,
    pub generation: String,
    pub compute_capability: Vec<i64>,
    pub vram_gb: f64,
    pub dtype_str: String,
}

/// A progress tick emitted on `roto://progress`. Mirrors the microservice's SSE
/// `data:` payload (stage + fraction + optional frame counters).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotoProgress {
    pub stage: String,
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames_done: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames_total: Option<u32>,
}

/// What `rotoscope_video` hands back: where the PNG sequence landed and how many
/// frames it contains.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotoscopeResult {
    pub output_dir: String,
    pub frame_count: u32,
}

// ---------------------------------------------------------------------------
// Service responses (snake_case, matching the microservice's JSON)
// ---------------------------------------------------------------------------

/// Shape of GET /health. All fields optional so a partial/older service body
/// still parses (we only hard-require a 2xx to call it available).
#[derive(Deserialize)]
struct HealthBody {
    model: Option<String>,
    vram_used_gb: Option<f64>,
    vram_total_gb: Option<f64>,
    gpu_profile: Option<GpuProfileBody>,
}

/// Deserialize side of the GPU profile -- matches the service's snake_case
/// `gpu_profile` object. Mapped into the camelCase `GpuProfile` for the frontend.
/// All fields optional so a partial/older body still parses.
#[derive(Deserialize)]
struct GpuProfileBody {
    name: Option<String>,
    generation: Option<String>,
    compute_capability: Option<Vec<i64>>,
    vram_gb: Option<f64>,
    dtype_str: Option<String>,
}

/// Map the service's snake_case profile body into the camelCase frontend payload.
/// Returns None if the essential labels (name + generation) are absent, so a
/// stub/partial object doesn't surface as a half-empty profile.
fn map_gpu_profile(b: GpuProfileBody) -> Option<GpuProfile> {
    Some(GpuProfile {
        name: b.name?,
        generation: b.generation?,
        compute_capability: b.compute_capability.unwrap_or_default(),
        vram_gb: b.vram_gb.unwrap_or(0.0),
        dtype_str: b.dtype_str.unwrap_or_default(),
    })
}

/// One SSE `data:` JSON object from /rotoscope/{job_id}/progress.
#[derive(Deserialize)]
struct SseTick {
    stage: String,
    #[serde(default)]
    progress: f64,
    frames_done: Option<u32>,
    frames_total: Option<u32>,
    /// Probed source-video fps; the service sets it on the job at POST time, so
    /// it rides every snapshot. Carried into meta.json so playback uses the real
    /// rate. Optional: an older service body omits it.
    source_fps: Option<f64>,
}

/// meta.json written alongside the extracted PNG sequence. Exactly the shape the
/// proposal specifies.
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct RotoMeta<'a> {
    source: String,
    frame_skip: u32,
    points: &'a [RotoPoint],
    model: String,
    generated_at: String,
    frame_count: u32,
    /// Probed source-video fps, captured from the progress stream. Omitted when
    /// the service didn't report one; the read-side (roto_media.rs) then falls
    /// back to the 30fps playback estimate.
    #[serde(skip_serializing_if = "Option::is_none")]
    source_fps: Option<f64>,
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// {documentDir}/ClaudeMotion/projects/<slug>. MUST match the hand-duplicated
/// derivation in projects.rs / export.rs / ig_pipeline.rs / claude_bridge.rs /
/// zip.rs -- moving it requires changing all of them or this reads a different
/// folder than the project store.
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

/// Resolve the ffmpeg binary: prefer the bundled one from the render toolchain
/// (the app must NOT assume ffmpeg is on PATH -- see CLAUDE.md). Falls back to a
/// bare `ffmpeg` only as a dev convenience when the toolchain isn't installed
/// (mirrors ig_pipeline's dev fallback); in a packaged app the toolchain is the
/// only source.
fn resolve_ffmpeg(app: &AppHandle) -> PathBuf {
    if let Ok(bundled) = render_toolchain::ffmpeg_bin(app) {
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from("ffmpeg")
}

/// A short locally-unique id without pulling in a uuid crate: nanos-since-epoch
/// plus a process-lifetime atomic counter, so two ids minted in the same
/// nanosecond still differ. Used only for scratch-clip filenames and the
/// multipart boundary -- the rotoscope JOB identity is the client-supplied
/// `job_id` threaded in from the frontend (so cancel-by-id reaches the real job).
fn next_local_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("job_{nanos}_{n}")
}

/// ISO8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`) without a date crate. Converts
/// unix seconds to a civil date via Howard Hinnant's days->y/m/d algorithm.
fn iso8601_utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hour, min, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // days since 1970-01-01 -> civil (year, month, day), UTC.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if month <= 2 { year + 1 } else { year };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

/// Map a 0..100 quality percentage to an x264 CRF. Anchored on the proposal's
/// "80% -> CRF 23"; higher quality -> lower CRF. Clamped to the valid CRF range.
fn quality_to_crf(quality: u32) -> u32 {
    // 23 at quality 80, sloping ~0.3 CRF per quality point, then clamped.
    let q = quality as f64;
    let crf = 23.0 + (80.0 - q) * 0.3;
    crf.round().clamp(0.0, 51.0) as u32
}

// ---------------------------------------------------------------------------
// check_rotoscoping_service
// ---------------------------------------------------------------------------

fn check_blocking(host: &str) -> RotoscopingStatus {
    let unavailable = RotoscopingStatus {
        available: false,
        model: None,
        vram_used_gb: None,
        vram_total_gb: None,
        gpu_profile: None,
    };
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return unavailable,
    };
    let url = format!("http://{host}:{PORT}/health");
    let resp = match client.get(&url).send() {
        Ok(r) if r.status().is_success() => r,
        _ => return unavailable,
    };
    // A 2xx alone means available; the body just enriches it. (reqwest's `json`
    // helper needs the `json` feature, which isn't enabled, so parse the text.)
    let body = resp
        .text()
        .ok()
        .and_then(|t| serde_json::from_str::<HealthBody>(&t).ok());
    match body {
        Some(body) => RotoscopingStatus {
            available: true,
            model: body.model,
            vram_used_gb: body.vram_used_gb,
            vram_total_gb: body.vram_total_gb,
            gpu_profile: body.gpu_profile.and_then(map_gpu_profile),
        },
        None => RotoscopingStatus {
            available: true,
            model: None,
            vram_used_gb: None,
            vram_total_gb: None,
            gpu_profile: None,
        },
    }
}

/// Probe the microservice. Never errors -- an unreachable service is a normal
/// state that hides the workspace, not a failure to surface.
#[tauri::command]
pub async fn check_rotoscoping_service(host: String) -> RotoscopingStatus {
    tauri::async_runtime::spawn_blocking(move || check_blocking(&host))
        .await
        .unwrap_or(RotoscopingStatus {
            available: false,
            model: None,
            vram_used_gb: None,
            vram_total_gb: None,
            gpu_profile: None,
        })
}

/// Best-effort model lookup for meta.json (so the recorded model matches the
/// loaded one). Falls back to the default name on any failure.
fn fetch_model(host: &str) -> String {
    check_blocking(host).model.unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

// ---------------------------------------------------------------------------
// SSE progress stream
// ---------------------------------------------------------------------------

/// Terminal outcome of the progress stream: the final stage plus the probed
/// source fps observed along the way (the service stamps it on the job at POST
/// time, so it appears in the very first snapshot). `source_fps` is `None` only
/// if the service never reported one.
struct StreamOutcome {
    stage: String,
    source_fps: Option<f64>,
}

/// Open the SSE progress stream, forward each tick as `roto://progress`, and
/// block until a terminal stage arrives -- returning that stage (`"done"`,
/// `"error"`, or `"cancelled"`) plus the last-seen source fps so the caller can
/// branch and record it in meta.json. The job may not be registered server-side
/// the instant we connect (the POST that creates it can race this), so a
/// dropped/failed connection is retried with a short backoff rather than treated
/// as the end. The POST has already succeeded by the time we get here, so the
/// service was up a moment ago; we still cap consecutive connect failures so a
/// service that dies mid-job can't hang the job forever -- exceeding the cap
/// surfaces as `"error"`.
fn run_progress_stream(app: &AppHandle, host: &str, job_id: &str) -> StreamOutcome {
    let url = format!("http://{host}:{PORT}/rotoscope/{job_id}/progress");
    // No read timeout: SSE is a long-lived stream that ticks intermittently.
    let client = match reqwest::blocking::Client::builder().build() {
        Ok(c) => c,
        Err(_) => {
            return StreamOutcome {
                stage: "error".to_string(),
                source_fps: None,
            }
        }
    };

    // ~60s of pure back-to-back connect failures (at the 250ms backoff) before we
    // give up and treat the job as errored.
    const MAX_CONNECT_FAILURES: u32 = 240;
    let mut connect_failures = 0u32;
    // Last source fps seen across all ticks; retained across reconnects.
    let mut source_fps: Option<f64> = None;

    loop {
        let resp = match client.get(&url).send() {
            Ok(r) if r.status().is_success() => r,
            _ => {
                connect_failures += 1;
                if connect_failures >= MAX_CONNECT_FAILURES {
                    return StreamOutcome {
                        stage: "error".to_string(),
                        source_fps,
                    };
                }
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }
        };
        connect_failures = 0;

        for line in BufReader::new(resp).lines().map_while(Result::ok) {
            let payload = match line.strip_prefix("data:") {
                Some(p) => p.trim(),
                None => continue,
            };
            if payload.is_empty() {
                continue;
            }
            if let Ok(tick) = serde_json::from_str::<SseTick>(payload) {
                if tick.source_fps.is_some() {
                    source_fps = tick.source_fps;
                }
                let terminal = matches!(tick.stage.as_str(), "done" | "error" | "cancelled");
                let stage = tick.stage.clone();
                let _ = app.emit(
                    "roto://progress",
                    RotoProgress {
                        stage: tick.stage,
                        progress: tick.progress,
                        frames_done: tick.frames_done,
                        frames_total: tick.frames_total,
                    },
                );
                if terminal {
                    return StreamOutcome { stage, source_fps };
                }
            }
        }
        // Stream ended without a terminal tick; reconnect and resume.
        std::thread::sleep(Duration::from_millis(250));
    }
}

// ---------------------------------------------------------------------------
// ffmpeg clip
// ---------------------------------------------------------------------------

/// Clip the source video from `start_frame` to the end into `dest`. The
/// microservice treats frame 0 of what it receives as the reference frame, so the
/// clip is frame-accurate: we drop everything before `start_frame` with the
/// `select` filter (which forces a re-encode) and write x264. When `compress` is
/// off we still re-encode (a stream copy can't cut at an arbitrary, non-keyframe
/// boundary) but at a near-lossless CRF so quality is preserved; when on, the CRF
/// comes from the user's quality setting.
fn clip_video(
    ffmpeg: &Path,
    source: &str,
    dest: &Path,
    start_frame: u32,
    compress: bool,
    quality: u32,
) -> Result<(), String> {
    let crf = if compress { quality_to_crf(quality) } else { 18 };
    let crf_s = crf.to_string();
    let select = format!("select=gte(n\\,{start_frame})");
    let dest_s = dest.to_string_lossy().to_string();

    let output = std::process::Command::new(ffmpeg)
        .args([
            "-y",
            "-i",
            source,
            "-vf",
            &select,
            "-vsync",
            "0",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            if compress { "fast" } else { "veryfast" },
            "-crf",
            &crf_s,
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
        return Err(format!("ffmpeg clip failed: {msg}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Hand-built multipart POST /rotoscope
// ---------------------------------------------------------------------------

/// Assemble a multipart/form-data body by hand (the `multipart` reqwest feature
/// is not enabled). Returns the body bytes and the boundary to set in the
/// Content-Type header.
fn build_multipart(
    video: &[u8],
    points_json: &str,
    frame_skip: u32,
    job_id: &str,
) -> (Vec<u8>, String) {
    let boundary = format!("----claudemotion{}", next_local_id());
    let mut body = Vec::with_capacity(video.len() + 512);

    let mut field = |name: &str, value: &str| {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    };
    field("points", points_json);
    field("frame_skip", &frame_skip.to_string());
    field("job_id", job_id);

    // The binary video part.
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"video\"; filename=\"clip.mp4\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: video/mp4\r\n\r\n");
    body.extend_from_slice(video);
    body.extend_from_slice(b"\r\n");

    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (body, boundary)
}

// ---------------------------------------------------------------------------
// rotoscope_video
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn rotoscope_video(
    app: AppHandle,
    slug: String,
    host: String,
    source_path: String,
    job_id: String,
    start_frame: u32,
    points: Vec<RotoPoint>,
    frame_skip: u32,
    compress: bool,
    quality: u32,
) -> Result<RotoscopeResult, String> {
    let project = project_dir(&app, &slug)?;
    tauri::async_runtime::spawn_blocking(move || {
        rotoscope_blocking(
            app,
            project,
            host,
            source_path,
            job_id,
            start_frame,
            points,
            frame_skip,
            compress,
            quality,
        )
    })
    .await
    .map_err(|e| format!("rotoscope task failed: {e}"))?
}

#[allow(clippy::too_many_arguments)]
fn rotoscope_blocking(
    app: AppHandle,
    project: PathBuf,
    host: String,
    source_path: String,
    job_id: String,
    start_frame: u32,
    points: Vec<RotoPoint>,
    frame_skip: u32,
    compress: bool,
    quality: u32,
) -> Result<RotoscopeResult, String> {
    // 1. Clip the source to a temp file with the bundled ffmpeg. `clip_id` names
    //    only the scratch file; the JOB identity is the client-supplied `job_id`.
    let ffmpeg = resolve_ffmpeg(&app);
    let clip_id = next_local_id();
    let clip_path = std::env::temp_dir().join(format!("claudemotion_roto_{clip_id}.mp4"));
    clip_video(&ffmpeg, &source_path, &clip_path, start_frame, compress, quality)?;

    // 2. Read the clip, build the multipart body, and POST it. The async service
    //    validates + registers the job under `job_id`, then returns 202 IMMEDIATELY
    //    (it no longer streams the ZIP back -- that is fetched from /result below).
    let post_result = (|| -> Result<(), String> {
        let video = std::fs::read(&clip_path)
            .map_err(|e| format!("failed to read clipped video: {e}"))?;
        let points_json = serde_json::to_string(&points)
            .map_err(|e| format!("failed to serialize points: {e}"))?;
        let (body, boundary) = build_multipart(&video, &points_json, frame_skip, &job_id);

        let client = reqwest::blocking::Client::builder()
            .build()
            .map_err(|e| format!("http client init failed: {e}"))?;
        let resp = client
            .post(format!("http://{host}:{PORT}/rotoscope"))
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .send()
            .map_err(|e| format!("rotoscope request failed: {e}"))?;
        if !resp.status().is_success() {
            let code = resp.status();
            let msg = resp.text().unwrap_or_default();
            return Err(format!("rotoscope service returned {code}: {msg}"));
        }
        // 202 Accepted: the body is just {"job_id": ...}; nothing to read.
        Ok(())
    })();

    // The clip is now on the service side; drop our scratch copy either way.
    let _ = std::fs::remove_file(&clip_path);
    post_result?;

    // 3. Drive progress + wait for completion on the SSE stream. It forwards each
    //    tick as `roto://progress` and returns the terminal stage.
    let outcome = run_progress_stream(&app, &host, &job_id);
    match outcome.stage.as_str() {
        "done" => {}
        "cancelled" => return Err("rotoscope job was cancelled".to_string()),
        other => return Err(format!("rotoscope job failed (stage: {other})")),
    }

    // 4. Fetch the result ZIP. SSE `done` and result-readiness can race slightly,
    //    so retry briefly on 425/409 before giving up.
    let zip_bytes = fetch_result_zip(&host, &job_id)?;

    // 5. Unpack the PNG sequence (plus the composed output.webm + archived
    //    source_clip.mp4, when present) into <project>/assets/rotoscope_<stem>/.
    let stem = Path::new(&source_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip".to_string());
    let output_dir = project.join("assets").join(format!("rotoscope_{stem}"));
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("failed to create output dir: {e}"))?;

    let frame_count = unzip_output(&zip_bytes, &output_dir)?;

    // 6. Write meta.json (source is referenced in place, never copied).
    let meta = RotoMeta {
        source: source_path.clone(),
        frame_skip,
        points: &points,
        model: fetch_model(&host),
        generated_at: iso8601_utc_now(),
        frame_count,
        source_fps: outcome.source_fps,
    };
    let meta_json = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("failed to serialize meta.json: {e}"))?;
    std::fs::write(output_dir.join("meta.json"), meta_json)
        .map_err(|e| format!("failed to write meta.json: {e}"))?;

    Ok(RotoscopeResult {
        output_dir: output_dir.to_string_lossy().to_string(),
        frame_count,
    })
}

/// GET /rotoscope/{job_id}/result and read the ZIP bytes. The SSE `done` tick and
/// the result becoming readable can race slightly, so retry on `425` (job not
/// finished) and `409` (transient cancelled/conflict window) with a short sleep
/// before giving up. Any other non-2xx is surfaced with the service's body.
fn fetch_result_zip(host: &str, job_id: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let url = format!("http://{host}:{PORT}/rotoscope/{job_id}/result");

    const MAX_ATTEMPTS: u32 = 10;
    for attempt in 0..MAX_ATTEMPTS {
        let resp = client
            .get(&url)
            .send()
            .map_err(|e| format!("result request failed: {e}"))?;
        let status = resp.status();
        if status.is_success() {
            return resp
                .bytes()
                .map(|b| b.to_vec())
                .map_err(|e| format!("failed to read rotoscope result: {e}"));
        }
        let retryable =
            status == reqwest::StatusCode::TOO_EARLY || status == reqwest::StatusCode::CONFLICT;
        if retryable && attempt + 1 < MAX_ATTEMPTS {
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }
        let msg = resp.text().unwrap_or_default();
        return Err(format!("rotoscope result fetch returned {status}: {msg}"));
    }
    Err("rotoscope result never became ready".to_string())
}

/// Extract the rotoscope output ZIP into `dest` (flattened to each entry's base
/// name) and return the PNG frame count.
///
/// The server folds three kinds of artifact into the one `result.zip` (a single
/// fetch, because /result reaps the work_dir right after serving it): the
/// `frame_*.png` sequence plus, best-effort, the composed `output.webm` and the
/// archived `source_clip.mp4`. We extract the PNGs and those two named videos;
/// any other entry is ignored. `frame_count` counts ONLY PNGs, so the returned
/// value (and RotoMeta.frame_count) is unchanged by the extra artifacts.
fn unzip_output(zip_bytes: &[u8], dest: &Path) -> Result<u32, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|e| format!("failed to open rotoscope ZIP: {e}"))?;
    let mut count = 0u32;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("failed to read ZIP entry: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        // Flatten: take just the file name.
        let name = match entry.enclosed_name().and_then(|p| p.file_name().map(|f| f.to_owned())) {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        let lower = name.to_ascii_lowercase();
        let is_png = lower.ends_with(".png");
        // Keep PNG frames plus the two named extras; ignore anything else.
        if !is_png && name != "output.webm" && name != "source_clip.mp4" {
            continue;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("failed to read ZIP entry bytes: {e}"))?;
        let mut out = std::fs::File::create(dest.join(&name))
            .map_err(|e| format!("failed to create output file: {e}"))?;
        out.write_all(&buf)
            .map_err(|e| format!("failed to write output file: {e}"))?;
        // frame_count reflects the PNG sequence only.
        if is_png {
            count += 1;
        }
    }
    Ok(count)
}

// ---------------------------------------------------------------------------
// cancel_rotoscope
// ---------------------------------------------------------------------------

fn cancel_blocking(host: &str, job_id: &str) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    client
        .delete(format!("http://{host}:{PORT}/rotoscope/{job_id}"))
        .send()
        .map_err(|e| format!("cancel request failed: {e}"))?;
    Ok(())
}

/// Cancel an in-flight rotoscope job (DELETE /rotoscope/{job_id}).
#[tauri::command]
pub async fn cancel_rotoscope(host: String, job_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cancel_blocking(&host, &job_id))
        .await
        .map_err(|e| format!("cancel task failed: {e}"))?
}
