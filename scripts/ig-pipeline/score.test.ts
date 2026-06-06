/**
 * Offline tests for the score+filter stage. No network, no ffmpeg, no claude --
 * everything runs against the committed 8x8 PNG fixtures in `fixtures/`, whose
 * sharpness / delta / entropy are known analytically (see `fixtures/generate.ts`).
 *
 * Pinned reference values (derived in fixtures/generate.ts):
 *   solid_gray128 : sharpness 0,        entropy 0 bits
 *   stripes_255   : sharpness 4*255^2 = 260100, entropy 1 bit
 *   stripes_128   : sharpness 4*128^2 = 65536
 *   stripes_64    : sharpness 4*64^2  = 16384
 *   black_white   : entropy 1 bit
 *   solid_100 vs solid_130 : delta 30
 */
import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  computeDelta,
  computeEntropy,
  computeSharpness,
  decodeFrame,
  normalizeEntropy,
  scoreFrames,
} from "./score.ts";
import { resolveConstants } from "./lib/constants.ts";
import type { ScoredFrame } from "./types.ts";

const FIX = join(import.meta.dir, "fixtures");
const fix = (name: string) => join(FIX, name);

describe("metric functions (pinned against fixtures)", () => {
  test("sharpness: solid is ~0, stripes match 4*hi^2", async () => {
    const solid = await decodeFrame(fix("solid_gray128.png"));
    const s255 = await decodeFrame(fix("stripes_255.png"));
    const s128 = await decodeFrame(fix("stripes_128.png"));
    const s64 = await decodeFrame(fix("stripes_64.png"));

    expect(computeSharpness(solid.gray, solid.width, solid.height)).toBe(0);
    // Exact integers for stripes_255; float epsilon for the others.
    expect(computeSharpness(s255.gray, s255.width, s255.height)).toBe(260100);
    expect(computeSharpness(s128.gray, s128.width, s128.height)).toBeCloseTo(65536, 3);
    expect(computeSharpness(s64.gray, s64.width, s64.height)).toBeCloseTo(16384, 3);
  });

  test("delta: mean absolute grayscale difference is exact for solids", async () => {
    const c100 = await decodeFrame(fix("solid_100.png"));
    const c130 = await decodeFrame(fix("solid_130.png"));
    expect(computeDelta(c100.gray, c130.gray)).toBeCloseTo(30, 6);
    expect(computeDelta(c100.gray, c100.gray)).toBe(0);
  });

  test("delta: throws on a frame-size mismatch", () => {
    expect(() => computeDelta(new Float64Array(4), new Float64Array(9))).toThrow();
  });

  test("entropy: joint 8x8x8 histogram gives 0 for solid, 1 bit for two-color", async () => {
    const solid = await decodeFrame(fix("solid_gray128.png"));
    const bw = await decodeFrame(fix("black_white.png"));
    expect(computeEntropy(solid.rgb)).toBe(0);
    expect(computeEntropy(bw.rgb)).toBeCloseTo(1, 6);
    // Normalization divides by log2(512) = 9.
    expect(normalizeEntropy(9)).toBeCloseTo(1, 6);
    expect(normalizeEntropy(0)).toBe(0);
  });
});

describe("scoreFrames: filtering, ranking, and warnings", () => {
  // Crafted ordered set exercising every decision path. MAX_KEPT_FRAMES forced to
  // 2 so that one survivor falls outside the top-N (the "below-top-N" case).
  const crafted = () => [
    fix("stripes_255.png"), // f1: first frame, delta exempt, sharp -> kept
    fix("stripes_255.png"), // f2: identical to f1 -> delta 0 -> insufficient_change
    fix("solid_gray128.png"), // f3: big delta but sharpness 0 -> low_sharpness
    fix("stripes_128.png"), // f4: passes both -> kept
    fix("stripes_64.png"), // f5: passes both but ranks 3rd -> below-top-N
  ];
  const constants = resolveConstants({ MAX_KEPT_FRAMES: 2 });

  test("exercises all reject paths and ranks survivors best-first", async () => {
    const warnings: string[] = [];
    const { scored, kept } = await scoreFrames(crafted(), {
      constants,
      onWarn: (m) => warnings.push(m),
    });

    expect(scored).toHaveLength(5);
    const [f1, f2, f3, f4, f5] = scored as [
      ScoredFrame,
      ScoredFrame,
      ScoredFrame,
      ScoredFrame,
      ScoredFrame,
    ];

    // f1: first frame -> delta is null (NOT 0) and it is never rejected on delta.
    expect(f1.delta).toBeNull();
    expect(f1.kept).toBe(true);
    expect(f1.rejectReason).toBeUndefined();

    // f2: identical to f1 -> zero delta -> insufficient_change.
    expect(f2.delta).toBe(0);
    expect(f2.kept).toBe(false);
    expect(f2.rejectReason).toBe("insufficient_change");

    // f3: sufficient delta but flat -> low_sharpness.
    expect(f3.delta).not.toBeNull();
    expect(f3.kept).toBe(false);
    expect(f3.rejectReason).toBe("low_sharpness");

    // f4: passes both filters and makes the top-2.
    expect(f4.kept).toBe(true);
    expect(f4.rejectReason).toBeUndefined();

    // f5: passes both filters but ranks outside top-2 -> kept false, NO rejectReason
    // (below-top-N is the absence of a reason in the frozen RejectReason contract).
    expect(f5.kept).toBe(false);
    expect(f5.rejectReason).toBeUndefined();

    // Kept set is ranked best-first by combined score (sharper -> higher).
    expect(kept).toHaveLength(2);
    const [k0, k1] = kept as [ScoredFrame, ScoredFrame];
    expect(k0.path).toBe(fix("stripes_255.png"));
    expect(k1.path).toBe(fix("stripes_128.png"));
    expect(k0.score).toBeGreaterThan(k1.score);
  });

  test("warns (non-fatally) when fewer than minSurvivors survive", async () => {
    const warnings: string[] = [];
    // 3 survivors < default minSurvivors of 5.
    const result = await scoreFrames(crafted(), {
      constants,
      onWarn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("3 frame(s) survived");
    // Non-fatal: it still returns a valid result.
    expect(result.kept.length).toBeGreaterThan(0);
  });

  test("the default warning sink is console.error (stderr)", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await scoreFrames(crafted(), { constants });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("does not warn when enough frames survive", async () => {
    const warnings: string[] = [];
    await scoreFrames(crafted(), {
      constants,
      minSurvivors: 2, // 3 survivors >= 2 -> no warning
      onWarn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(0);
  });

  test("first frame is never rejected on delta even when its successor would be", async () => {
    // A single solid frame: delta null, but it is flat so it is low_sharpness --
    // proving the delta exemption does not also exempt sharpness.
    const { scored } = await scoreFrames([fix("solid_gray128.png")], {
      onWarn: () => {},
    });
    const [only] = scored as [ScoredFrame];
    expect(only.delta).toBeNull();
    expect(only.rejectReason).toBe("low_sharpness");
  });
});
