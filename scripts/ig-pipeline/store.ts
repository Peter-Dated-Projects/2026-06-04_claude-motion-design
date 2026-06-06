/**
 * store.ts -- the terminal pipeline stage.
 *
 * Turns the in-memory stage results into the durable artifact set on disk under
 * the per-source extraction folder resolved by `lib/paths.ts`:
 *
 *   <out>/extractions/<YYYY-MM-DD>_<sourceId>/
 *     source.mp4     <- original downloaded file        (DownloadResult.sourcePath)
 *     clip.mp4       <- <=30s working copy              (ClipResult.clipPath)
 *     frames/        <- every scored candidate JPEG     (ScoreResult.scored)
 *     brief.json     <- raw Brief JSON                  (AnalyzeResult.brief)
 *     extraction.md  <- human-readable brief + metadata
 *
 * This module owns NONE of the layout: filenames and the folder shape come from
 * `ExtractionPaths` (lib/paths.ts), never a literal built here.
 *
 * Idempotent: a second `writeExtraction` for the same folder overwrites
 * brief.json / extraction.md, reconciles media in place, and prunes stale frames
 * -- it never duplicates, appends, or errors on already-present files.
 */

import { copyFile, rename, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  AnalyzeResult,
  Brief,
  ClipResult,
  DownloadResult,
  ExtractionPaths,
  ScoreResult,
} from "./types.ts";
import { ensureExtractionDirs } from "./lib/paths.ts";

/** The full set of upstream stage outputs the store stage composes from. */
export interface ExtractionResults {
  download: DownloadResult;
  clip: ClipResult;
  scoreResult: ScoreResult;
  analyze: AnalyzeResult;
}

/**
 * Write the complete extraction folder. Sequenced for partial-write safety: the
 * brief (brief.json + extraction.md) is the valuable output, so it is written
 * first; if a later media move fails, the brief is already on disk.
 */
export async function writeExtraction(
  paths: ExtractionPaths,
  results: ExtractionResults,
): Promise<void> {
  await ensureExtractionDirs(paths);
  await writeBriefJson(paths, results.analyze.brief);
  await writeExtractionMd(paths, results);
  await placeMediaArtifacts(paths, results);
}

// ---------------------------------------------------------------------------
// brief.json
// ---------------------------------------------------------------------------

/** Write the raw `Brief` as pretty-printed JSON. Round-trips back to the same object. */
export async function writeBriefJson(paths: ExtractionPaths, brief: Brief): Promise<void> {
  await writeFile(paths.briefJson, `${JSON.stringify(brief, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// extraction.md
// ---------------------------------------------------------------------------

/** Write the human-readable `extraction.md`: YAML frontmatter + brief rendered as markdown. */
export async function writeExtractionMd(
  paths: ExtractionPaths,
  results: ExtractionResults,
): Promise<void> {
  const md = renderExtractionMd(results);
  await writeFile(paths.extractionMd, md, "utf8");
}

/**
 * Render the full `extraction.md` document. Pure (no I/O), so it is the unit the
 * smoke entry and any future test exercise directly.
 */
export function renderExtractionMd(results: ExtractionResults): string {
  const { download, clip, scoreResult, analyze } = results;

  const framesAnalyzed = scoreResult.kept.length;
  const framesRejected = scoreResult.scored.length - scoreResult.kept.length;

  // Every value sourced from a stage result; nothing hardcoded. Strings that can
  // carry YAML-sensitive characters (URL, model, timestamp) are double-quoted via
  // JSON.stringify, which emits a valid YAML double-quoted scalar.
  const frontmatter = [
    "---",
    `source: ${yamlString(download.sourceUrl)}`,
    `extracted: ${yamlString(new Date().toISOString())}`,
    `originalDuration: ${yamlNumber(clip.originalDurationSeconds)}`,
    `clippedDuration: ${yamlNumber(clip.clippedDurationSeconds)}`,
    `wasClipped: ${clip.wasClipped ? "true" : "false"}`,
    `framesAnalyzed: ${framesAnalyzed}`,
    `framesRejected: ${framesRejected}`,
    `model: ${yamlString(analyze.model)}`,
    `costUsd: ${yamlNumber(analyze.costUsd)}`,
    `durationMs: ${yamlNumber(analyze.durationMs)}`,
    `numTurns: ${yamlNumber(analyze.numTurns)}`,
    "---",
  ].join("\n");

  const m = analyze.brief.motionLanguage ?? ({} as Brief["motionLanguage"]);
  const body = [
    "# Motion-Language Brief",
    "",
    "## Motion Language",
    "",
    `**Energy:** ${mdField(m.energy)}`,
    "",
    `**Rhythm:** ${mdField(m.rhythm)}`,
    "",
    `**Pacing:** ${mdField(m.pacing)}`,
    "",
    `**Transitions:** ${mdField(m.transitions)}`,
    "",
    `**Signature:** ${mdField(m.signature)}`,
    "",
    "## Motion Theme",
    "",
    mdField(analyze.brief.motionTheme),
    "",
    "## Color Mood",
    "",
    mdField(analyze.brief.colorMood),
    "",
    "## Typography Motion",
    "",
    mdField(analyze.brief.typographyMotion),
    "",
    "## Application Guide",
    "",
    mdField(analyze.brief.applicationGuide),
    "",
  ].join("\n");

  return `${frontmatter}\n\n${body}`;
}

/**
 * Quote a string as a YAML double-quoted scalar via JSON.stringify (JSON's
 * escaping is a valid subset of YAML's). `null`/`undefined` -> the bare `null`
 * keyword, so the key is present rather than the literal string "undefined".
 */
function yamlString(value: string | null | undefined): string {
  if (value === null || value === undefined) return "null";
  return JSON.stringify(value);
}

/** Emit a finite number verbatim; anything else (NaN/undefined/null) -> `null`. */
function yamlNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "null";
}

/** Render one brief field for the body; empty/missing -> an italic placeholder. */
function mdField(value: string | null | undefined): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : "_(not specified)_";
}

// ---------------------------------------------------------------------------
// media reconciliation
// ---------------------------------------------------------------------------

/**
 * Move/copy source.mp4, clip.mp4, and every candidate frame into the final
 * folder, then prune any stale frames left from a previous run. Upstream stages
 * may have written these to a scratch/temp dir, or already in place -- both cases
 * are handled without crashing.
 */
export async function placeMediaArtifacts(
  paths: ExtractionPaths,
  results: ExtractionResults,
): Promise<void> {
  await reconcileFile(results.download.sourcePath, paths.sourceMp4);
  await reconcileFile(results.clip.clipPath, paths.clipMp4);

  const expected = new Set<string>();
  for (const frame of results.scoreResult.scored) {
    const dest = paths.framePath(frame.index);
    expected.add(basename(dest));
    await reconcileFile(frame.path, dest);
  }

  await pruneStaleFrames(paths, expected);
}

/**
 * Move `src` to `dest`, overwriting. No-op when they already resolve to the same
 * path, or when `src` is gone but `dest` already exists (media was reconciled by
 * a prior run -- keeps re-runs from crashing). Falls back to copy when `rename`
 * can't cross a device boundary (EXDEV).
 */
async function reconcileFile(src: string, dest: string): Promise<void> {
  if (resolve(src) === resolve(dest)) return;
  try {
    await rename(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EXDEV") {
      await copyFile(src, dest);
      await rm(src, { force: true });
      return;
    }
    // Source already consumed by a prior run and the artifact is in place: no-op.
    if (code === "ENOENT" && existsSync(dest)) return;
    throw err;
  }
}

/** Delete `frame_NNN.jpg` files in the frames dir that are not in the current set. */
async function pruneStaleFrames(paths: ExtractionPaths, keep: Set<string>): Promise<void> {
  const entries = await readdir(paths.framesDir);
  await Promise.all(
    entries
      .filter((name) => /^frame_\d+\.jpg$/.test(name) && !keep.has(name))
      .map((name) => rm(paths.framePath(frameIndexFromName(name)), { force: true })),
  );
}

/** Parse the 1-based index out of a `frame_NNN.jpg` filename. */
function frameIndexFromName(name: string): number {
  const match = name.match(/^frame_(\d+)\.jpg$/);
  // The caller only passes names matching the regex above.
  return Number(match![1]);
}

// ---------------------------------------------------------------------------
// smoke entry: write a fixture extraction into a temp dir to exercise the stage
// standalone (`bun run scripts/ig-pipeline/store.ts`).
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { mkdtemp, writeFile: write } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveExtractionPaths } = await import("./lib/paths.ts");

  const root = await mkdtemp(join(tmpdir(), "ig-store-smoke-"));
  const paths = resolveExtractionPaths(root, "smoke123", { date: new Date(2026, 5, 6) });
  await ensureExtractionDirs(paths);

  // Stand-in media: a couple of tiny placeholder files in a scratch dir, so the
  // reconcile path (move-into-place) is exercised, not just the no-op path.
  const scratch = await mkdtemp(join(tmpdir(), "ig-store-scratch-"));
  const srcMp4 = join(scratch, "raw.mp4");
  const clipMp4 = join(scratch, "trimmed.mp4");
  await write(srcMp4, "fake-source");
  await write(clipMp4, "fake-clip");
  const frame1 = join(scratch, "f1.jpg");
  const frame2 = join(scratch, "f2.jpg");
  await write(frame1, "fake-frame-1");
  await write(frame2, "fake-frame-2");

  const brief: Brief = {
    motionLanguage: {
      energy: "punchy and immediate",
      rhythm: "burst-and-hold",
      pacing: "fast cuts with brief holds",
      transitions: "hard cuts and quick zooms",
      signature: "the snap-zoom on every beat",
    },
    motionTheme: "Restless momentum that never settles.",
    colorMood: "Warm, saturated, slightly nostalgic.",
    typographyMotion: "absent",
    applicationGuide:
      "Cut on the beat, hold just long enough to read, then snap forward. " +
      "Let color carry continuity across hard cuts.",
  };

  const results: ExtractionResults = {
    download: {
      sourcePath: srcMp4,
      id: "smoke123",
      sourceUrl: 'https://www.instagram.com/reel/smoke123/?weird="quote"&x=1',
      durationSeconds: 47.2,
      usedCookieFallback: false,
    },
    clip: {
      clipPath: clipMp4,
      originalDurationSeconds: 47.2,
      clippedDurationSeconds: 30,
      wasClipped: true,
    },
    scoreResult: {
      scored: [
        { path: frame1, index: 1, sharpness: 120, delta: null, entropy: 6.1, score: 9, kept: true },
        {
          path: frame2,
          index: 2,
          sharpness: 20,
          delta: 3,
          entropy: 2.1,
          score: 1,
          kept: false,
          rejectReason: "low_sharpness",
        },
      ],
      kept: [
        { path: frame1, index: 1, sharpness: 120, delta: null, entropy: 6.1, score: 9, kept: true },
      ],
    },
    analyze: {
      brief,
      costUsd: 0.0123,
      durationMs: 8421,
      numTurns: 2,
      model: "claude-sonnet-4-6",
    },
  };

  await writeExtraction(paths, results);
  // Re-run to prove idempotency.
  await writeExtraction(paths, results);

  console.log(`Wrote extraction to ${paths.dir}`);
  console.log(`  brief.json:    ${paths.briefJson}`);
  console.log(`  extraction.md: ${paths.extractionMd}`);
}
