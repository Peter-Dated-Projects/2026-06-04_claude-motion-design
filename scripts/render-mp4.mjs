// Render a project's animation.tsx to an MP4 (charm: Export MP4).
//
// Invoked by the Rust `export_mp4` command (src-tauri/src/commands/export.rs),
// which spawns `node` directly (NOT through the Tauri shell plugin) with cwd set
// to the repo root so @remotion/bundler + @remotion/renderer resolve from the
// repo's node_modules. This is the "local Node" approach: it relies on Node being
// installed and the repo's node_modules present (true in dev / when dogfooding).
// Shipping to users with nothing installed is a separate step (bundle a sidecar).
//
// Contract (mirrors the preview sandbox in src/assets/sandbox-frame.html so the
// MP4 matches the preview frame-for-frame):
//   - Fixed 1080x1920, 9:16 vertical.
//   - animation.tsx `export default`s a React component.
//   - Optional `export const fps` / `export const durationInFrames`, or a single
//     `export const config = { fps, durationInFrames }`. Defaults: 30 / 150.
//   - Animations are self-contained (skills prompt forbids external assets /
//     staticFile), so no publicDir / asset resolution is needed here.
//
// Usage: node scripts/render-mp4.mjs <projectDir> <outPath> [codec] [quality] [gifFps]
//   codec:   h264 (default) | h265 | vp9 | gif
//   quality: high (default) | medium | low
//     video codecs -> a per-codec CRF (constant-rate-factor).
//     gif          -> output resolution scale (GIF has no CRF). Downscaling is the
//                     dominant size lever for a 1080x1920 GIF.
//   gifFps:  GIF target frame rate (default 15); rendered by dropping to every Nth
//            source frame. Ignored for video codecs.
//   gifCompression: none (default) | light | strong. Lossy gifsicle post-process
//            on the rendered GIF (best-effort; skipped if gifsicle is unavailable).
// Progress is emitted to stdout as `PROGRESS <0..1>` lines for the caller to
// parse; everything else (Remotion logs, the first-run Chrome download) goes to
// stderr. Exits non-zero with a message on stderr on failure.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

const [, , projectDir, outPath, codecArg, qualityArg, gifFpsArg, gifCompressionArg] =
  process.argv;

if (!projectDir || !outPath) {
  process.stderr.write(
    "usage: render-mp4.mjs <projectDir> <outPath> [codec] [quality] [gifFps] [gifCompression]\n",
  );
  process.exit(2);
}

// Default to H.264 / high so older callers (and the 2-arg invocation) still work.
const codec = codecArg || "h264";
const quality = qualityArg || "high";
// GIF lossy-compression level (6th arg): none | light | strong. Applied as a
// gifsicle post-process after render (Remotion has no native lossy GIF option).
const gifCompression = gifCompressionArg || "none";
// GIF target frame rate (5th arg). Falsy/invalid -> 15, a sane shareable default.
const gifFps = (() => {
  const n = Number(gifFpsArg);
  return isFinite(n) && n > 0 ? n : 15;
})();

// Per-codec CRF (constant-rate-factor: lower = higher quality / bigger file). The
// ranges differ by codec, so keep the mapping here rather than in the caller. GIF
// has no CRF.
const CRF_BY_CODEC = {
  h264: { high: 18, medium: 23, low: 28 },
  h265: { high: 20, medium: 26, low: 32 },
  vp9: { high: 23, medium: 31, low: 40 },
};
const crf = CRF_BY_CODEC[codec]?.[quality];

// GIF quality -> output resolution scale only. Frame rate is controlled separately
// via gifFps (mapped to everyNthFrame below, once the source fps is known). Scale
// downscales the 1080x1920 composition -- the dominant file-size lever. Keep these
// in sync with GIF_SCALE_BY_QUALITY in src/components/RenderModal.tsx.
//   high -> 540x960,  medium -> 405x720,  low -> 270x480
const GIF_SCALE_BY_QUALITY = {
  high: 0.5,
  medium: 0.375,
  low: 0.25,
};
const gifScale =
  codec === "gif" ? GIF_SCALE_BY_QUALITY[quality] ?? GIF_SCALE_BY_QUALITY.high : null;

// Lossy gifsicle presets. `--lossy=N` perturbs LZW patterns to compress harder;
// `--colors` shrinks the palette. Higher = smaller file, more visible artifacts.
// Keep the levels in sync with the modal's Compression control.
const GIF_COMPRESS_ARGS = {
  light: ["--lossy=30"],
  strong: ["--lossy=100", "--colors", "64"],
};

// Post-process a rendered GIF in place with gifsicle. gifsicle is imported
// DYNAMICALLY and failures are swallowed: a missing binary (e.g. a shipped
// toolchain that didn't bundle it) or a non-zero exit must never fail the render
// -- we just keep the uncompressed GIF and note it on stderr.
async function compressGif(file, level) {
  const args = GIF_COMPRESS_ARGS[level];
  if (!args) return; // "none" or unknown -> no-op
  let gifsiclePath;
  try {
    gifsiclePath = (await import("gifsicle")).default;
  } catch {
    process.stderr.write(
      "gifsicle not available; skipping lossy GIF compression\n",
    );
    return;
  }
  const tmp = `${file}.gifsicle.tmp`;
  const res = spawnSync(gifsiclePath, [...args, "-O3", "-o", tmp, file], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (res.status === 0 && fs.existsSync(tmp)) {
    fs.renameSync(tmp, file);
  } else {
    fs.rmSync(tmp, { force: true });
    process.stderr.write(
      `gifsicle exited ${res.status}; keeping uncompressed GIF\n`,
    );
  }
}

const animationPath = path.join(projectDir, "animation.tsx");
if (!fs.existsSync(animationPath)) {
  process.stderr.write(`animation.tsx not found in ${projectDir}\n`);
  process.exit(1);
}

// Write a throwaway Remotion entry that registers a single <Composition> wrapping
// the project's animation, reading fps/duration the same way the preview does.
// Kept in the repo's scripts dir (a sibling of this file) so its relative imports
// of `remotion` / `react` resolve from the repo node_modules; the animation is
// imported by absolute path.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.join(
  scriptDir,
  `.render-entry-${process.pid}-${Date.now()}.tsx`,
);

const entrySource = `import React from "react";
import { Composition, registerRoot } from "remotion";
import * as Animation from ${JSON.stringify(animationPath)};

const WIDTH = 1080;
const HEIGHT = 1920;
const DEFAULT_FPS = 30;
const DEFAULT_DURATION_IN_FRAMES = 150;

// A valid override is a finite number > 0; duration is floored to a whole frame.
function resolvePositive(value, fallback, floor) {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n) || n <= 0) return fallback;
  return floor ? Math.floor(n) : n;
}

const cfg =
  Animation.config && typeof Animation.config === "object" ? Animation.config : {};
const fps = resolvePositive(
  Animation.fps !== undefined ? Animation.fps : cfg.fps,
  DEFAULT_FPS,
  false,
);
const durationInFrames = resolvePositive(
  Animation.durationInFrames !== undefined
    ? Animation.durationInFrames
    : cfg.durationInFrames,
  DEFAULT_DURATION_IN_FRAMES,
  true,
);

const Component = Animation.default;

const Root = () => (
  <Composition
    id="main"
    component={Component}
    durationInFrames={durationInFrames}
    fps={fps}
    width={WIDTH}
    height={HEIGHT}
  />
);

registerRoot(Root);
`;

async function main() {
  fs.writeFileSync(entryPath, entrySource);
  try {
    const serveUrl = await bundle({
      entryPoint: entryPath,
      // No publicDir: animations never reference external assets.
      onProgress: () => {},
    });

    const composition = await selectComposition({
      serveUrl,
      id: "main",
      inputProps: {},
    });

    // For a GIF, render every Nth source frame to approach the requested gifFps:
    // round(sourceFps / targetFps), floored at 1 (a target above the source can't
    // add frames). composition.fps is the animation's resolved source fps.
    const gifEveryNthFrame =
      gifScale != null ? Math.max(1, Math.round(composition.fps / gifFps)) : null;

    await renderMedia({
      serveUrl,
      composition,
      codec,
      ...(crf != null ? { crf } : {}),
      ...(gifScale != null
        ? {
            scale: gifScale,
            everyNthFrame: gifEveryNthFrame,
            numberOfGifLoops: 0, // 0 = loop forever
          }
        : {}),
      outputLocation: outPath,
      inputProps: {},
      onProgress: ({ progress }) => {
        process.stdout.write(`PROGRESS ${progress}\n`);
      },
    });

    // Lossy post-process for GIF (after the frames are written). Best-effort:
    // never fails the render (see compressGif).
    if (gifScale != null && gifCompression !== "none") {
      await compressGif(outPath, gifCompression);
    }

    process.stdout.write(`PROGRESS 1\n`);
    process.stdout.write(`DONE ${pathToFileURL(outPath).href}\n`);
  } finally {
    fs.rmSync(entryPath, { force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
