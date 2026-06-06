/**
 * Tuning constants for the pipeline.
 *
 * These are NOT frozen literals. The spike's thresholds (delta < 8, sharpness
 * < 50) were measured on a single reel (17 -> 11 kept) and will need tuning on
 * more samples, so every value is overridable at runtime via an environment
 * variable. Stage modules import the resolved values from here and never inline
 * a magic number.
 *
 * Resolution order for each constant:
 *   1. the matching env var (`IG_*`), if set and parseable
 *   2. the built-in default below
 *
 * `resolveConstants()` lets a caller (e.g. a stage CLI or a test) override any
 * subset programmatically without touching the environment.
 */

export interface PipelineConstants {
  /** Frame sampling rate for extraction, in frames per second. */
  FPS: number;
  /** Width (px) frames are scaled to; height preserves aspect ratio. */
  SCALE_WIDTH: number;
  /** Hard cap on the analyzed clip length, in seconds. */
  CLIP_SECONDS: number;
  /** Reject a frame whose mean pixel delta from the previous frame is below this (static hold). */
  DELTA_REJECT_THRESHOLD: number;
  /** Reject a frame whose Laplacian-variance sharpness is below this (blurry / mid-transition). */
  SHARPNESS_FLOOR: number;
  /** Keep at most this many frames after filtering (top-N by combined score) -- caps analysis cost. */
  MAX_KEPT_FRAMES: number;
  /** Model id used for the `claude -p` motion-language analysis. */
  ANALYSIS_MODEL: string;
}

/** Built-in defaults, from the spike + proposal. */
export const DEFAULT_CONSTANTS: Readonly<PipelineConstants> = Object.freeze({
  FPS: 2,
  SCALE_WIDTH: 960,
  CLIP_SECONDS: 30,
  DELTA_REJECT_THRESHOLD: 8,
  SHARPNESS_FLOOR: 50,
  MAX_KEPT_FRAMES: 30,
  ANALYSIS_MODEL: "claude-sonnet-4-6",
});

/** Env var name for each numeric/string constant. */
const ENV_KEYS: Record<keyof PipelineConstants, string> = {
  FPS: "IG_FPS",
  SCALE_WIDTH: "IG_SCALE_WIDTH",
  CLIP_SECONDS: "IG_CLIP_SECONDS",
  DELTA_REJECT_THRESHOLD: "IG_DELTA_REJECT_THRESHOLD",
  SHARPNESS_FLOOR: "IG_SHARPNESS_FLOOR",
  MAX_KEPT_FRAMES: "IG_MAX_KEPT_FRAMES",
  ANALYSIS_MODEL: "IG_ANALYSIS_MODEL",
};

function parseNumericEnv(name: string, raw: string, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Invalid value for ${name}: ${JSON.stringify(raw)} is not a finite number (default ${fallback}).`,
    );
  }
  return parsed;
}

/**
 * Resolve the effective constants: defaults, overlaid with any `IG_*` env vars,
 * overlaid with any explicit `overrides`. Pass `env` to resolve against a
 * specific environment (defaults to `process.env`); pass `overrides` to force
 * specific values (used by tests and stage CLIs that take flags).
 */
export function resolveConstants(
  overrides: Partial<PipelineConstants> = {},
  env: Record<string, string | undefined> = process.env,
): PipelineConstants {
  const resolved: PipelineConstants = { ...DEFAULT_CONSTANTS };

  for (const key of Object.keys(DEFAULT_CONSTANTS) as (keyof PipelineConstants)[]) {
    const raw = env[ENV_KEYS[key]];
    if (raw === undefined || raw === "") continue;
    if (key === "ANALYSIS_MODEL") {
      resolved.ANALYSIS_MODEL = raw;
    } else {
      resolved[key] = parseNumericEnv(ENV_KEYS[key], raw, DEFAULT_CONSTANTS[key]);
    }
  }

  return { ...resolved, ...overrides };
}

/** The constants resolved once at import time against the ambient environment. */
export const CONSTANTS: PipelineConstants = resolveConstants();
