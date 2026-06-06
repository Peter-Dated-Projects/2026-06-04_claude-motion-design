// Build the downloadable MP4-render toolchain archive (charm: shippable Export MP4).
//
// The app ships small; the first time a user renders MP4, it downloads this
// archive and unpacks it into app-data (see src-tauri/src/commands/render_toolchain.rs).
// The archive is self-contained: a Node binary + the Remotion render deps +
// render-mp4.mjs, so the app can render with nothing installed on the machine.
//
// THIS SCRIPT IS RUN BY A MAINTAINER (you), not the app. Steps:
//   1. node scripts/build-render-toolchain.mjs
//   2. Upload the printed .tar.gz as a release asset.
//   3. Paste the printed URL + sha256 + sizeMb into TOOLCHAIN in render_toolchain.rs.
//
// Platform: macOS arm64 only for now. The Node binary is copied from the Node
// running this script, so RUN IT WITH A macOS arm64 Node. Other platforms need
// their own Node + their own @remotion/compositor-<platform> and are a later step.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error(
    `This build targets macOS arm64; this Node is ${process.platform}/${process.arch}. Aborting.`,
  );
  process.exit(1);
}

// The toolchain version is the Remotion version it renders with -- all
// @remotion/* packages must match or Remotion throws at render time. Keep this
// in lockstep with the repo's remotion dependency.
const REMOTION_VERSION = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "node_modules/remotion/package.json")),
).version;
const REACT_VERSION = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "node_modules/react/package.json")),
).version;

const PLATFORM = "darwin-arm64";
const outDir = path.join(repoRoot, "dist-toolchain");
const stageDir = path.join(outDir, `stage-${PLATFORM}`);
const archiveName = `render-toolchain-${REMOTION_VERSION}-${PLATFORM}.tar.gz`;
const archivePath = path.join(outDir, archiveName);

console.log(`Building render toolchain ${REMOTION_VERSION} for ${PLATFORM}`);
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stageDir, "bin"), { recursive: true });

// 1. Node binary (self-contained mach-o) -- copied from the Node running this script.
const nodeBin = path.join(stageDir, "bin", "node");
fs.copyFileSync(process.execPath, nodeBin);
fs.chmodSync(nodeBin, 0o755);
console.log(`  node: copied ${process.execPath} (${process.version})`);

// 2. Render deps installed into the stage's own node_modules. Pinned to exact
//    versions so the archive is reproducible and all @remotion/* stay aligned.
const pkg = {
  name: "claude-motion-render-toolchain",
  private: true,
  version: REMOTION_VERSION,
  dependencies: {
    remotion: REMOTION_VERSION,
    "@remotion/player": REMOTION_VERSION,
    "@remotion/bundler": REMOTION_VERSION,
    "@remotion/renderer": REMOTION_VERSION,
    react: REACT_VERSION,
    "react-dom": REACT_VERSION,
  },
};
fs.writeFileSync(
  path.join(stageDir, "package.json"),
  JSON.stringify(pkg, null, 2),
);
console.log("  npm install --omit=dev (render closure)...");
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: stageDir,
  stdio: "inherit",
});

// 3. The render script itself.
fs.copyFileSync(
  path.join(scriptDir, "render-mp4.mjs"),
  path.join(stageDir, "render-mp4.mjs"),
);

// 4. Archive (system tar -> preserves perms + symlinks in node_modules/.bin).
fs.rmSync(archivePath, { force: true });
console.log("  tar -czf ...");
execFileSync("tar", ["-czf", archivePath, "-C", stageDir, "."], {
  stdio: "inherit",
});

// 5. Report sha256 + size for the manifest.
const bytes = fs.readFileSync(archivePath);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const sizeMb = (bytes.length / (1024 * 1024)).toFixed(1);

console.log("\nToolchain archive built:");
console.log(`  file:    ${archivePath}`);
console.log(`  sha256:  ${sha256}`);
console.log(`  sizeMb:  ${sizeMb}`);
console.log(`  version: ${REMOTION_VERSION}`);
console.log(
  "\nNext: upload it as a release asset, then paste url + sha256 + sizeMb into\n" +
    "TOOLCHAIN in src-tauri/src/commands/render_toolchain.rs.",
);
