// Build the downloadable render + IG-pipeline toolchain archive (charm: shippable
// Export MP4 + the Instagram reel->brief pipeline).
//
// The app ships small; the first time a user renders MP4 (or runs the IG
// pipeline) it downloads this archive and unpacks it into app-data
// (see src-tauri/src/commands/render_toolchain.rs). The archive is
// self-contained:
//   - a Node binary + the Remotion render deps + render-mp4.mjs (MP4 render), and
//   - the four external CLIs the Bun IG pipeline spawns by bare name off PATH:
//     `bun`, `yt-dlp`, `ffmpeg`, `ffprobe`.
// All live in bin/, so a single PATH entry (toolchain_bin_dir) covers everything.
//
// THIS SCRIPT IS RUN BY A MAINTAINER (you), not the app. Steps:
//   1. node scripts/build-render-toolchain.mjs
//   2. Upload the printed .tar.gz as a release asset.
//   3. Paste the printed URL + sha256 + sizeMb + version into TOOLCHAIN in
//      render_toolchain.rs.
//
// Platform: macOS arm64 only for now. The Node binary is copied from the Node
// running this script, so RUN IT WITH A macOS arm64 Node. The fetched CLIs are
// pinned darwin-arm64 builds (see TOOLS below). The script SELF-VERIFIES each
// fetched binary at build time (correct arch + runs --version) and aborts if a
// download URL has drifted or returns the wrong arch -- so a stale pin surfaces
// here, not on a user's machine. Other platforms need their own Node +
// @remotion/compositor-<platform> + per-OS CLI builds and are a later step.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

// The render side is versioned by the Remotion version it renders with -- all
// @remotion/* packages must match or Remotion throws at render time. Keep this
// in lockstep with the repo's remotion dependency.
const REMOTION_VERSION = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "node_modules/remotion/package.json")),
).version;
const REACT_VERSION = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "node_modules/react/package.json")),
).version;

// Bump this whenever the archive CONTENTS change without the Remotion version
// changing (e.g. re-pinning a CLI below). It is what makes existing installs
// re-fetch: the toolchain version (and thus the install dir) is keyed on it, so
// a contents-only rebuild that kept the same Remotion version would otherwise
// never invalidate a user's already-installed dir. See render_toolchain.rs's
// version note. Must match the `-r<N>` suffix in TOOLCHAIN.version there.
const TOOLCHAIN_REVISION = 2;
const VERSION = `${REMOTION_VERSION}-r${TOOLCHAIN_REVISION}`;

// Pinned darwin-arm64 builds of the four CLIs the IG pipeline spawns. Each is a
// single self-contained mach-o (or a zip/archive holding one). Pin EXACT
// versions for a reproducible sha256. The script verifies arch + --version after
// unpack; if a URL 404s or serves the wrong arch, fix the entry here.
//
// Licenses (confirm acceptable for redistribution in the combined archive before
// hosting publicly): bun = MIT; yt-dlp = Unlicense; ffmpeg/ffprobe static builds
// are typically GPL.
const TOOLS = [
  {
    name: "bun",
    version: "1.1.42",
    // Release zip contains `bun-darwin-aarch64/bun`.
    url: "https://github.com/oven-sh/bun/releases/download/bun-v1.1.42/bun-darwin-aarch64.zip",
    archive: "zip",
    member: "bun-darwin-aarch64/bun",
    versionArgs: ["--version"],
  },
  {
    name: "yt-dlp",
    // yt-dlp uses date-based versions. Standalone single-file macOS build (no
    // Python dependency). Pinned to the version the IG pipeline was validated
    // against -- Instagram extractors break often, so do not regress this pin.
    version: "2026.03.17",
    url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.03.17/yt-dlp_macos",
    archive: "raw",
    versionArgs: ["--version"],
  },
  {
    name: "ffmpeg",
    // Static darwin-arm64 build. evermeet.cx serves per-binary zips; confirm the
    // served arch is arm64 (the build self-checks). Pin the exact release.
    version: "7.1",
    url: "https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip",
    archive: "zip",
    member: "ffmpeg",
    versionArgs: ["-version"],
  },
  {
    name: "ffprobe",
    version: "7.1",
    url: "https://evermeet.cx/ffmpeg/ffprobe-7.1.zip",
    archive: "zip",
    member: "ffprobe",
    versionArgs: ["-version"],
  },
];

const PLATFORM = "darwin-arm64";
const outDir = path.join(repoRoot, "dist-toolchain");
const stageDir = path.join(outDir, `stage-${PLATFORM}`);
const archiveName = `render-toolchain-${VERSION}-${PLATFORM}.tar.gz`;
const archivePath = path.join(outDir, archiveName);

console.log(`Building render toolchain ${VERSION} for ${PLATFORM}`);
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stageDir, "bin"), { recursive: true });

// 1. Node binary (self-contained mach-o) -- copied from the Node running this script.
const nodeBin = path.join(stageDir, "bin", "node");
fs.copyFileSync(process.execPath, nodeBin);
fs.chmodSync(nodeBin, 0o755);
console.log(`  node: copied ${process.execPath} (${process.version})`);

// 1b. The IG-pipeline CLIs: bun + yt-dlp + ffmpeg + ffprobe, fetched as pinned
//     darwin-arm64 builds into the same bin/ dir, then self-verified.
const binDir = path.join(stageDir, "bin");

/** Stream a URL to a file (follows redirects; throws on non-2xx). */
async function download(url, destFile) {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`GET ${url} -> HTTP ${resp.status} ${resp.statusText}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destFile, buf);
}

/** Assert a mach-o binary is arm64 and runnable; throws with context if not. */
function verifyBinary(name, file, versionArgs) {
  // Arch check: `lipo -archs` prints the architectures in the mach-o.
  let archs;
  try {
    archs = execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim();
  } catch (e) {
    throw new Error(`${name}: not a mach-o binary or unreadable (${e.message})`);
  }
  if (!archs.split(/\s+/).includes("arm64")) {
    throw new Error(
      `${name}: built for [${archs}], not arm64. Re-pin TOOLS["${name}"] to a darwin-arm64 build.`,
    );
  }
  // Run check: must execute and exit (any code) without a spawn/Gatekeeper error.
  try {
    execFileSync(file, versionArgs, { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    // A non-zero exit is fine (proves it ran); ENOENT / signal / Gatekeeper is not.
    if (e.code === "ENOENT" || e.signal) {
      throw new Error(`${name}: failed to execute ${versionArgs.join(" ")} (${e.message})`);
    }
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-cli-"));
for (const tool of TOOLS) {
  const dest = path.join(binDir, tool.name);
  console.log(`  ${tool.name}: fetching ${tool.version} ...`);
  if (tool.archive === "raw") {
    await download(tool.url, dest);
  } else if (tool.archive === "zip") {
    const zipPath = path.join(tmpDir, `${tool.name}.zip`);
    await download(tool.url, zipPath);
    const unzipDir = path.join(tmpDir, tool.name);
    fs.rmSync(unzipDir, { recursive: true, force: true });
    fs.mkdirSync(unzipDir, { recursive: true });
    // -o overwrite, -j would flatten; we keep paths and copy the named member.
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", unzipDir], { stdio: "inherit" });
    fs.copyFileSync(path.join(unzipDir, tool.member), dest);
  } else {
    throw new Error(`${tool.name}: unsupported archive type "${tool.archive}"`);
  }
  fs.chmodSync(dest, 0o755);
  // Downloaded binaries can carry the quarantine xattr; strip it so Gatekeeper
  // doesn't block them when the app spawns them. Best-effort.
  try {
    execFileSync("xattr", ["-d", "com.apple.quarantine", dest], { stdio: "ignore" });
  } catch {
    // No quarantine xattr present -- fine.
  }
  verifyBinary(tool.name, dest, tool.versionArgs);
  console.log(`  ${tool.name}: ${tool.version} verified (arm64, runnable)`);
}
fs.rmSync(tmpDir, { recursive: true, force: true });

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
console.log(`  version: ${VERSION}`);
console.log(
  "\nNext: upload it as a release asset, then paste url + sha256 + sizeMb +\n" +
    "version into TOOLCHAIN in src-tauri/src/commands/render_toolchain.rs.",
);
