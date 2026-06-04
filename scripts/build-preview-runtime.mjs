// Builds the OFFLINE preview runtime for the Remotion sandbox (charm T-026).
//
// The sandbox iframe must run with NO network access (CSP connect-src 'none') and
// NO CDN. This script bundles everything the preview needs into src-tauri/resources/
// so the frontend can inline/serve it locally:
//
//   preview-runtime.js          IIFE exposing window.RemotionRuntime = remotion + Player
//   react.production.min.js      React 18 UMD prod build (-> window.React)
//   react-dom.production.min.js  ReactDOM 18 UMD prod build (-> window.ReactDOM, has createRoot)
//   esbuild.wasm                 esbuild-wasm binary, version-matched to the worker's JS API
//
// Why bundled locally (do NOT revert to a CDN/UMD approach):
//   - @remotion/player ships NO UMD build (only CJS + ESM); there is no window.RemotionPlayer.
//   - Tauri on macOS is WKWebView (WebKit); ESM importmaps in sandboxed iframes are buggy there.
// So we esbuild @remotion/player + remotion into a single IIFE with react/react-dom external
// (mapped to window globals), and ship React's real UMD builds alongside it.
//
// Runs as an npm predev/prebuild step. Keep react / react-dom / @remotion/player / remotion
// versions in lockstep -- the bundle and the copied UMD files must all agree.

import { build } from "esbuild";
import { createRequire } from "node:module";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const outDir = resolve(projectRoot, "src-tauri", "resources");

// react / react-dom / react/jsx-runtime are provided at runtime by the React UMD globals
// loaded into the sandbox iframe. esbuild has no rollup-style `globals` option, so we resolve
// these bare specifiers to tiny CJS stubs that re-export the window globals. esbuild's CJS
// interop then wires every `import { x } from 'react'` to `window.React.x` at runtime.
const reactGlobalsPlugin = {
  name: "react-globals",
  setup(pluginBuild) {
    const filter = /^(react|react-dom|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime)$/;
    pluginBuild.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: "react-globals",
    }));

    pluginBuild.onLoad({ filter: /.*/, namespace: "react-globals" }, (args) => {
      let contents;
      switch (args.path) {
        case "react":
          contents = "module.exports = window.React;";
          break;
        case "react-dom":
        case "react-dom/client":
          // React 18 UMD react-dom exposes createRoot on window.ReactDOM.
          contents = "module.exports = window.ReactDOM;";
          break;
        case "react/jsx-runtime":
          // React 18 UMD has no jsx/jsxs; shim them onto React.createElement.
          contents = `
            var React = window.React;
            function jsx(type, props, key) {
              var config = {};
              var children;
              if (props) {
                for (var k in props) {
                  if (k === "children") { children = props[k]; }
                  else { config[k] = props[k]; }
                }
              }
              if (key !== undefined) config.key = key;
              return children === undefined
                ? React.createElement(type, config)
                : React.createElement(type, config, children);
            }
            module.exports = { jsx: jsx, jsxs: jsx, Fragment: React.Fragment };
          `;
          break;
        case "react/jsx-dev-runtime":
          contents = `
            var React = window.React;
            function jsxDEV(type, props, key) {
              var config = {};
              var children;
              if (props) {
                for (var k in props) {
                  if (k === "children") { children = props[k]; }
                  else { config[k] = props[k]; }
                }
              }
              if (key !== undefined) config.key = key;
              return children === undefined
                ? React.createElement(type, config)
                : React.createElement(type, config, children);
            }
            module.exports = { jsxDEV: jsxDEV, Fragment: React.Fragment };
          `;
          break;
        default:
          contents = "module.exports = {};";
      }
      return { contents, loader: "js" };
    });
  },
};

// Entry: re-export the whole remotion core API plus the Player so generated animations
// (which import from 'remotion' and '@remotion/player') can bind everything off
// window.RemotionRuntime. Built as an in-memory stdin module to avoid a temp file.
const entry = [
  'export * from "remotion";',
  'export { Player, Thumbnail } from "@remotion/player";',
].join("\n");

async function run() {
  await mkdir(outDir, { recursive: true });

  await build({
    stdin: {
      contents: entry,
      resolveDir: projectRoot,
      loader: "js",
    },
    bundle: true,
    format: "iife",
    globalName: "RemotionRuntime",
    platform: "browser",
    target: "es2020",
    minify: true,
    // Remotion checks process.env.NODE_ENV; define it so the prod path is taken and
    // no `process` global is referenced at runtime in the sandbox.
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [reactGlobalsPlugin],
    outfile: resolve(outDir, "preview-runtime.js"),
    legalComments: "none",
    logLevel: "info",
  });

  // Copy React's real UMD prod builds + the version-matched esbuild.wasm.
  // React/ReactDOM block their UMD files behind the package `exports` map, so resolve
  // each package's own package.json and join the subpath off its directory instead.
  const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
  const copies = [
    [resolve(pkgDir("react"), "umd", "react.production.min.js"), "react.production.min.js"],
    [resolve(pkgDir("react-dom"), "umd", "react-dom.production.min.js"), "react-dom.production.min.js"],
    [resolve(pkgDir("esbuild-wasm"), "esbuild.wasm"), "esbuild.wasm"],
  ];
  for (const [from, name] of copies) {
    await copyFile(from, resolve(outDir, name));
  }

  // Drop a tiny manifest so it's obvious these are generated artifacts.
  const pkg = require(resolve(projectRoot, "package.json"));
  await writeFile(
    resolve(outDir, "preview-runtime.versions.json"),
    JSON.stringify(
      {
        generatedBy: "scripts/build-preview-runtime.mjs",
        react: pkg.dependencies.react,
        "react-dom": pkg.dependencies["react-dom"],
        "@remotion/player": pkg.dependencies["@remotion/player"],
        remotion: pkg.dependencies.remotion,
        "esbuild-wasm": pkg.dependencies["esbuild-wasm"],
      },
      null,
      2,
    ) + "\n",
  );

  console.log("[build-preview-runtime] wrote preview runtime to", outDir);
}

run().catch((err) => {
  console.error("[build-preview-runtime] FAILED:", err);
  process.exit(1);
});
