/**
 * Frontend view of the rotoscoping-microservice contract.
 *
 * These types MIRROR the Tauri payload structs in the Rust rotoscoping bridge
 * (`src-tauri/src/commands/rotoscoping.rs`, ticket T-002) -- the structs that
 * cross the boundary into the webview. Every one of those is annotated
 * `#[serde(rename_all = "camelCase")]`, so the field names here are camelCase to
 * match exactly (same precedent as `src/types/ig.ts`). They are re-declared, not
 * imported, because the Rust side lives outside this app's tsconfig.
 *
 * If the backend ever lands snake_case on one of these payloads, that is a drift
 * bug to FIX on the Rust side -- do NOT widen these types to absorb it.
 */

// ---------------------------------------------------------------------------
// Payloads that cross from the Rust backend (camelCase)
// ---------------------------------------------------------------------------

/**
 * Foreground (1) vs. background-exclusion (0) classification for a prompt point.
 * String-literal-style numeric union on purpose: the distinction is load-bearing
 * for the point-overlay UI (green fg dot vs. red bg dot), so don't widen to
 * `number`. Backend serializes this as a `u8`; 0/1 is the only meaningful range.
 */
export type PointLabel = 0 | 1;

/**
 * A user-placed prompt point on the reference frame. Coordinates are in the
 * reference frame's pixel space. Round-trips unchanged into the `rotoscope_video`
 * command's `points` argument and into the backend's meta.json.
 * Mirrors `RotoPoint` in rotoscoping.rs.
 */
export interface RotoPoint {
  x: number;
  y: number;
  /** 1 = foreground (keep), 0 = background (exclude). */
  label: PointLabel;
}

/**
 * Result of the `check_rotoscoping_service` command. `available` is the only
 * field the UI needs to decide whether to show the workspace; the model/VRAM
 * fields are informational and absent when the service is unreachable.
 * Mirrors `RotoscopingStatus` in rotoscoping.rs.
 */
export interface RotoscopingStatus {
  available: boolean;
  model?: string;
  vramUsedGb?: number;
  vramTotalGb?: number;
  /** GPU probe from /health (name, generation, dtype, etc.), when reported. */
  gpuProfile?: GpuProfile;
}

/**
 * The service's startup GPU probe, surfaced through /health. All fields are
 * informational diagnostics. Mirrors `GpuProfile` in rotoscoping.rs (which maps
 * the service's snake_case `gpu_profile` body into this camelCase payload).
 */
export interface GpuProfile {
  /** Device name, e.g. "NVIDIA GeForce RTX 4090". */
  name: string;
  /** Detected generation: blackwell | hopper | ada | ampere | turing | legacy. */
  generation: string;
  /** Compute capability as [major, minor], e.g. [8, 9] for Ada. */
  computeCapability: number[];
  /** Total VRAM in GB. */
  vramGb: number;
  /** Autocast dtype label, e.g. "bfloat16". */
  dtypeStr: string;
}

/**
 * A progress tick emitted on the `roto://progress` event, one per SSE tick from
 * the microservice. `stage` is left as a free `string` to match the backend
 * struct's `String` field (the service may emit loading / segmenting / packaging
 * / done / error / cancelled, or future stages). Mirrors `RotoProgress`.
 */
export interface RotoProgress {
  stage: string;
  /** Completion fraction in [0, 1]. */
  progress: number;
  framesDone?: number;
  framesTotal?: number;
}

/**
 * What the `rotoscope_video` command hands back on completion: where the PNG
 * sequence landed and how many frames it contains. Mirrors `RotoscopeResult`.
 */
export interface RotoscopeResult {
  outputDir: string;
  frameCount: number;
}

// ---------------------------------------------------------------------------
// Frontend store types (not part of the backend contract)
// ---------------------------------------------------------------------------

/**
 * The rotoscoping job state machine.
 *   - idle       : no job running (point-placement / setup view).
 *   - uploading  : clip + upload in flight (before the service registers the job).
 *   - processing : the service is segmenting; `progress` drives the bar.
 *   - done       : the PNG sequence landed; result is in `outputs`.
 *   - error      : the run failed; `error` holds the message.
 */
export type RotoPhase = "idle" | "uploading" | "processing" | "done" | "error";

/**
 * A source video loaded into the preview pane. The source is referenced in place
 * -- never copied (per the proposal) -- so `path` is the user's original file.
 * `durationSeconds` / `fps` come from a one-time ffprobe and drive the output-
 * frame estimate next to the skip selector; they are optional until probed.
 */
export interface LoadedVideo {
  /** Absolute path to the source video on disk. */
  path: string;
  /** Probed duration in seconds, if known. */
  durationSeconds?: number;
  /** Probed source frame rate, if known. */
  fps?: number;
}

/**
 * Everything `useRotoJobQueue._processNext` needs to launch one rotoscope run via
 * `invoke("rotoscope_video", ...)`. Captured at enqueue time from the current
 * store state so a queued job is self-contained and does not depend on the live
 * store still describing it when the job finally runs.
 *
 * Clip bounds are kept RAW (source-relative seconds, or null for the whole
 * video), not pre-trimmed: the trim (`invoke("trim_video", ...)`) is performed
 * inside `_processNext` at run time. Eager trimming at enqueue time would block
 * the UI and spill temp files for jobs the user may cancel before they ever run.
 * `startFrame` is LEGACY and ignored at run time: the SAM2 reference frame is now
 * derived deterministically from `clipStart` (`round(clipStart*fps)`, else 0; see
 * useRotoJobQueue.runJob and decision roto-reference-frame-is-clip-frame-zero), so
 * `fps` is what carries that derivation. `host` is intentionally absent -- it is
 * read from localStorage inside `_processNext`, not captured here.
 */
export interface RotoscopeParams {
  slug: string;
  /** Original source file path (pre-trim). */
  sourcePath: string;
  /**
   * LEGACY scrub position; IGNORED at run time. The reference frame is derived
   * from `clipStart` (see this interface's doc + useRotoJobQueue.runJob). Still
   * captured by the not-yet-removed manual UI (RotoVideoPanel); T-010 drops it.
   */
  startFrame: number;
  /** Clip start in source-relative seconds, or null for the whole video. */
  clipStart: number | null;
  clipEnd: number | null;
  points: RotoPoint[];
  frameSkip: number;
  /** Legacy submit pair (see ReviewModal.qualityToSubmitParams). */
  compress: boolean;
  quality: number;
  /** Source fps, used to rebase `startFrame` after a trim. */
  fps: number;
}

/**
 * A completed rotoscope job in the outputs list, one per `rotoscope_<name>/`
 * folder under the project's assets. Named after the source file's stem.
 */
export interface RotoOutputListItem {
  /** Folder name, e.g. `rotoscope_clip` -- the displayed label. */
  name: string;
  /** Absolute path to the output folder under the project's assets. */
  dir: string;
  /** Number of PNG frames the sequence contains. */
  frameCount: number;
}
