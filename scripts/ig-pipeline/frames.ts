/**
 * Stage: frame extraction.
 *
 * Bridge between a clipped video and the scoring stage: sample the clip densely
 * enough to catch fast text reveals and hold moments, but not so densely the
 * scorer drowns in near-duplicates. The proposal fixes that at 2fps
 * (60 candidates across the 30s cap) -- see `Stage 1 -- Extract at 2fps` in
 * `.charm/proposals/PROPOSAL-instagram-pipeline.md`.
 *
 *   ffmpeg -i <clip> -vf "fps=<FPS>,scale=<SCALE_WIDTH>:-1" -q:v 2 frame_%04d.jpg
 *
 * The emitted JPEGs are raw *candidates* named with a 4-digit ffmpeg counter
 * (`frame_0001.jpg`). That is deliberately distinct from `lib/paths`'
 * `frameFileName` 3-digit naming (`frame_001.jpg`), which the store stage uses
 * for the *kept survivors* it writes into the extraction folder -- two different
 * sets, so the digit counts don't collide.
 */

import { join, resolve } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { run } from "./lib/spawn.ts";
import { CONSTANTS } from "./lib/constants.ts";
import type { FrameSet } from "./types.ts";

/** ffmpeg output filename pattern for the candidate frames (4-digit counter). */
const FRAME_PATTERN = "frame_%04d.jpg";

/** Matches an emitted candidate frame and captures its numeric index. */
const FRAME_FILE_RE = /^frame_(\d+)\.jpg$/;

/**
 * Extract candidate frames from `clipPath` at the pipeline's sampling rate,
 * writing them into a `frames/` subdirectory of `outDir`.
 *
 * The `frames/` subdir is cleared and recreated first so a shorter re-run cannot
 * leave higher-numbered frames from a previous, longer run mixed in with the new
 * set. The delete is scoped to that subdir only -- sibling artifacts
 * (source.mp4, clip.mp4, brief.json, ...) under `outDir` are never touched.
 *
 * ffmpeg runs through the `lib/spawn` wrapper, so a missing `ffmpeg` binary
 * surfaces as a `SpawnError` of kind `binary_not_found` (distinct from ffmpeg
 * having run and exited non-zero, which carries its stderr). Either way the
 * error propagates rather than yielding a silent empty FrameSet.
 */
export async function extractFrames(clipPath: string, outDir: string): Promise<FrameSet> {
  const { FPS, SCALE_WIDTH } = CONSTANTS;

  const absClip = resolve(clipPath);
  // lib/paths only builds frames dirs from a full ExtractionPaths (outRoot +
  // sourceId + date), which this stage isn't given -- so resolve the subdir from
  // the provided outDir with node:path rather than string-joining inline.
  const framesDir = join(resolve(outDir), "frames");

  // Recreate the frames dir so stale frames from a prior run can't leak through.
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  // Captured (not streamed) so ffmpeg's stderr is available to attach to the
  // error if it exits non-zero (e.g. an unreadable/corrupt clip).
  await run("ffmpeg", [
    "-y",
    "-i",
    absClip,
    "-vf",
    `fps=${FPS},scale=${SCALE_WIDTH}:-1`,
    "-q:v",
    "2",
    join(framesDir, FRAME_PATTERN),
  ]);

  // Enumerate what ffmpeg actually produced (it can emit one more/fewer than
  // ceil(duration*fps) depending on rounding), then order by numeric index. The
  // %04d counter is zero-padded so lexical == numeric up to 9999, but sort on the
  // parsed integer explicitly rather than trusting filesystem enumeration order.
  const entries = await readdir(framesDir);
  const framePaths = entries
    .map((name) => {
      const match = FRAME_FILE_RE.exec(name);
      return match ? { name, index: Number(match[1]) } : null;
    })
    .filter((e): e is { name: string; index: number } => e !== null)
    .sort((a, b) => a.index - b.index)
    .map((e) => join(framesDir, e.name));

  return {
    clipPath: absClip,
    framePaths,
    fps: FPS,
    width: SCALE_WIDTH,
  };
}

// ---------------------------------------------------------------------------
// CLI: `bun run frames.ts <clipPath> [outDir]`
// Thin wrapper over extractFrames -- prints the FrameSet as JSON. No logic lives
// only here.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [clipPath, outDir = "."] = process.argv.slice(2);

  if (!clipPath) {
    console.error("Usage: bun run frames.ts <clipPath> [outDir]");
    process.exit(2);
  }

  extractFrames(clipPath, outDir)
    .then((frameSet) => {
      console.log(JSON.stringify(frameSet, null, 2));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
