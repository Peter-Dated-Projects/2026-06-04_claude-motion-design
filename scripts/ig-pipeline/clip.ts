/**
 * Stage 0 -- Probe + clip.
 *
 * Hard-caps any source to the first `CLIP_SECONDS` and reports its metadata
 * before any frame work, so every later stage operates on a bounded `clip.mp4`
 * and a user's footage is never silently dropped. This is the first consumer of
 * T-001's `ClipResult`, the `spawn` wrapper, and `CLIP_SECONDS`.
 *
 * Flow:
 *   1. ffprobe the source for duration / dimensions / frame rate.
 *   2. ffmpeg `-t CLIP_SECONDS -c copy` into `<outDir>/clip.mp4` (stream copy =
 *      instant; a sub-cap source just copies whole).
 *   3. ffprobe the produced clip for its TRUE duration (a `-c copy` cut lands on
 *      the nearest keyframe, so the clip can be a hair under/over the cap).
 *
 * Missing `ffmpeg`/`ffprobe` surface as a `SpawnError` of kind
 * `binary_not_found` from `run()`, naming the binary and distinct from a
 * present binary that exits non-zero.
 */

import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ClipResult } from "./types.ts";
import { CONSTANTS } from "./lib/constants.ts";
import { run } from "./lib/spawn.ts";

/**
 * Tolerance (seconds) when deciding whether a source actually exceeded the cap.
 * A source at / within a hair of `CLIP_SECONDS` must NOT be flagged
 * `wasClipped` -- container durations and keyframe boundaries jitter by a frame
 * or two, so we compare with slack instead of a strict `>`.
 */
const CLIP_TOLERANCE_SECONDS = 0.1;

/** The metadata we pull from a single `ffprobe` call. */
interface ProbedVideo {
  /** Container/stream duration in seconds. */
  durationSeconds: number;
  /** Raw stream pixel width (pre-rotation -- see note below). */
  width: number;
  /** Raw stream pixel height (pre-rotation). */
  height: number;
  /**
   * Frames per second parsed from the rational `r_frame_rate`, or `null` when
   * the source reports an unusable rate (e.g. `0/0` for some still-image inputs).
   */
  fps: number | null;
}

// --- safe accessors over the parsed-but-untyped ffprobe JSON ----------------
// ffprobe emits JSON; `JSON.parse` yields `unknown`. We narrow with these
// guards rather than reaching for `as`/`any`, so a malformed payload produces a
// clear error instead of a downstream `NaN`/undefined crash.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a finite number from a field that ffprobe may emit as a number or a string. */
function readNumberLike(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (value === "" || value === "N/A") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Parse a rational frame-rate string (`"30000/1001"`) without `parseFloat`. */
function parseRationalFps(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const [numStr, denStr] = raw.split("/");
  const num = Number(numStr);
  const den = denStr === undefined ? 1 : Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return fps > 0 ? fps : null;
}

/**
 * Probe a video file with a single ffprobe call and pull the fields we need.
 * Errors clearly (rather than emitting `NaN`) when the file has no video stream
 * or no resolvable duration.
 */
async function probeVideo(videoPath: string): Promise<ProbedVideo> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    videoPath,
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `ffprobe returned output that is not valid JSON for "${videoPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const root = asRecord(parsed);
  const rawStreams = root?.streams;
  const streams = Array.isArray(rawStreams) ? rawStreams : [];

  // First video stream. An audio-only / corrupt source has none -- fail with an
  // actionable message instead of indexing into `undefined`.
  const videoStream = streams
    .map(asRecord)
    .find((s) => s !== null && s.codec_type === "video");
  if (!videoStream) {
    throw new Error(
      `No video stream found in "${videoPath}" (audio-only or unsupported/corrupt file). Cannot clip.`,
    );
  }

  // Duration: prefer the stream's, fall back to the container's. Some containers
  // report "N/A" on the stream, so this fallback is load-bearing.
  const format = asRecord(root?.format);
  const durationSeconds =
    readNumberLike(videoStream.duration) ?? readNumberLike(format?.duration);
  if (durationSeconds === null) {
    throw new Error(
      `Could not determine a duration for "${videoPath}" (neither stream nor format duration was a parseable number).`,
    );
  }

  const width = readNumberLike(videoStream.width) ?? 0;
  const height = readNumberLike(videoStream.height) ?? 0;
  const fps = parseRationalFps(videoStream.r_frame_rate);

  return { durationSeconds, width, height, fps };
}

/**
 * Probe a source, hard-clip it to `CLIP_SECONDS`, and report the result.
 *
 * `clipPath` is `<outDir>/clip.mp4`. (The full extraction layout lives in
 * `lib/paths.ts`, but `resolveExtractionPaths` is keyed by outRoot+sourceId and
 * does not fit this flat `(sourcePath, outDir)` signature; run.ts passes the
 * extraction folder as `outDir`, so this join yields the same `clip.mp4` path
 * as `ExtractionPaths.clipMp4`.)
 *
 * NOTE: `ClipResult` carries only path + durations. The width/height/fps we
 * probe here are reported on stderr as diagnostics; if a later stage needs them
 * on the result, that is a contract change to `ClipResult` in types.ts (add
 * width/height/fps there) -- do not bolt extra fields onto the return here.
 */
export async function clip(sourcePath: string, outDir: string): Promise<ClipResult> {
  const src = resolve(sourcePath);
  const dir = resolve(outDir);
  const clipPath = join(dir, "clip.mp4");
  const capSeconds = CONSTANTS.CLIP_SECONDS;

  const source = await probeVideo(src);
  const originalDurationSeconds = source.durationSeconds;

  // Rotated video reports pre-rotation stream dimensions (a `displaymatrix`
  // side-data / `rotation` tag may swap them visually); we report the raw
  // stream dimensions for now -- a later stage can account for rotation.
  console.error(
    `[clip] probed source: ${originalDurationSeconds.toFixed(2)}s, ` +
      `${source.width}x${source.height}` +
      `${source.fps !== null ? `, ${source.fps.toFixed(3)}fps` : ", fps=unknown"} ` +
      `(dimensions are pre-rotation)`,
  );

  // Compare with slack, not strict `>`: a source at ~CLIP_SECONDS must not be
  // spuriously marked clipped.
  const wasClipped = originalDurationSeconds > capSeconds + CLIP_TOLERANCE_SECONDS;
  if (wasClipped) {
    console.error(
      `[clip] source is ${originalDurationSeconds.toFixed(1)}s; analyzing the first ${capSeconds}s only.`,
    );
  }

  await mkdir(dir, { recursive: true });

  // `-y` overwrites an existing clip.mp4 with no interactive prompt (which would
  // otherwise hang). `-t CLIP_SECONDS -c copy` is an instant stream copy; for a
  // sub-cap source `-t` is a harmless no-op and the whole file is copied.
  // ffmpeg writes progress/warnings to stderr while still exiting 0 -- success
  // is the exit code, which `run()` enforces, not stderr emptiness.
  await run("ffmpeg", ["-y", "-i", src, "-t", String(capSeconds), "-c", "copy", clipPath]);

  // Re-probe the produced clip for its TRUE duration: a `-c copy` cut lands on
  // the nearest keyframe, so the clip can be a hair under/over CLIP_SECONDS.
  const clipped = await probeVideo(clipPath);

  return {
    clipPath,
    originalDurationSeconds,
    clippedDurationSeconds: clipped.durationSeconds,
    wasClipped,
  };
}

// --- thin CLI ---------------------------------------------------------------
// `bun run clip.ts <sourcePath> [outDir]` -> prints ClipResult as JSON to stdout
// and ONLY that (diagnostics go to stderr), so run.ts can parse it directly.

if (import.meta.main) {
  const [sourcePath, outDir] = process.argv.slice(2);
  if (!sourcePath) {
    console.error("Usage: bun run clip.ts <sourcePath> [outDir]");
    process.exit(2);
  }
  try {
    const result = await clip(sourcePath, outDir ?? process.cwd());
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
