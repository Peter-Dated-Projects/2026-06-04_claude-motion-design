/**
 * Output-folder layout for one extraction. This is the single source of truth
 * for where artifacts live and how frames are named, shared by frames.ts (which
 * writes the JPEGs) and store.ts (which writes everything else). Pinning it here
 * keeps the two stages from diverging.
 *
 * Layout (the `extractions/` parent segment is part of the contract):
 *
 *   <out>/extractions/<YYYY-MM-DD>_<sourceId>/
 *     source.mp4
 *     clip.mp4
 *     frames/
 *       frame_001.jpg   (1-based, zero-padded to 3 digits)
 *       frame_002.jpg
 *     brief.json
 *     extraction.md
 *
 * Resolving paths has NO filesystem side effects -- nothing is created on import
 * or on `resolveExtractionPaths`. Creating the directories is an explicit,
 * opt-in call (`ensureExtractionDirs`), owned by the store stage.
 */

import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ExtractionPaths } from "../types.ts";

/** Zero-pad a 1-based frame index to the pinned `frame_NNN.jpg` filename. */
export function frameFileName(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Frame index must be a 1-based positive integer, got ${index}.`);
  }
  return `frame_${String(index).padStart(3, "0")}.jpg`;
}

/** Format a Date as the `YYYY-MM-DD` segment used in the extraction folder name. */
export function dateStamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The folder name for one extraction: `<YYYY-MM-DD>_<sourceId>`. */
export function extractionDirName(sourceId: string, date: Date = new Date()): string {
  if (!sourceId) throw new Error("sourceId is required to build an extraction folder name.");
  return `${dateStamp(date)}_${sourceId}`;
}

export interface ResolvePathsOptions {
  /** Date used in the folder name; defaults to now. Pass a fixed Date for deterministic tests. */
  date?: Date;
}

/**
 * Resolve the full set of artifact paths for one extraction under `outRoot`.
 * `outRoot` is the project/output root that contains (or will contain) the
 * `extractions/` directory. Pure: creates nothing.
 */
export function resolveExtractionPaths(
  outRoot: string,
  sourceId: string,
  options: ResolvePathsOptions = {},
): ExtractionPaths {
  const root = resolve(outRoot);
  const extractionsDir = join(root, "extractions");
  const dir = join(extractionsDir, extractionDirName(sourceId, options.date));
  const framesDir = join(dir, "frames");

  return {
    dir,
    extractionsDir,
    sourceMp4: join(dir, "source.mp4"),
    clipMp4: join(dir, "clip.mp4"),
    framesDir,
    briefJson: join(dir, "brief.json"),
    extractionMd: join(dir, "extraction.md"),
    framePath(index: number): string {
      return join(framesDir, frameFileName(index));
    },
  };
}

/**
 * Create the extraction directory and its `frames/` subdirectory (recursive,
 * idempotent). The ONLY filesystem-mutating helper in this module -- call it
 * explicitly from the store stage before writing artifacts.
 */
export async function ensureExtractionDirs(paths: ExtractionPaths): Promise<void> {
  await mkdir(paths.framesDir, { recursive: true });
}
