/**
 * Stage I/O contract for the Instagram-reel -> motion-language pipeline.
 *
 * Every stage module imports from here. The chain is:
 *
 *   download.ts -> DownloadResult
 *   clip.ts     ( DownloadResult ) -> ClipResult
 *   frames.ts   ( ClipResult )     -> FrameSet
 *   score.ts    ( FrameSet )       -> ScoreResult
 *   analyze.ts  ( ScoreResult )    -> AnalyzeResult
 *   store.ts    ( all of the above ) -> writes the extraction folder
 *
 * These interfaces are frozen for Wave 1: a stage must be writable against the
 * type here without amending this file. If a stage needs a field that is not
 * here, that is a contract change and should be raised, not patched locally.
 *
 * NOTE: there is deliberately NO image-attach / `--image` field anywhere in this
 * surface. The `claude` CLI has no such flag; frames are analyzed by listing
 * their absolute paths in the prompt and letting the multimodal Read tool open
 * them (see analyze.ts and the KB gotcha `claude-cli-no-image-flag`).
 */

// ---------------------------------------------------------------------------
// download.ts
// ---------------------------------------------------------------------------

/** Output of the download stage: a local video file fetched from a URL. */
export interface DownloadResult {
  /** Absolute path to the downloaded source video on disk. */
  sourcePath: string;
  /** Short source identifier (e.g. the reel/video id), used to name the extraction folder. */
  id: string;
  /** The URL the video was fetched from. `null` when the input was a local file (no download). */
  sourceUrl: string | null;
  /** Source duration in seconds, as probed before clipping. */
  durationSeconds: number;
  /** True when the cookie fallback (`--cookies-from-browser`) was used to fetch it. */
  usedCookieFallback: boolean;
}

// ---------------------------------------------------------------------------
// clip.ts
// ---------------------------------------------------------------------------

/** Output of the probe+clip stage: the <=30s working copy all later stages operate on. */
export interface ClipResult {
  /** Absolute path to the clipped (or copied) working video. */
  clipPath: string;
  /** Duration of the original source in seconds. */
  originalDurationSeconds: number;
  /** Duration of the produced clip in seconds (<= CLIP_SECONDS). */
  clippedDurationSeconds: number;
  /** True when the source exceeded the cap and was actually trimmed (not a straight copy). */
  wasClipped: boolean;
}

// ---------------------------------------------------------------------------
// frames.ts
// ---------------------------------------------------------------------------

/** Output of the frame-extraction stage: the candidate JPEGs sampled from the clip. */
export interface FrameSet {
  /** Absolute path to the clip the frames were extracted from. */
  clipPath: string;
  /** Absolute frame paths in capture order (1-based index === array position + 1). */
  framePaths: string[];
  /** Sampling rate the frames were extracted at, in frames per second. */
  fps: number;
  /** Pixel width the frames were scaled to (height preserves aspect ratio). */
  width: number;
}

// ---------------------------------------------------------------------------
// score.ts
// ---------------------------------------------------------------------------

/** Why a candidate frame was excluded from the kept set. */
export type RejectReason =
  | "low_sharpness" // Laplacian variance below SHARPNESS_FLOOR (blurry / mid-transition).
  | "insufficient_change"; // mean pixel delta from previous frame below DELTA_REJECT_THRESHOLD (static hold / near-duplicate).

/** Per-frame score breakdown plus the keep/reject decision. */
export interface ScoredFrame {
  /** Absolute path to the scored frame. */
  path: string;
  /** 1-based index of this frame within the candidate set. */
  index: number;
  /** Sharpness: variance of the Laplacian over the grayscale image. Higher = crisper. */
  sharpness: number;
  /** Mean absolute pixel delta vs. the previous frame. `null` for the first frame (no predecessor). */
  delta: number | null;
  /** RGB-histogram (color) entropy: low for solid-color flashes, higher for full content. */
  entropy: number;
  /** Combined ranking score used to order the kept set (sharpness + entropy weighting). */
  score: number;
  /** Whether this frame survived all filters and is part of the kept set. */
  kept: boolean;
  /** Present only when `kept` is false: why it was rejected. */
  rejectReason?: RejectReason;
}

/** Output of the score+filter stage. */
export interface ScoreResult {
  /** Every candidate frame, scored, in original capture order (accepted + rejected). */
  scored: ScoredFrame[];
  /** The surviving frames, ranked best-first by combined score (the ones fed to analyze). */
  kept: ScoredFrame[];
}

// ---------------------------------------------------------------------------
// analyze.ts
// ---------------------------------------------------------------------------

/**
 * The motion-language brief. Shape is load-bearing: it is exactly what
 * analyze.ts parses out of the `claude -p` JSON envelope's `.result` field and
 * what store.ts renders into `extraction.md`. A drift here breaks both stages at
 * runtime, not at compile time, so keep it identical to the proposal's schema.
 */
export interface Brief {
  motionLanguage: {
    /** The overall kinetic quality (e.g. "punchy and immediate", "fluid and drifting"). */
    energy: string;
    /** How the piece pulses through time (e.g. "burst-and-hold", "steady metronomic"). */
    rhythm: string;
    /** Fast cuts / held frames / slow reveals / mixed, and how that creates feeling. */
    pacing: string;
    /** How scenes and elements move between states (cut, dissolve, wipe, zoom, push, ...). */
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
  /** 2-3 sentences bridging extraction to generation: how to apply this language to new content. */
  applicationGuide: string;
}

/** Output of the analyze stage: the brief plus the cost/latency telemetry of the CLI call. */
export interface AnalyzeResult {
  /** The parsed motion-language brief. */
  brief: Brief;
  /** USD cost reported by the `claude` CLI for this extraction. */
  costUsd: number;
  /** Wall-clock duration of the CLI call in milliseconds. */
  durationMs: number;
  /** Number of agent turns the CLI used (roughly one Read per analyzed frame). */
  numTurns: number;
  /** Model id used for the analysis (e.g. "claude-sonnet-4-6"). */
  model: string;
}

// ---------------------------------------------------------------------------
// store.ts -- output folder layout
// ---------------------------------------------------------------------------

/**
 * The resolved per-source output folder layout. Pinned so the store stage and
 * the frame stage share one naming source. Resolving an ExtractionPaths has NO
 * filesystem side effects -- creating the directories is the store stage's job
 * (see `ensureExtractionDirs` in lib/paths.ts).
 *
 *   <out>/extractions/<YYYY-MM-DD>_<sourceId>/
 *     source.mp4
 *     clip.mp4
 *     frames/
 *       frame_001.jpg   (1-based, zero-padded to 3 digits)
 *     brief.json
 *     extraction.md
 */
export interface ExtractionPaths {
  /** Absolute path to this extraction's folder (`<out>/extractions/<date>_<id>/`). */
  dir: string;
  /** Absolute path to the parent `extractions/` directory. */
  extractionsDir: string;
  /** Absolute path to `source.mp4`. */
  sourceMp4: string;
  /** Absolute path to `clip.mp4`. */
  clipMp4: string;
  /** Absolute path to the `frames/` subdirectory. */
  framesDir: string;
  /** Absolute path to `brief.json`. */
  briefJson: string;
  /** Absolute path to `extraction.md`. */
  extractionMd: string;
  /** Build the absolute path to a single frame by 1-based index: `frames/frame_NNN.jpg`. */
  framePath(index: number): string;
}

// ---------------------------------------------------------------------------
// Progress reporting
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
 * A structured progress event. Stages emit these to stdout as
 * `STAGE <name> <0..1>` lines (see `formatStageProgress`) so an eventual UI can
 * parse progress without a rewrite.
 */
export interface StageProgress {
  stage: StageName;
  /** Completion fraction in [0, 1]. */
  progress: number;
  /** Optional human-readable detail. */
  message?: string;
}

/** Format a StageProgress as the canonical stdout line: `STAGE <name> <0..1>`. */
export function formatStageProgress(p: StageProgress): string {
  const fraction = Math.min(1, Math.max(0, p.progress)).toFixed(3);
  const suffix = p.message ? ` ${p.message}` : "";
  return `STAGE ${p.stage} ${fraction}${suffix}`;
}
