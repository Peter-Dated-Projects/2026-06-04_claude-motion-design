import { describe, expect, test } from "bun:test";
import {
  dateStamp,
  ensureExtractionDirs,
  extractionDirName,
  frameFileName,
  resolveExtractionPaths,
} from "./paths.ts";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("frameFileName", () => {
  test("zero-pads a 1-based index to frame_NNN.jpg", () => {
    expect(frameFileName(1)).toBe("frame_001.jpg");
    expect(frameFileName(42)).toBe("frame_042.jpg");
    expect(frameFileName(123)).toBe("frame_123.jpg");
  });

  test("rejects non-positive / non-integer indexes", () => {
    expect(() => frameFileName(0)).toThrow();
    expect(() => frameFileName(-1)).toThrow();
    expect(() => frameFileName(1.5)).toThrow();
  });
});

describe("dateStamp / extractionDirName", () => {
  const fixed = new Date(2026, 5, 6); // 2026-06-06 (month is 0-based)

  test("formats YYYY-MM-DD", () => {
    expect(dateStamp(fixed)).toBe("2026-06-06");
  });

  test("folder name is <date>_<sourceId>", () => {
    expect(extractionDirName("abc123", fixed)).toBe("2026-06-06_abc123");
  });

  test("requires a sourceId", () => {
    expect(() => extractionDirName("", fixed)).toThrow();
  });
});

describe("resolveExtractionPaths", () => {
  const fixed = new Date(2026, 5, 6);
  const paths = resolveExtractionPaths("/tmp/proj", "abc123", { date: fixed });

  test("pins the exact artifact layout", () => {
    const base = "/tmp/proj/extractions/2026-06-06_abc123";
    expect(paths.extractionsDir).toBe("/tmp/proj/extractions");
    expect(paths.dir).toBe(base);
    expect(paths.sourceMp4).toBe(join(base, "source.mp4"));
    expect(paths.clipMp4).toBe(join(base, "clip.mp4"));
    expect(paths.framesDir).toBe(join(base, "frames"));
    expect(paths.briefJson).toBe(join(base, "brief.json"));
    expect(paths.extractionMd).toBe(join(base, "extraction.md"));
  });

  test("frame paths live under frames/ with the pinned name", () => {
    expect(paths.framePath(1)).toBe("/tmp/proj/extractions/2026-06-06_abc123/frames/frame_001.jpg");
    expect(paths.framePath(60)).toBe("/tmp/proj/extractions/2026-06-06_abc123/frames/frame_060.jpg");
  });

  test("resolving creates nothing on disk", () => {
    expect(existsSync("/tmp/proj/extractions/2026-06-06_abc123")).toBe(false);
  });
});

describe("ensureExtractionDirs", () => {
  test("creates dir + frames/ idempotently", async () => {
    const root = join(tmpdir(), `ig-paths-test-${process.pid}-${Date.now()}`);
    const paths = resolveExtractionPaths(root, "xyz", { date: new Date(2026, 5, 6) });
    try {
      await ensureExtractionDirs(paths);
      expect((await stat(paths.framesDir)).isDirectory()).toBe(true);
      // idempotent: a second call does not throw
      await ensureExtractionDirs(paths);
      expect((await stat(paths.dir)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
