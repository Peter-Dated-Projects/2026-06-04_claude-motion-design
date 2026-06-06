/**
 * Frontend view of the Instagram-reel -> motion-language pipeline contract.
 *
 * These types MIRROR two upstream sources and must track them when either changes:
 *
 *   1. The Bun stage I/O contract in `scripts/ig-pipeline/types.ts` (the frozen
 *      Wave 1 contract: ScoredFrame / ScoreResult / Brief / StageProgress /
 *      DownloadResult / ClipResult / AnalyzeResult).
 *   2. The Tauri event payload schema emitted by the Rust IG backend module
 *      (`src-tauri/src/commands/ig_pipeline.rs`, ticket T-025) — the per-stage
 *      progress events and per-frame score records the frontend `listen()`s for.
 *
 * They are re-declared here (not imported) because `scripts/ig-pipeline/` is a
 * separate Bun project outside this app's tsconfig. Keep the field names and
 * shapes IDENTICAL to the Bun source so the JSON crosses the Rust/JS boundary
 * without a remap.
 *
 * BOUNDARY CASING: the Bun contract is camelCase, so the Rust serde structs in
 * T-025 must serialize camelCase (`#[serde(rename_all = "camelCase")]`) for these
 * payloads to deserialize as-is. If T-025 lands emitting snake_case, that is a
 * drift bug to FIX on the Rust side — do NOT widen these types to absorb it.
 *
 * Do NOT widen `RejectReason` to `string` and do NOT use `any`: the literal union
 * is load-bearing for the reject-overlay UI, and `any` would hide boundary drift
 * the type system should catch.
 */

// ---------------------------------------------------------------------------
// download.ts / clip.ts results
// ---------------------------------------------------------------------------

/** Output of the download stage: a local video file fetched from a URL. */
export interface DownloadResult {
  /** Absolute path to the downloaded source video on disk. */
  sourcePath: string;
  /** Short source identifier (e.g. the reel/video id), names the extraction folder. */
  id: string;
  /** URL the video was fetched from. `null` when the input was a local file. */
  sourceUrl: string | null;
  /** Source duration in seconds, as probed before clipping. */
  durationSeconds: number;
  /** True when the `--cookies-from-browser` fallback was used to fetch it. */
  usedCookieFallback: boolean;
}

/** Output of the probe+clip stage: the <=30s working copy later stages operate on. */
export interface ClipResult {
  /** Absolute path to the clipped (or copied) working video. */
  clipPath: string;
  /** Duration of the original source in seconds. */
  originalDurationSeconds: number;
  /** Duration of the produced clip in seconds (<= the 30s cap). */
  clippedDurationSeconds: number;
  /** True when the source exceeded the cap and was actually trimmed (not a copy). */
  wasClipped: boolean;
}

// ---------------------------------------------------------------------------
// score.ts
// ---------------------------------------------------------------------------

/**
 * Why a candidate frame was excluded from the kept set. String-literal union on
 * purpose — the frame-grid tooltip switches on these exact values.
 */
export type RejectReason =
  | "low_sharpness" // Laplacian variance below the sharpness floor (blurry / mid-transition).
  | "insufficient_change"; // mean pixel delta below threshold (static hold / near-duplicate).

/** Per-frame score breakdown plus the keep/reject decision. */
export interface ScoredFrame {
  /** Absolute path to the scored frame. */
  path: string;
  /** 1-based index of this frame within the candidate set. */
  index: number;
  /** Variance of the Laplacian over the grayscale image. Higher = crisper. */
  sharpness: number;
  /**
   * Mean absolute pixel delta vs. the previous frame. `null` for the first frame
   * (no predecessor). UI logic must NOT assume a number or coerce null to 0.
   */
  delta: number | null;
  /** RGB-histogram (color) entropy: low for solid-color flashes, higher for content. */
  entropy: number;
  /** Combined ranking score (sharpness + entropy weighting); orders the kept set. */
  score: number;
  /** Whether this frame survived all filters and is part of the scorer's kept set. */
  kept: boolean;
  /** Present only when `kept` is false: why it was rejected. */
  rejectReason?: RejectReason;
}

/** Output of the score+filter stage. */
export interface ScoreResult {
  /** Every candidate frame, scored, in original capture order (accepted + rejected). */
  scored: ScoredFrame[];
  /** Surviving frames, ranked best-first by combined score (the ones fed to analyze). */
  kept: ScoredFrame[];
}

// ---------------------------------------------------------------------------
// analyze.ts
// ---------------------------------------------------------------------------

/**
 * The motion-language brief. Shape is load-bearing: it is exactly what analyze.ts
 * parses out of the `claude -p` JSON envelope and what store.ts renders into
 * `extraction.md`. Keep identical to the Bun source.
 */
export interface Brief {
  motionLanguage: {
    /** Overall kinetic quality (e.g. "punchy and immediate"). */
    energy: string;
    /** How the piece pulses through time (e.g. "burst-and-hold"). */
    rhythm: string;
    /** Fast cuts / held frames / slow reveals / mixed, and the feeling it creates. */
    pacing: string;
    /** How scenes/elements move between states (cut, dissolve, wipe, zoom, push, ...). */
    transitions: string;
    /** The single motion idea that makes this feel like itself. */
    signature: string;
  };
  /** One sentence: the emotional and kinetic identity of the piece. */
  motionTheme: string;
  /** The feeling the color palette creates -- not the colors themselves. */
  colorMood: string;
  /** How text moves if present, or "absent". */
  typographyMotion: string;
  /** 2-3 sentences bridging extraction to generation. */
  applicationGuide: string;
}

/** Output of the analyze stage: the brief plus cost/latency telemetry. */
export interface AnalyzeResult {
  /** The parsed motion-language brief. */
  brief: Brief;
  /** USD cost reported by the `claude` CLI for this extraction. */
  costUsd: number;
  /** Wall-clock duration of the CLI call in milliseconds. */
  durationMs: number;
  /** Number of agent turns the CLI used. */
  numTurns: number;
  /** Model id used for the analysis (e.g. "claude-sonnet-4-6"). */
  model: string;
}

// ---------------------------------------------------------------------------
// Progress reporting (Tauri event payload)
// ---------------------------------------------------------------------------

/** The named pipeline stages, in execution order. */
export type StageName =
  | "download"
  | "clip"
  | "frames"
  | "score"
  | "analyze"
  | "store";

/**
 * A structured progress event. The Rust backend (T-025) emits one of these per
 * stage tick; the frontend renders the staged progress bar from it.
 */
export interface StageProgress {
  stage: StageName;
  /** Completion fraction in [0, 1]. */
  progress: number;
  /** Optional human-readable detail. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Frontend store types (not part of the Bun contract)
// ---------------------------------------------------------------------------

/**
 * The IG extraction state machine. Phase A (download -> clip -> frames -> score)
 * runs automatically and PAUSES at `awaiting-review` so the user can override the
 * keep/reject set before the paid Phase B (analyze -> store) call.
 */
export type IGPhase =
  | "idle"
  | "running-A"
  | "awaiting-review"
  | "running-B"
  | "done"
  | "error";

/**
 * A scored frame as held in the store: the scorer's verdict plus an optional
 * user override. `overrideKept` is distinct from the scorer's `kept` so a
 * re-rejected frame still carries its original `rejectReason` for the tooltip,
 * and a re-kept frame can be toggled back. `undefined` = defer to `kept`.
 */
export interface IGFrame extends ScoredFrame {
  /** User override of the keep decision; `undefined` means use the scorer's `kept`. */
  overrideKept?: boolean;
}

/** Input that kicks off Phase A: a remote reel URL or a dropped local file path. */
export type PhaseAInput = { url: string } | { filePath: string };

/**
 * Minimal sidebar row for a past extraction. The sidebar (T-029) renders these;
 * population is filled in by the integration ticket (T-031) reading the project's
 * `extractions/` dir.
 */
export interface IGExtractionListItem {
  /** Source id (matches the extraction folder's `<id>` segment). */
  id: string;
  /** Extraction date, `YYYY-MM-DD`. */
  date: string;
  /** Source URL, or `null` for a local-file extraction. */
  sourceUrl: string | null;
  /** Absolute path to a representative frame (first kept frame), or `null`. */
  thumbnailPath: string | null;
  /** Absolute path to the extraction folder (`<out>/extractions/<date>_<id>/`). */
  dir: string;
}
