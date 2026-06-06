/**
 * Score + filter stage: the pipeline's quality gate.
 *
 * Takes the candidate frames (in capture order) and decides which are worth
 * spending the paid, multi-turn analyze budget on. Three metrics per frame:
 *
 *   - sharpness: variance of the Laplacian over the grayscale image. Rejects
 *     motion-blurred and mid-transition frames (a blurry frame has a flat,
 *     low-variance Laplacian response).
 *   - delta: mean absolute grayscale difference vs the PREVIOUS frame. Rejects
 *     static holds / near-duplicates where nothing changed in the 0.5s gap.
 *   - entropy: Shannon entropy of the RGB color histogram. Low for solid-color
 *     flashes, higher for full content. Feeds the ranking (solid flashes are
 *     already caught by the sharpness floor, so there is no separate entropy
 *     floor -- and `types.ts` has no entropy reject reason).
 *
 * Filter order matches the proposal: drop low-delta first (the first frame is
 * exempt -- no predecessor), then drop low-sharpness, then rank the survivors by
 * the combined score and keep the top MAX_KEPT_FRAMES.
 *
 * All math is plain TypeScript over `sharp` raw buffers -- no OpenCV (no Python
 * 3.14 wheels, and unnecessary). Each frame is decoded exactly once: one raw RGB
 * read, from which the grayscale buffer (sharpness + delta) is derived and the
 * RGB histogram (entropy) is built.
 *
 * NOTE on reject reasons / the kept set: the frozen `RejectReason` in `types.ts`
 * has exactly two values -- "insufficient_change" (low delta) and "low_sharpness".
 * Frames that pass BOTH filters but rank outside the top MAX_KEPT_FRAMES are not
 * kept, but they were not rejected for quality: they come back with `kept: false`
 * and NO `rejectReason`. (The ticket prose called this a third "below-top-N"
 * reject reason, but that value does not exist in the frozen contract, so it is
 * represented as the absence of a reason. See the KB gotcha
 * `score-reject-reason-vs-below-top-n`.)
 */
import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { CONSTANTS, type PipelineConstants } from "./lib/constants.ts";
import type { RejectReason, ScoredFrame, ScoreResult } from "./types.ts";

// --- Local tuning constants -------------------------------------------------
// The *thresholds* a future operator would tune on more reels (DELTA_REJECT_THRESHOLD,
// SHARPNESS_FLOOR, MAX_KEPT_FRAMES) live in lib/constants.ts and are env-overridable.
// The values below are structural choices fixed by the proposal/the metric math,
// not per-reel tuning knobs, so they are named consts here rather than magic
// numbers. They are overridable per-call via `ScoreOptions` for testing.

/** Combined-score weight on (normalized) sharpness. From the proposal: 0.7 / 0.3. */
const DEFAULT_SHARPNESS_WEIGHT = 0.7;
/** Combined-score weight on normalized entropy. */
const DEFAULT_ENTROPY_WEIGHT = 0.3;
/** Levels per channel in the joint RGB histogram (8 -> 8x8x8 = 512 bins). */
const HISTOGRAM_LEVELS = 8;
/** Below this many survivors, the clip is likely too short / too fast-cut to analyze well. */
const DEFAULT_MIN_SURVIVORS = 5;

/** Joint 3D histogram bin count: HISTOGRAM_LEVELS per channel, cubed. */
const HISTOGRAM_BINS = HISTOGRAM_LEVELS * HISTOGRAM_LEVELS * HISTOGRAM_LEVELS; // 512
/** Max possible entropy of the joint histogram, used to normalize entropy into [0, 1]. */
const MAX_ENTROPY = Math.log2(HISTOGRAM_BINS); // 9 bits for 512 bins

/** Rec.601 luma weights (sum to 1) -- grayscale conversion for sharpness + delta. */
const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

/**
 * 3x3 Laplacian kernel:  [[0, 1, 0], [1, -4, 1], [0, 1, 0]]
 * Sharpness is the VARIANCE of this convolved response (not its mean).
 * Border policy: the 1px image border is SKIPPED (only interior pixels where the
 * full 3x3 neighborhood exists are convolved). This keeps the value reproducible
 * across runs/platforms without an arbitrary edge-padding choice.
 */

/** Per-call overrides; all default to the module/constants values. */
export interface ScoreOptions {
  /** Resolved pipeline constants (thresholds). Defaults to the ambient `CONSTANTS`. */
  constants?: PipelineConstants;
  /** Combined-score weight on normalized sharpness. */
  sharpnessWeight?: number;
  /** Combined-score weight on normalized entropy. */
  entropyWeight?: number;
  /** Warn when fewer than this many frames survive the filters. */
  minSurvivors?: number;
  /** Sink for the non-fatal "too few survivors" warning. Defaults to `console.error` (stderr). */
  onWarn?: (message: string) => void;
}

/** A frame decoded once into the buffers both metric families need. */
export interface DecodedFrame {
  width: number;
  height: number;
  /** Per-pixel Rec.601 luminance, length width*height. */
  gray: Float64Array;
  /** Raw interleaved RGB bytes (alpha stripped), length width*height*3. */
  rgb: Uint8Array;
}

/**
 * Decode one frame to the grayscale + RGB buffers the metrics need (single read).
 * Handles 1- (already gray), 3- (RGB), and 4-channel (RGBA) raw output.
 */
export async function decodeFrame(path: string): Promise<DecodedFrame> {
  const { data, info } = await sharp(path)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const pixels = width * height;
  const gray = new Float64Array(pixels);
  const rgb = new Uint8Array(pixels * 3);

  for (let p = 0; p < pixels; p++) {
    const src = p * channels;
    let r: number;
    let g: number;
    let b: number;
    // Non-null assertions below: `src` is always in bounds (p < pixels, channels
    // matches the buffer stride), so these reads never return undefined. The `!`
    // is a type-level claim only -- `?? 0` would silently corrupt a pixel value.
    if (channels === 1) {
      r = g = b = data[src]!;
    } else {
      r = data[src]!;
      g = data[src + 1]!;
      b = data[src + 2]!;
    }
    gray[p] = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    const dst = p * 3;
    rgb[dst] = r;
    rgb[dst + 1] = g;
    rgb[dst + 2] = b;
  }

  return { width, height, gray, rgb };
}

/**
 * Sharpness = variance of the 3x3 Laplacian over interior pixels (border skipped).
 * Returns 0 when the image is too small to have any interior pixel.
 */
export function computeSharpness(
  gray: Float64Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const c = y * width + x;
      // [[0,1,0],[1,-4,1],[0,1,0]] over the 4-neighborhood. Interior-only loop
      // bounds guarantee every neighbor index is valid (hence the `!`).
      const response =
        gray[c - width]! + gray[c + width]! + gray[c - 1]! + gray[c + 1]! - 4 * gray[c]!;
      sum += response;
      sumSq += response * response;
      count++;
    }
  }

  const mean = sum / count;
  return sumSq / count - mean * mean; // variance = E[x^2] - E[x]^2
}

/**
 * Delta = mean absolute per-pixel grayscale difference between two frames.
 * Both grayscale buffers must be the same length (same frame dimensions).
 */
export function computeDelta(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `computeDelta: frame size mismatch (${a.length} vs ${b.length}); frames must share dimensions.`,
    );
  }
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!); // i < length -> in bounds
  return total / a.length;
}

/**
 * Shannon entropy (log2, in bits) of the JOINT HISTOGRAM_LEVELS^3 RGB histogram --
 * a single 3D histogram of HISTOGRAM_BINS bins (matching the proposal's
 * `cv2.calcHist([0,1,2], [8,8,8])`), NOT three per-channel histograms summed.
 * Each channel value 0..255 maps to a level via integer division by (256/levels).
 */
export function computeEntropy(rgb: Uint8Array): number {
  const levels = HISTOGRAM_LEVELS;
  const step = 256 / levels; // 32 for 8 levels
  const hist = new Float64Array(HISTOGRAM_BINS);
  const pixels = rgb.length / 3;

  for (let p = 0; p < pixels; p++) {
    const src = p * 3;
    const rb = Math.min(levels - 1, Math.floor(rgb[src]! / step));
    const gb = Math.min(levels - 1, Math.floor(rgb[src + 1]! / step));
    const bb = Math.min(levels - 1, Math.floor(rgb[src + 2]! / step));
    const bin = (rb * levels + gb) * levels + bb;
    hist[bin] = hist[bin]! + 1; // bin in [0, HISTOGRAM_BINS) -> always defined
  }

  let entropy = 0;
  for (let i = 0; i < hist.length; i++) {
    const count = hist[i]!;
    if (count === 0) continue;
    const prob = count / pixels;
    entropy -= prob * Math.log2(prob);
  }
  return entropy;
}

/** Normalize raw entropy (bits) into [0, 1] by dividing by the max possible entropy. */
export function normalizeEntropy(entropy: number): number {
  return entropy / MAX_ENTROPY;
}

/**
 * Score and filter a list of frame paths (in capture order).
 * Decodes each frame once, computes sharpness/delta/entropy, applies the
 * delta-then-sharpness filters, ranks survivors by the combined score, and keeps
 * the top MAX_KEPT_FRAMES. Emits a non-fatal warning when too few frames survive.
 */
export async function scoreFrames(
  framePaths: string[],
  options: ScoreOptions = {},
): Promise<ScoreResult> {
  const constants = options.constants ?? CONSTANTS;
  const sharpnessWeight = options.sharpnessWeight ?? DEFAULT_SHARPNESS_WEIGHT;
  const entropyWeight = options.entropyWeight ?? DEFAULT_ENTROPY_WEIGHT;
  const minSurvivors = options.minSurvivors ?? DEFAULT_MIN_SURVIVORS;
  const warn = options.onWarn ?? ((m: string) => console.error(m));

  const scored: ScoredFrame[] = [];
  let prevGray: Float64Array | null = null;

  for (const [i, path] of framePaths.entries()) {
    const { width, height, gray, rgb } = await decodeFrame(path);

    const sharpness = computeSharpness(gray, width, height);
    const delta = prevGray === null ? null : computeDelta(prevGray, gray);
    const entropy = computeEntropy(rgb);
    const score =
      sharpnessWeight * sharpness + entropyWeight * normalizeEntropy(entropy);

    // Filter: delta first (first frame exempt), then sharpness.
    let rejectReason: RejectReason | undefined;
    if (delta !== null && delta < constants.DELTA_REJECT_THRESHOLD) {
      rejectReason = "insufficient_change";
    } else if (sharpness < constants.SHARPNESS_FLOOR) {
      rejectReason = "low_sharpness";
    }

    scored.push({
      path,
      index: i + 1, // 1-based
      sharpness,
      delta,
      entropy,
      score,
      kept: false, // finalized after ranking below
      ...(rejectReason ? { rejectReason } : {}),
    });

    prevGray = gray;
  }

  // Survivors = frames with no filter reject reason. Rank best-first, keep top N.
  const survivors = scored.filter((f) => f.rejectReason === undefined);
  survivors.sort((a, b) => b.score - a.score);

  if (survivors.length < minSurvivors) {
    warn(
      `[score] only ${survivors.length} frame(s) survived filtering (< ${minSurvivors}); ` +
        `this video may be too short or too fast-cut for reliable analysis.`,
    );
  }

  const kept = survivors.slice(0, constants.MAX_KEPT_FRAMES);
  for (const f of kept) f.kept = true; // mutates the same objects held in `scored`

  return { scored, kept };
}

// ---------------------------------------------------------------------------
// CLI: bun run score.ts <frames-dir | frame paths...>
// ---------------------------------------------------------------------------

/** Image extensions the directory mode picks up, sorted for stable frame order. */
const FRAME_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

/**
 * Resolve CLI args to a sorted frame path list: a single directory expands to its
 * sorted image files; otherwise the args are treated as explicit frame paths
 * (kept in the given order).
 */
async function resolveFrameArgs(args: string[]): Promise<string[]> {
  if (args.length === 1) {
    const only = resolve(args[0]!); // length === 1 -> args[0] is defined
    let entries: string[] | null = null;
    try {
      entries = await readdir(only);
    } catch {
      entries = null; // not a directory -> fall through to explicit-path handling
    }
    if (entries) {
      return entries
        .filter((name) =>
          FRAME_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)),
        )
        .sort()
        .map((name) => join(only, name));
    }
  }
  return args.map((a) => (isAbsolute(a) ? a : resolve(a)));
}

function formatTable(result: ScoreResult): string {
  const header = ["#", "sharpness", "delta", "entropy", "score", "kept", "reason", "path"];
  const rows = result.scored.map((f) => [
    String(f.index),
    f.sharpness.toFixed(1),
    f.delta === null ? "-" : f.delta.toFixed(2),
    f.entropy.toFixed(3),
    f.score.toFixed(1),
    f.kept ? "yes" : "no",
    f.rejectReason ?? (f.kept ? "" : "below-top-N"),
    f.path,
  ]);
  const widths = header.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join("  ");
  return [fmt(header), ...rows.map(fmt)].join("\n");
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: bun run score.ts <frames-dir | frame paths...>");
    process.exit(1);
  }
  const framePaths = await resolveFrameArgs(args);
  if (framePaths.length === 0) {
    console.error("score: no frames found to score.");
    process.exit(1);
  }
  const result = await scoreFrames(framePaths);
  console.log(formatTable(result));
  console.log(
    `\n${result.kept.length} kept / ${result.scored.length} scored (ranked best-first).`,
  );
}
