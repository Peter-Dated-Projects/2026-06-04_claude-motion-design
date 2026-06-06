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
// Usage: node scripts/render-mp4.mjs <projectDir> <outPath>
// Progress is emitted to stdout as `PROGRESS <0..1>` lines for the caller to
// parse; everything else (Remotion logs, the first-run Chrome download) goes to
// stderr. Exits non-zero with a message on stderr on failure.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

const [, , projectDir, outPath] = process.argv;

if (!projectDir || !outPath) {
  process.stderr.write("usage: render-mp4.mjs <projectDir> <outPath>\n");
  process.exit(2);
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

    await renderMedia({
      serveUrl,
      composition,
      codec: "h264",
      outputLocation: outPath,
      inputProps: {},
      onProgress: ({ progress }) => {
        process.stdout.write(`PROGRESS ${progress}\n`);
      },
    });

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
