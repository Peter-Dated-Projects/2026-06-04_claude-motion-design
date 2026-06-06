/**
 * OPT-IN end-to-end smoke test for the full pipeline.
 *
 * WARNING: when enabled this test HITS THE NETWORK (downloads a real Instagram
 * reel via yt-dlp) and SPENDS REAL MONEY (~$0.21 for the `claude -p` analysis
 * call, per the spike). It is therefore gated behind `IG_E2E=1` and skips
 * cleanly otherwise -- plain `bun test` does ZERO network I/O and spends ZERO
 * money. The skip short-circuits before any stage runs.
 *
 * Enable it explicitly:
 *
 *   IG_E2E=1 bun test run.e2e.test.ts
 *
 * It asserts the artifact set exists and that the parsed brief is schema-valid
 * and non-empty -- never exact wording or an exact kept-frame count, both of
 * which are reel- and threshold-dependent (the spike got 11; do not pin it).
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./run.ts";
import { validateBrief } from "./analyze.ts";

/** The spike's proven target reel. */
const REEL_URL = "https://www.instagram.com/reel/DYsvvtAhLUQ/";

/** Only run when explicitly opted in; otherwise this is a no-op (NOT a failure). */
const ENABLED = process.env.IG_E2E === "1";

/**
 * Real analyze round-trip is ~40-60s alone, plus download + ffmpeg + scoring.
 * Give the whole flow a generous ceiling so the live claude call doesn't flake.
 */
const E2E_TIMEOUT_MS = 180_000;

let outRoot: string | undefined;

afterAll(async () => {
  if (outRoot) await rm(outRoot, { recursive: true, force: true });
});

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

test.skipIf(!ENABLED)(
  "full pipeline produces the complete artifact set + a valid brief",
  async () => {
    outRoot = await mkdtemp(join(tmpdir(), "ig-e2e-"));

    const result = await run(REEL_URL, outRoot);
    const { paths } = result;

    // Artifact set: every file the contract promises must exist on disk.
    expect(await isFile(paths.sourceMp4)).toBe(true);
    expect(await isFile(paths.clipMp4)).toBe(true);
    expect(await isFile(paths.briefJson)).toBe(true);
    expect(await isFile(paths.extractionMd)).toBe(true);

    // frames/ exists with at least one kept frame (exact count is threshold- and
    // reel-dependent -- assert >=1, never a fixed number).
    const frameFiles = (await readdir(paths.framesDir)).filter((n) =>
      /^frame_\d+\.jpg$/.test(n),
    );
    expect(frameFiles.length).toBeGreaterThanOrEqual(1);

    // brief.json round-trips to a schema-valid, non-empty Brief. validateBrief
    // throws on any missing/empty required field, so a pass here is the schema
    // assertion; we check shape, not wording.
    const briefRaw = JSON.parse(await readFile(paths.briefJson, "utf8"));
    const brief = validateBrief(briefRaw);
    expect(brief.motionTheme.trim().length).toBeGreaterThan(0);
    expect(brief.motionLanguage.signature.trim().length).toBeGreaterThan(0);

    // The in-memory result agrees with what landed on disk.
    expect(result.scoreResult.kept.length).toBeGreaterThanOrEqual(1);
    expect(result.analyze.costUsd).toBeGreaterThan(0);
  },
  E2E_TIMEOUT_MS,
);
