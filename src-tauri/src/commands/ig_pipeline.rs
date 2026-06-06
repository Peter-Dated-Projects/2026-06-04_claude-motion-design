//! Instagram-reel -> motion-language pipeline: the Tauri backend engine.
//!
//! Drives the frozen Bun pipeline stages (scripts/ig-pipeline/*.ts) as
//! subprocesses and streams their results to the frontend as Tauri events,
//! implementing the two-phase flow that gates the one paid `claude` analysis call
//! behind user review of the kept frames.
//!
//!   Phase A (free):  download -> clip -> frames -> score
//!   [user reviews / overrides the kept set in the UI]
//!   Phase B (~$0.21): analyze -> store
//!
//! The two phases are two separate commands so the UI can pause between them.
//!
//! ## Commands (registered in lib.rs by T-026, NOT here)
//!   - `ig_extract_phase_a(slug, input)  -> PhaseAResult`  + emits ig://score
//!   - `ig_extract_phase_b(slug, input)  -> BriefResult`   + emits ig://brief
//!   Both stream `ig://stage-progress` (StageProgress) as stages advance.
//!
//! ## Event channels (stable; mirrored by the frontend in src/types/ig.ts, T-023)
//!   - `ig://stage-progress`  StageProgress  (per stage tick)
//!   - `ig://score`           ScoreResult    (after Phase A scoring)
//!   - `ig://brief`           BriefResult    (after Phase B store)
//!
//! ## Schema casing
//! Every payload struct is `#[serde(rename_all = "camelCase")]` because the Bun
//! contract (and its frontend mirror src/types/ig.ts) is camelCase. A snake_case
//! payload would fail to deserialize on the frontend without a remap layer.
//!
//! ## delta: null vs omitted (load-bearing decision)
//! `ScoredFrame.delta` is `Option<f64>` serialized AS `null` (NO
//! skip_serializing_if), because the contract is `delta: number | null` (null on
//! the first frame, which has no predecessor) and score.ts emits the key present
//! with a null value. Omitting it would surface as `undefined` on the frontend,
//! which is drift from `number | null`. `rejectReason` IS skipped when None
//! (the contract key is optional and absent when a frame is kept).
//!
//! ## Where stages run / who owns the extraction layout
//! lib/paths.ts owns the `<out>/extractions/<YYYY-MM-DD>_<id>/` layout and frame
//! naming; this module never re-derives it. Phase A runs clip/frames/score into a
//! throwaway `<out>/.ig-work/<id>/` working dir; Phase B's `store` stage resolves
//! the real extraction folder itself and reconciles (moves) all media into it,
//! after which the working dir is removed. (download.ts, for a URL, already writes
//! source.mp4 into the real folder; store's reconcile is a no-op for that file.)

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, Command, Stdio};
use std::thread::JoinHandle;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::render_toolchain;

// ---------------------------------------------------------------------------
// Canonical event / stage payload schema (mirrors scripts/ig-pipeline/types.ts)
// ---------------------------------------------------------------------------

/// The named pipeline stages, in execution order. Serializes lowercase
/// (`download|clip|frames|score|analyze|store`) to match `StageName` in types.ts.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StageName {
    Download,
    Clip,
    Frames,
    Score,
    Analyze,
    Store,
}

impl StageName {
    /// Map a `STAGE <name> ...` line's name back to the enum (download stage only
    /// emits these; unknown names are ignored).
    fn from_name(name: &str) -> Option<StageName> {
        match name {
            "download" => Some(StageName::Download),
            "clip" => Some(StageName::Clip),
            "frames" => Some(StageName::Frames),
            "score" => Some(StageName::Score),
            "analyze" => Some(StageName::Analyze),
            "store" => Some(StageName::Store),
            _ => None,
        }
    }
}

/// A structured progress tick, emitted on `ig://stage-progress`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageProgress {
    pub stage: StageName,
    /// Completion fraction in [0, 1].
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Why a candidate frame was excluded from the kept set. Serializes to the exact
/// `RejectReason` union strings in types.ts.
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    LowSharpness,
    InsufficientChange,
}

/// Per-frame score breakdown plus the keep/reject decision.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoredFrame {
    pub path: String,
    /// 1-based index within the candidate set.
    pub index: u32,
    pub sharpness: f64,
    /// Mean pixel delta vs the previous frame. `null` for the first frame (no
    /// predecessor) -- serialized as null, never omitted, never coerced to 0.
    pub delta: Option<f64>,
    pub entropy: f64,
    pub score: f64,
    pub kept: bool,
    /// Present only when `kept` is false: why it was rejected. Absent (not null)
    /// when kept, and absent for a survivor ranked outside the top-N (which is
    /// the absence of a reason, not a distinct value).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reject_reason: Option<RejectReason>,
}

/// Output of the score+filter stage (the `ig://score` payload).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreResult {
    /// Every candidate frame, scored, in capture order (accepted + rejected).
    pub scored: Vec<ScoredFrame>,
    /// Surviving frames, ranked best-first (the scorer's recommended analyze set).
    pub kept: Vec<ScoredFrame>,
}

/// The motion-language brief. Shape is load-bearing -- it is exactly what
/// analyze.ts produces and store.ts renders.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionLanguage {
    pub energy: String,
    pub rhythm: String,
    pub pacing: String,
    pub transitions: String,
    pub signature: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub motion_language: MotionLanguage,
    pub motion_theme: String,
    pub color_mood: String,
    pub typography_motion: String,
    pub application_guide: String,
}

/// Output of the analyze stage (the brief + cost/latency telemetry).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResult {
    pub brief: Brief,
    pub cost_usd: f64,
    pub duration_ms: f64,
    pub num_turns: f64,
    pub model: String,
}

/// Output of the download stage.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub source_path: String,
    /// Short source id (reel/video id, or a path-derived id for a local file);
    /// names the extraction folder.
    pub id: String,
    /// URL the video was fetched from; null when the input was a local file.
    pub source_url: Option<String>,
    pub duration_seconds: f64,
    pub used_cookie_fallback: bool,
}

/// Output of the probe+clip stage.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipResult {
    pub clip_path: String,
    pub original_duration_seconds: f64,
    pub clipped_duration_seconds: f64,
    pub was_clipped: bool,
}

/// Output of the frame-extraction stage. Parsed but not forwarded as its own
/// event (its `framePaths` flow into the ScoreResult the frontend renders).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSet {
    pub clip_path: String,
    pub frame_paths: Vec<String>,
    pub fps: f64,
    pub width: f64,
}

// ---------------------------------------------------------------------------
// Command inputs / outputs
// ---------------------------------------------------------------------------

/// Phase A result handed back to the frontend. Carries the upstream stage results
/// the frontend must thread back into Phase B (download/clip/scoreResult), since
/// the `store` stage needs all of them to compose the extraction folder.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseAResult {
    pub download: DownloadResult,
    pub clip: ClipResult,
    pub score_result: ScoreResult,
}

/// Phase B input: the Phase A results round-tripped from the frontend, plus the
/// (possibly user-overridden) list of kept-frame paths to analyze.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseBInput {
    pub download: DownloadResult,
    pub clip: ClipResult,
    pub score_result: ScoreResult,
    /// Absolute frame paths the user chose to analyze (the override threads in
    /// here directly). Empty is rejected -- Phase A's zero-kept event should have
    /// blocked the UI before this is callable.
    pub kept_frame_paths: Vec<String>,
}

/// Phase B result + the `ig://brief` payload: the brief, flattened, plus the
/// extraction folder path.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefResult {
    #[serde(flatten)]
    pub brief: Brief,
    /// Absolute path to the finalized `<out>/extractions/<date>_<id>/` folder.
    pub extraction_dir: String,
}

/// The four-key blob `store.ts --results` consumes. Borrowed so we can serialize
/// the Phase B results without cloning them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionResults<'a> {
    download: &'a DownloadResult,
    clip: &'a ClipResult,
    score_result: &'a ScoreResult,
    analyze: &'a AnalyzeResult,
}

/// What `store.ts` prints on stdout (one JSON line) in real-store mode.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreOutput {
    dir: String,
    #[allow(dead_code)]
    brief_json: String,
    #[allow(dead_code)]
    extraction_md: String,
}

// ---------------------------------------------------------------------------
// Runner resolution (bun + the stage scripts + the bundled-binary PATH)
// ---------------------------------------------------------------------------

/// Where to find `bun` and the stage scripts, and how to expose the other CLIs
/// (`yt-dlp`/`ffmpeg`/`ffprobe`/`claude`) to the child.
struct IgRunner {
    /// The `bun` executable (absolute in the toolchain; bare "bun" off PATH in dev).
    bun: PathBuf,
    /// Directory holding download.ts/clip.ts/... (the stage scripts).
    script_dir: PathBuf,
    /// Working directory for the child (the script dir, so node_modules resolves).
    cwd: PathBuf,
    /// Bin dir to PREPEND to the child's PATH so the stages' bare-name binaries
    /// (yt-dlp/ffmpeg/ffprobe/claude) resolve to the bundled ones. None in dev:
    /// inherit the ambient PATH where the dev machine has them installed.
    extra_path: Option<PathBuf>,
}

/// Resolve the IG runner, preferring the installed toolchain over the dev repo.
///
/// 1. Installed toolchain: bun + the four IG CLIs are present AND the stage
///    scripts are bundled at `<toolchain>/ig-pipeline/`. (Script bundling is a
///    later toolchain-build step; until then this arm is skipped and we fall
///    through to the dev repo.)
/// 2. DEV FALLBACK: the repo's own `scripts/ig-pipeline/` + a `bun` on PATH.
///
/// Neither -> `Err(TOOLCHAIN_MISSING)` so the frontend can show the install
/// affordance instead of an error toast (mirrors export_mp4's sentinel).
fn resolve_ig_runner(app: &AppHandle) -> Result<IgRunner, String> {
    if render_toolchain::ig_tools_installed(app) {
        let bin = render_toolchain::toolchain_bin_dir(app)?;
        let bun = render_toolchain::bun_bin(app)?;
        if let Some(toolchain) = bin.parent() {
            let script_dir = toolchain.join("ig-pipeline");
            if script_dir.join("run.ts").is_file() {
                return Ok(IgRunner {
                    bun,
                    cwd: script_dir.clone(),
                    script_dir,
                    extra_path: Some(bin),
                });
            }
        }
        // Tools present but scripts not bundled yet: fall through to the dev repo.
    }

    if let Some(script_dir) = dev_script_dir() {
        return Ok(IgRunner {
            bun: PathBuf::from("bun"),
            cwd: script_dir.clone(),
            script_dir,
            extra_path: None,
        });
    }

    Err(render_toolchain::TOOLCHAIN_MISSING.to_string())
}

/// DEV FALLBACK script dir: the repo's `scripts/ig-pipeline/`, located via
/// CARGO_MANIFEST_DIR (src-tauri) -> its parent (repo root). Never present in a
/// packaged app (the manifest dir won't point at a checkout).
fn dev_script_dir() -> Option<PathBuf> {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let dir = repo_root.join("scripts").join("ig-pipeline");
    if dir.join("run.ts").is_file() {
        Some(dir)
    } else {
        None
    }
}

/// {documentDir}/ClaudeMotion/projects/<slug> is the per-project root that holds
/// `extractions/`. MUST match projects.rs / export.rs / claude_bridge.rs / zip.rs
/// -- the path derivation is hand-duplicated across all of them, so a move has to
/// be applied everywhere or this reads a different folder than the project store.
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

/// Throwaway working dir for Phase A's clip/frames/score, keyed by source id.
///
/// It MUST live UNDER `extractions/` (here: `extractions/_work/<id>/`) rather than
/// a project-root sibling, because the frame grid renders these live candidate
/// frames via `convertFileSrc`, and the Tauri asset-protocol scope only allows
/// `.../projects/**/extractions/**`. A sibling dir (e.g. `<project>/.ig-work/`)
/// is OUTSIDE that scope, so the webview would 404 every thumbnail during review.
///
/// The name is `_work`, NOT `.work`: on unix the asset scope defaults
/// `require_literal_leading_dot = true` (tauri scope/fs.rs), so a `**` wildcard
/// will not match a leading-dot path segment -- a dot-prefixed work dir would
/// still be blocked. The `_work` dir is skipped by ig_list_extractions (it has no
/// extraction.md). Phase B's store moves the media into `extractions/<date>_<id>/`
/// (reading absolute paths from the results blob, so it does not care where work
/// lives) and then this dir is removed.
fn ig_work_dir(out_root: &Path, id: &str) -> PathBuf {
    out_root.join("extractions").join("_work").join(id)
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

/// stderr signature the Bun spawn wrapper prints for a missing binary
/// (`Required binary "X" was not found on PATH ...`, and the analyze stage's
/// `The \`claude\` CLI was not found on PATH.`). A stage that fails this way is a
/// missing-tool problem, not a content failure -> surface TOOLCHAIN_MISSING.
const NOT_FOUND_SIGNATURE: &str = "not found on PATH";

/// Build a `bun <script>` Command with cwd + the bundled-binary PATH wired up.
/// Callers add the script's argv and stdio config.
fn stage_command(runner: &IgRunner, script: &str) -> Command {
    let mut cmd = Command::new(&runner.bun);
    cmd.arg(runner.script_dir.join(script));
    cmd.current_dir(&runner.cwd);
    if let Some(extra) = &runner.extra_path {
        if let Some(path) = prepend_path(extra) {
            cmd.env("PATH", path);
        }
    }
    cmd
}

/// Build a PATH value with `dir` prepended to the inherited PATH.
fn prepend_path(dir: &Path) -> Option<std::ffi::OsString> {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![dir.to_path_buf()];
    paths.extend(std::env::split_paths(&current));
    std::env::join_paths(paths).ok()
}

/// Drain a child's stderr on its own thread so a chatty stage (ffmpeg) can't fill
/// the pipe buffer and deadlock while we read stdout.
fn drain_stderr(stream: Option<ChildStderr>) -> JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut s) = stream {
            let _ = s.read_to_string(&mut buf);
        }
        buf
    })
}

/// Map a spawn failure to an error: a missing `bun` is a missing-tool problem.
fn spawn_failure(stage: &str, err: std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        render_toolchain::TOOLCHAIN_MISSING.to_string()
    } else {
        format!("{stage} stage: failed to launch bun: {err}")
    }
}

/// Turn a non-zero stage exit into an error: a missing-binary signature becomes
/// TOOLCHAIN_MISSING; anything else is a stage-named failure carrying the stderr
/// tail (the stage's own actionable message).
fn finalize_stage_error(stage: &str, stderr: &str, code: Option<i32>) -> String {
    if stderr.contains(NOT_FOUND_SIGNATURE) {
        return render_toolchain::TOOLCHAIN_MISSING.to_string();
    }
    let tail: Vec<&str> = stderr.lines().rev().take(8).collect();
    let msg: String = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
    if msg.trim().is_empty() {
        match code {
            Some(c) => format!("{stage} stage failed (exit {c})."),
            None => format!("{stage} stage failed."),
        }
    } else {
        format!("{stage} stage failed: {msg}")
    }
}

/// Parse a stage's JSON stdout into a typed result.
fn parse_json<T: DeserializeOwned>(stage: &str, raw: &str) -> Result<T, String> {
    serde_json::from_str(raw.trim())
        .map_err(|e| format!("{stage} stage: could not parse JSON output: {e}"))
}

/// Run a non-streaming stage to completion and return its stdout. clip/frames/
/// score/analyze print exactly their JSON result on stdout (diagnostics go to
/// stderr), so the whole stdout is the parseable payload.
fn run_capture(runner: &IgRunner, stage: &str, script: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = stage_command(runner, script);
    cmd.args(args);
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| spawn_failure(stage, e))?;

    let stderr_handle = drain_stderr(child.stderr.take());
    let mut stdout = String::new();
    if let Some(mut out) = child.stdout.take() {
        out.read_to_string(&mut stdout)
            .map_err(|e| format!("{stage} stage: failed to read output: {e}"))?;
    }
    let status = child
        .wait()
        .map_err(|e| format!("{stage} stage: process error: {e}"))?;
    let stderr_text = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        return Err(finalize_stage_error(stage, &stderr_text, status.code()));
    }
    Ok(stdout)
}

/// Parse a `STAGE <name> <0..1> [message]` progress line into a StageProgress.
fn parse_stage_line(rest: &str) -> Option<StageProgress> {
    let mut parts = rest.splitn(3, ' ');
    let stage = StageName::from_name(parts.next()?)?;
    let progress: f64 = parts.next()?.trim().parse().ok()?;
    let message = parts
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some(StageProgress {
        stage,
        progress,
        message,
    })
}

fn emit_progress(app: &AppHandle, progress: StageProgress) {
    let _ = app.emit("ig://stage-progress", progress);
}

/// Run the download stage, forwarding its `STAGE` progress lines as
/// `ig://stage-progress` events and parsing the LAST non-`STAGE ` line (its final
/// single-line DownloadResult JSON -- download is the only stage that interleaves
/// progress lines with its result).
fn run_download(
    app: &AppHandle,
    runner: &IgRunner,
    input: &str,
    out_root: &str,
) -> Result<DownloadResult, String> {
    let mut cmd = stage_command(runner, "download.ts");
    cmd.args([input, out_root]);
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| spawn_failure("download", e))?;

    let stderr_handle = drain_stderr(child.stderr.take());
    let mut last_json: Option<String> = None;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("STAGE ") {
                if let Some(progress) = parse_stage_line(rest) {
                    emit_progress(app, progress);
                }
            } else if !line.trim().is_empty() {
                last_json = Some(line);
            }
        }
    }
    let status = child
        .wait()
        .map_err(|e| format!("download stage: process error: {e}"))?;
    let stderr_text = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        return Err(finalize_stage_error("download", &stderr_text, status.code()));
    }
    let json = last_json
        .ok_or_else(|| "download stage: produced no result JSON on stdout".to_string())?;
    parse_json("download", &json)
}

/// Run the store stage, piping the four-key ExtractionResults blob to its stdin
/// (`--results -`) and parsing the resolved extraction folder it prints.
fn run_store(
    runner: &IgRunner,
    out_root: &str,
    source_id: &str,
    payload: &str,
) -> Result<StoreOutput, String> {
    let mut cmd = stage_command(runner, "store.ts");
    cmd.args(["--results", "-", "--out", out_root, "--id", source_id]);
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| spawn_failure("store", e))?;

    // Write the (small, <64KB) results blob then close stdin so store can proceed.
    // store reads stdin to EOF before writing stdout, so write-then-read is safe.
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| format!("store stage: failed to write results to stdin: {e}"))?;
    }

    let stderr_handle = drain_stderr(child.stderr.take());
    let mut stdout = String::new();
    if let Some(mut out) = child.stdout.take() {
        out.read_to_string(&mut stdout)
            .map_err(|e| format!("store stage: failed to read output: {e}"))?;
    }
    let status = child
        .wait()
        .map_err(|e| format!("store stage: process error: {e}"))?;
    let stderr_text = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        return Err(finalize_stage_error("store", &stderr_text, status.code()));
    }
    parse_json("store", &stdout)
}

// ---------------------------------------------------------------------------
// Phase A: download -> clip -> frames -> score (NEVER analyze)
// ---------------------------------------------------------------------------

/// Run Phase A: ingest the reel/file, clip + sample frames, and score them.
/// Emits a per-stage `ig://stage-progress` event and, after scoring, an
/// `ig://score` event with the full ScoreResult. Does NOT run analyze -- the
/// paid call is gated behind the user reviewing/overriding the kept set and then
/// invoking Phase B. Zero kept frames is a normal result (empty `kept`), surfaced
/// in the score event so the UI can block analyze rather than spend on nothing.
#[tauri::command]
pub async fn ig_extract_phase_a(
    app: AppHandle,
    slug: String,
    input: String,
) -> Result<PhaseAResult, String> {
    let out_root = project_dir(&app, &slug)?;
    let runner = resolve_ig_runner(&app)?;
    tauri::async_runtime::spawn_blocking(move || phase_a_blocking(app, runner, input, out_root))
        .await
        .map_err(|e| format!("ig phase A task failed: {e}"))?
}

fn phase_a_blocking(
    app: AppHandle,
    runner: IgRunner,
    input: String,
    out_root: PathBuf,
) -> Result<PhaseAResult, String> {
    let out_root_s = out_root.to_string_lossy().to_string();

    // download (self-reports its own granular STAGE progress).
    let download = run_download(&app, &runner, &input, &out_root_s)?;

    // Throwaway working dir for clip/frames/score; store finalizes into the real
    // extraction folder in Phase B. Keyed by the source id download assigned.
    // Lives under extractions/.work so its live frames are within the asset-
    // protocol scope (see ig_work_dir).
    let work = ig_work_dir(&out_root, &download.id);
    std::fs::create_dir_all(&work)
        .map_err(|e| format!("failed to create ig working dir: {e}"))?;
    let work_s = work.to_string_lossy().to_string();

    // clip (no progress lines -> synthetic 0/1 bookends).
    emit_progress(&app, StageProgress { stage: StageName::Clip, progress: 0.0, message: None });
    let clip: ClipResult = parse_json(
        "clip",
        &run_capture(&runner, "clip", "clip.ts", &[&download.source_path, &work_s])?,
    )?;
    emit_progress(&app, StageProgress { stage: StageName::Clip, progress: 1.0, message: None });

    // frames.
    emit_progress(&app, StageProgress { stage: StageName::Frames, progress: 0.0, message: None });
    let _frame_set: FrameSet = parse_json(
        "frames",
        &run_capture(&runner, "frames", "frames.ts", &[&clip.clip_path, &work_s])?,
    )?;
    emit_progress(&app, StageProgress { stage: StageName::Frames, progress: 1.0, message: None });

    // score (frames dir + --json -> a single ScoreResult line).
    emit_progress(&app, StageProgress { stage: StageName::Score, progress: 0.0, message: None });
    let frames_dir = work.join("frames").to_string_lossy().to_string();
    let score_result: ScoreResult = parse_json(
        "score",
        &run_capture(&runner, "score", "score.ts", &[&frames_dir, "--json"])?,
    )?;
    emit_progress(&app, StageProgress { stage: StageName::Score, progress: 1.0, message: None });

    // Post-score event with the full ScoreResult (kept may be empty -- that is a
    // valid result the UI uses to block the paid analyze call).
    let _ = app.emit("ig://score", &score_result);

    Ok(PhaseAResult {
        download,
        clip,
        score_result,
    })
}

// ---------------------------------------------------------------------------
// Phase B: analyze -> store (the one paid call + persistence)
// ---------------------------------------------------------------------------

/// Run Phase B over an explicitly-passed kept-frame list (the user's possibly-
/// overridden selection): analyze the frames into a Brief, then store the full
/// extraction folder. Emits `ig://stage-progress` for analyze + store and a final
/// `ig://brief` with the brief + extraction dir.
#[tauri::command]
pub async fn ig_extract_phase_b(
    app: AppHandle,
    slug: String,
    input: PhaseBInput,
) -> Result<BriefResult, String> {
    if input.kept_frame_paths.is_empty() {
        return Err("no frames selected to analyze; keep at least one frame.".to_string());
    }
    let out_root = project_dir(&app, &slug)?;
    let runner = resolve_ig_runner(&app)?;
    tauri::async_runtime::spawn_blocking(move || phase_b_blocking(app, runner, input, out_root))
        .await
        .map_err(|e| format!("ig phase B task failed: {e}"))?
}

fn phase_b_blocking(
    app: AppHandle,
    runner: IgRunner,
    input: PhaseBInput,
    out_root: PathBuf,
) -> Result<BriefResult, String> {
    let out_root_s = out_root.to_string_lossy().to_string();
    let PhaseBInput {
        download,
        clip,
        score_result,
        kept_frame_paths,
    } = input;

    // analyze (positional frame paths -> AnalyzeResult; no progress lines).
    emit_progress(&app, StageProgress { stage: StageName::Analyze, progress: 0.0, message: None });
    let frame_args: Vec<&str> = kept_frame_paths.iter().map(String::as_str).collect();
    let analyze: AnalyzeResult = parse_json(
        "analyze",
        &run_capture(&runner, "analyze", "analyze.ts", &frame_args)?,
    )?;
    emit_progress(&app, StageProgress { stage: StageName::Analyze, progress: 1.0, message: None });

    // store: compose the extraction folder from all four stage results, fed via stdin.
    emit_progress(&app, StageProgress { stage: StageName::Store, progress: 0.0, message: None });
    let results = ExtractionResults {
        download: &download,
        clip: &clip,
        score_result: &score_result,
        analyze: &analyze,
    };
    let payload = serde_json::to_string(&results)
        .map_err(|e| format!("store stage: failed to serialize results: {e}"))?;
    let store_out = run_store(&runner, &out_root_s, &download.id, &payload)?;
    emit_progress(&app, StageProgress { stage: StageName::Store, progress: 1.0, message: None });

    // The working dir's media has been reconciled into the extraction folder; drop it.
    let _ = std::fs::remove_dir_all(ig_work_dir(&out_root, &download.id));

    let brief_result = BriefResult {
        brief: analyze.brief,
        extraction_dir: store_out.dir,
    };
    let _ = app.emit("ig://brief", &brief_result);
    Ok(brief_result)
}

// ---------------------------------------------------------------------------
// List past extractions (sidebar)
// ---------------------------------------------------------------------------

/// One row in the IG sidebar's past-extractions list. Mirrors the frontend
/// `IGExtractionListItem` (src/types/ig.ts) -- camelCase across the boundary.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionListItem {
    /// Source short id (the `<id>` segment of the `<date>_<id>` folder name).
    pub id: String,
    /// Extraction date, `YYYY-MM-DD` (the folder name's leading segment).
    pub date: String,
    /// Source URL, or null for a local-file extraction.
    pub source_url: Option<String>,
    /// Absolute path to a representative frame (first on disk), or null.
    pub thumbnail_path: Option<String>,
    /// Absolute path to the extraction folder.
    pub dir: String,
}

/// Pull the `source:` value out of an `extraction.md` YAML frontmatter block.
/// store.ts writes it as a JSON-double-quoted scalar (or the bare `null` keyword),
/// so unescape via serde_json when quoted; `null`/absent -> None.
fn parse_source_url(md: &str) -> Option<String> {
    for line in md.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("source:") {
            let value = rest.trim();
            if value.is_empty() || value == "null" {
                return None;
            }
            // store.ts double-quotes via JSON.stringify; round-trip to unescape.
            if let Ok(s) = serde_json::from_str::<String>(value) {
                return Some(s);
            }
            return Some(value.trim_matches('"').to_string());
        }
    }
    None
}

/// First `frame_*.jpg` in `frames_dir` by filename order, as an absolute path.
fn first_frame_path(frames_dir: &Path) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(frames_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with("frame_") && n.ends_with(".jpg"))
        .collect();
    names.sort();
    names
        .into_iter()
        .next()
        .map(|n| frames_dir.join(n).to_string_lossy().to_string())
}

/// List a project's past extractions for the sidebar: enumerate
/// `<project>/extractions/`, and for each `<YYYY-MM-DD>_<id>` folder holding an
/// `extraction.md`, parse the source URL and pick a thumbnail. Folders without an
/// `extraction.md` (e.g. the `.work` scratch dir, or an interrupted Phase A) are
/// skipped, so a half-finished run never shows up as a complete extraction.
#[tauri::command]
pub fn ig_list_extractions(app: AppHandle, slug: String) -> Result<Vec<ExtractionListItem>, String> {
    let extractions_dir = project_dir(&app, &slug)?.join("extractions");
    if !extractions_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut items = Vec::new();
    for entry in std::fs::read_dir(&extractions_dir)
        .map_err(|e| format!("failed to read extractions dir: {e}"))?
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
        // Skip dotfiles (the .work scratch dir) and anything not a real extraction.
        if name.starts_with('.') {
            continue;
        }
        let md_path = dir.join("extraction.md");
        if !md_path.is_file() {
            continue;
        }
        // Folder name is `<YYYY-MM-DD>_<id>`; the date segment has no underscore,
        // so split on the FIRST underscore (an id may itself contain underscores).
        let (date, id) = match name.split_once('_') {
            Some((d, i)) if !d.is_empty() && !i.is_empty() => (d.to_string(), i.to_string()),
            _ => continue,
        };
        let source_url = std::fs::read_to_string(&md_path)
            .ok()
            .and_then(|md| parse_source_url(&md));
        let thumbnail_path = first_frame_path(&dir.join("frames"));

        items.push(ExtractionListItem {
            id,
            date,
            source_url,
            thumbnail_path,
            dir: dir.to_string_lossy().to_string(),
        });
    }

    Ok(items)
}
