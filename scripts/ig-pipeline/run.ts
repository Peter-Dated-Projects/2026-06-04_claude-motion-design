/**
 * run.ts -- the pipeline orchestrator.
 *
 * Chains the six stages into one command and threads each stage's typed result
 * into the next, exactly as the contract in `types.ts` lays out:
 *
 *   download  ( url-or-path )      -> DownloadResult
 *   clip      ( DownloadResult )   -> ClipResult
 *   frames    ( ClipResult )       -> FrameSet
 *   score     ( FrameSet )         -> ScoreResult
 *   analyze   ( ScoreResult.kept ) -> AnalyzeResult
 *   store     ( all of the above ) -> writes the extraction folder
 *
 * This file owns ZERO stage logic: no thresholds, no ffmpeg/yt-dlp/claude
 * invocation, and no path math. It imports each stage's exported function and
 * resolves the output layout through `lib/paths.ts`. If a stage needs to change,
 * it changes in that stage's module, not here.
 *
 * Progress: each stage is wrapped so a `STAGE <name> <0..1>` line is emitted to
 * stdout when it starts (0.000) and finishes (1.000) -- the `StageProgress`
 * shape from types.ts, via `formatStageProgress`. The download stage also
 * forwards its own granular progress through the same sink. A later UI can parse
 * these lines without a rewrite.
 *
 * Failure: any stage throwing aborts the run non-zero with a single actionable
 * line naming the failing stage (e.g. `download failed: yt-dlp not found on
 * PATH`) -- the originating stage's message is surfaced, never swallowed or
 * re-wrapped into a generic error, and never dumped as a raw stack trace.
 */

import { download } from "./download.ts";
import { clip } from "./clip.ts";
import { extractFrames } from "./frames.ts";
import { scoreFrames } from "./score.ts";
import { analyze } from "./analyze.ts";
import { writeExtraction } from "./store.ts";
import { resolveExtractionPaths } from "./lib/paths.ts";
import { formatStageProgress } from "./types.ts";
import type {
  AnalyzeResult,
  ClipResult,
  DownloadResult,
  ExtractionPaths,
  FrameSet,
  ScoreResult,
  StageName,
  StageProgress,
} from "./types.ts";

/** Emit one `STAGE <name> <0..1>` progress line to stdout. */
function emit(progress: StageProgress): void {
  console.log(formatStageProgress(progress));
}

/**
 * A stage failure that already names its stage. Carries the originating stage's
 * message verbatim so the top-level handler can print one actionable line
 * without a stack dump or a generic re-wrap.
 */
class StageError extends Error {
  constructor(
    readonly stage: StageName,
    readonly detail: string,
  ) {
    super(`${stage} failed: ${detail}`);
    this.name = "StageError";
  }
}

/**
 * Run one stage, wrapping any throw in a `StageError` that names the stage.
 *
 * By default it emits the `STAGE <name> 0.000` / `STAGE <name> 1.000` bookends
 * itself. Pass `selfReports: true` for a stage that drives its own
 * `onProgress` sink (download) so we don't double-emit the 0 and 1 it already
 * produces -- the wrapper then only owns error-naming for that stage.
 */
async function runStage<T>(
  stage: StageName,
  fn: () => Promise<T>,
  selfReports = false,
): Promise<T> {
  if (!selfReports) emit({ stage, progress: 0 });
  try {
    const result = await fn();
    if (!selfReports) emit({ stage, progress: 1 });
    return result;
  } catch (err) {
    throw new StageError(stage, err instanceof Error ? err.message : String(err));
  }
}

export interface RunResult {
  paths: ExtractionPaths;
  download: DownloadResult;
  clip: ClipResult;
  frameSet: FrameSet;
  scoreResult: ScoreResult;
  analyze: AnalyzeResult;
}

/**
 * Run the full pipeline for one `input` (a reel URL or a local video path) under
 * `outRoot` (the project/output root that holds the `extractions/` folder).
 *
 * `date` is resolved once and threaded into both the download stage and
 * `resolveExtractionPaths` so the per-source folder name cannot straddle a
 * day boundary between the two calls.
 */
export async function run(input: string, outRoot: string): Promise<RunResult> {
  const date = new Date();

  const dl = await runStage(
    "download",
    // download drives its own granular progress (0 -> probe -> download -> 1)
    // through this sink, so it self-reports; runStage skips its bookends to
    // avoid double-emitting the 0 and 1.
    () => download(input, outRoot, { date, onProgress: emit }),
    true,
  );

  // Resolve the output layout once, keyed by the source id the download stage
  // assigned (the reel id for a URL, a path-derived id for a local file). All
  // later stages write into this single folder; no path is built by hand here.
  const paths = resolveExtractionPaths(outRoot, dl.id, { date });

  const clipResult = await runStage("clip", () => clip(dl.sourcePath, paths.dir));

  const frameSet = await runStage("frames", () =>
    extractFrames(clipResult.clipPath, paths.dir),
  );

  const scoreResult = await runStage("score", () => scoreFrames(frameSet.framePaths));

  // A reel that yields zero survivors after filtering is a legitimate failure:
  // abort here rather than handing analyze() an empty list and burning CLI cost.
  if (scoreResult.kept.length === 0) {
    throw new StageError(
      "score",
      `no frames survived filtering (${scoreResult.scored.length} candidate(s) all rejected); ` +
        `nothing to analyze. The clip may be too short, too static, or too fast-cut.`,
    );
  }

  const analyzeResult = await runStage("analyze", () =>
    analyze(scoreResult.kept.map((f) => f.path)),
  );

  await runStage("store", () =>
    writeExtraction(paths, {
      download: dl,
      clip: clipResult,
      scoreResult,
      analyze: analyzeResult,
    }),
  );

  return {
    paths,
    download: dl,
    clip: clipResult,
    frameSet,
    scoreResult,
    analyze: analyzeResult,
  };
}

/** Print the human-readable end-of-run summary to stdout. */
function printSummary(result: RunResult): void {
  const kept = result.scoreResult.kept.length;
  const rejected = result.scoreResult.scored.length - kept;
  const { motionTheme } = result.analyze.brief;

  console.log("");
  console.log("Extraction complete.");
  console.log(`  output folder: ${result.paths.dir}`);
  console.log(`  frames:        ${kept} kept / ${rejected} rejected`);
  console.log(`  motion theme:  ${motionTheme}`);
  console.log(`  cost:          $${result.analyze.costUsd.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// CLI: `bun run run.ts <url-or-path> [outRoot]`
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [input, outRoot = "."] = process.argv.slice(2);
  if (!input) {
    console.error("usage: bun run run.ts <url-or-path> [outRoot]");
    process.exit(2);
  }

  run(input, outRoot)
    .then((result) => {
      printSummary(result);
    })
    .catch((err) => {
      // StageError already carries the one-line, stage-named message; for any
      // other error fall back to its message. Either way: no stack dump.
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
