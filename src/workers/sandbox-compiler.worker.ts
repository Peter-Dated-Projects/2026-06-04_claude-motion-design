// Sandbox compiler worker (charm T-026; multi-file bundle T-067).
//
// Compiles a generated Remotion project (one or more TSX/TS files) into a classic-runtime
// IIFE that the preview iframe runs via a blob-URL <script>. Runs OFF the main thread so a
// heavy first esbuild-wasm init (loads a ~12 MB wasm) never janks the UI.
//
// Key design points (see PLAN.md T-IMPL-007 / the preview-sandbox KB note):
//   - esbuild runs in BUNDLE mode (esbuild.build) with a VIRTUAL-FS plugin so relative
//     imports (`./theme`, `../motion`, `./components/X`) resolve at preview time against the
//     in-memory file map the frontend posts. There is no real filesystem in the worker; the
//     plugin's onResolve/onLoad serve every module from `files`.
//   - The allow-listed BARE imports (react / react-dom / react-dom/client / remotion /
//     @remotion/player) are NOT bundled: `bindImportsToGlobals` rewrites them to const
//     bindings off the sandbox's window globals (window.React / window.RemotionRuntime)
//     inside the plugin's onLoad, BEFORE esbuild parses each file. So esbuild's resolver
//     only ever sees relative imports. This preserves the single-file behavior byte-for-byte.
//   - Any bare specifier that SURVIVES the rewrite (i.e. not in the allow-list) hits
//     onResolve with no relative prefix and no file-map match -> a hard, specific error
//     naming the offending specifier, rather than a silent break.
//   - JSX uses the CLASSIC runtime (React.createElement) so the compiled code references the
//     `React` global directly -- no jsx-runtime import to resolve.
//   - Output is an IIFE assigned to globalName `AnimationExports`, so the iframe reads the
//     default export off window.AnimationExports.default.

import * as esbuild from "esbuild-wasm";
// The esbuild.wasm binary is shipped locally as a Tauri resource and surfaced to the
// frontend by Vite as a hashed asset URL -- nothing is fetched from a CDN.
import wasmURL from "../../src-tauri/resources/esbuild.wasm?url";

// DedicatedWorkerGlobalScope is not in the project's TS lib set (DOM only), so describe
// just the slice of the worker global we use.
const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (msg: unknown) => void;
};

// The frontend posts a COMPLETE in-memory snapshot of the project's `.ts`/`.tsx` files,
// keyed by project-relative forward-slash path (e.g. `animation.tsx`, `theme.ts`,
// `components/AnimatedWord.tsx`). `entry` is the file esbuild bundles from; it defaults to
// `animation.tsx`. No `code` field anymore -- this is a hard cutover (single caller).
type CompileRequest = {
  type: "compile";
  files: Record<string, string>;
  entry?: string;
  id?: number;
};
type CompileResult =
  | { type: "compiled"; bundle: string; id?: number }
  | { type: "error"; message: string; id?: number };

const DEFAULT_ENTRY = "animation.tsx";

// Out-of-band progress log. The render-log drawer is the one place preview events are
// visible, but it only gets entries when a message arrives -- so the slow, failure-prone
// esbuild-wasm init (fetch + compile a ~12 MB binary) used to run dead silent. These
// untagged log messages (no `id`, so PreviewPanel never gates them by compile generation)
// narrate that init and surface exactly where a hang or failure lands.
function emitLog(level: "info" | "warn" | "error", message: string): void {
  ctx.postMessage({ type: "log", level, message });
}

// Bare module specifiers the generated animation may import, mapped to the runtime globals
// the sandbox iframe loads. Everything Remotion/Player exports lives on window.RemotionRuntime.
const GLOBAL_FOR: Record<string, string> = {
  react: "window.React",
  "react-dom": "window.ReactDOM",
  "react-dom/client": "window.ReactDOM",
  remotion: "window.RemotionRuntime",
  "@remotion/player": "window.RemotionRuntime",
};

const KNOWN_MODULES = Object.keys(GLOBAL_FOR)
  .map((m) => m.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"))
  .join("|");

// Matches a single ES import statement for one of the known bare modules. Captures the
// clause between `import` and `from` (default / named / namespace), or nothing for a
// side-effect-only import.
const IMPORT_RE = new RegExp(
  `import\\s+(?:([^'"]+?)\\s+from\\s+)?['"](${KNOWN_MODULES})['"];?`,
  "g",
);

// Rewrite a single import clause into const bindings off the given global object.
// Handles: `React`, `React, { a, b as c }`, `{ a, b as c }`, `* as NS`, and bare side-effect.
function rewriteClause(clause: string | undefined, globalRef: string): string {
  if (!clause) return ""; // side-effect import -> nothing to bind

  const trimmed = clause.trim();
  const lines: string[] = [];

  // Namespace import: * as NS
  const nsMatch = trimmed.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (nsMatch) {
    return `const ${nsMatch[1]} = ${globalRef};`;
  }

  // Split a possible default + named-group clause: `Default, { a, b }`
  const bracePos = trimmed.indexOf("{");
  const defaultPart = (bracePos === -1 ? trimmed : trimmed.slice(0, bracePos))
    .replace(/,\s*$/, "")
    .trim();
  if (defaultPart) {
    // UMD React's default IS the namespace; fall back to the global itself.
    lines.push(`const ${defaultPart} = ${globalRef}.default ?? ${globalRef};`);
  }

  if (bracePos !== -1) {
    const inner = trimmed.slice(bracePos + 1, trimmed.lastIndexOf("}"));
    const names = inner
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      // `a as b` -> `a: b` for destructuring.
      .map((s) => s.replace(/\s+as\s+/, ": "));
    if (names.length) {
      lines.push(`const { ${names.join(", ")} } = ${globalRef};`);
    }
  }

  return lines.join("\n");
}

// Strip + rewrite all known bare imports to global bindings, so the bundled output
// (whose allow-listed deps are NOT bundled) references the sandbox's window globals instead.
function bindImportsToGlobals(source: string): string {
  return source.replace(IMPORT_RE, (_full, clause: string | undefined, mod: string) =>
    rewriteClause(clause, GLOBAL_FOR[mod]),
  );
}

// ---- Virtual filesystem: resolve relative imports against the in-memory file map -------
//
// Paths are project-relative with forward slashes, matching `list_project_files` output.
// We resolve purely in JS (no node `path`, no FS) so resolution stays sandboxed and
// synchronous-friendly inside the esbuild plugin.

const VFS_NAMESPACE = "vfs";

// Drop the trailing path segment. Root-level files (no slash) have dir "".
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

// Normalize a forward-slash path, collapsing `.` / `..` segments. No leading slash.
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

// Strip a leading `./` (and surrounding whitespace) from an entry specifier so the map key
// matches `list_project_files` output (`animation.tsx`, not `./animation.tsx`).
function entryKey(entry: string): string {
  return normalizePath(entry.trim());
}

// Resolve a relative specifier (`./theme`, `../motion`, `./components/X`) imported from
// `importer` against the file map, trying esbuild-like extension/index candidates in order.
// Returns the matching map key, or null if nothing matches (caller emits a clear error).
function resolveRelative(
  importer: string,
  spec: string,
  files: Record<string, string>,
): string | null {
  const base = dirOf(importer);
  const joined = normalizePath(base ? `${base}/${spec}` : spec);
  const candidates = [
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}/index.ts`,
    `${joined}/index.tsx`,
  ];
  for (const candidate of candidates) {
    if (candidate in files) return candidate;
  }
  return null;
}

// Build the esbuild plugin that serves every module from the in-memory `files` map. All
// resolution is synchronous and FS-free: onResolve maps specifiers to vfs paths (or errors),
// onLoad returns the file's contents with bare imports already rewritten to window globals.
function virtualFsPlugin(files: Record<string, string>): esbuild.Plugin {
  return {
    name: "virtual-fs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // The entry point: esbuild asks us to resolve it first (no importer).
        if (args.kind === "entry-point") {
          const key = entryKey(args.path);
          if (!(key in files)) {
            return { errors: [{ text: `Entry file '${key}' is not in the project file map.` }] };
          }
          return { path: key, namespace: VFS_NAMESPACE };
        }
        // Relative import: resolve against the file map with extension/index fallback.
        if (args.path.startsWith("./") || args.path.startsWith("../")) {
          const resolved = resolveRelative(args.importer, args.path, files);
          if (resolved === null) {
            return {
              errors: [
                {
                  text: `Cannot resolve '${args.path}' from '${args.importer}'. No matching .ts/.tsx (or /index) file in the project.`,
                },
              ],
            };
          }
          return { path: resolved, namespace: VFS_NAMESPACE };
        }
        // A bare specifier that survived bindImportsToGlobals -> not in the allow-list.
        return {
          errors: [
            {
              text: `Disallowed import '${args.path}'. Only relative imports and the bundled runtime modules (react, react-dom, react-dom/client, remotion, @remotion/player) are allowed in the preview.`,
            },
          ],
        };
      });

      build.onLoad({ filter: /.*/, namespace: VFS_NAMESPACE }, (args) => {
        const source = files[args.path];
        if (source === undefined) {
          return { errors: [{ text: `Cannot load '${args.path}': missing from the project file map.` }] };
        }
        // Rewrite allow-listed bare imports to window-global consts BEFORE esbuild parses,
        // so the resolver only ever sees relative imports.
        return { contents: bindImportsToGlobals(source), loader: "tsx" };
      });
    },
  };
}

// Cap the one-time esbuild-wasm init. The wasm ships locally (Tauri resource /
// Vite-hashed asset), so a healthy load is sub-second; if it has not finished in
// this window something is wrong (a hung or 404'd asset fetch) and we reject
// loudly rather than leave the preview stranded on "Compiling preview..." forever.
const INIT_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Fetch the wasm bytes explicitly instead of handing esbuild the URL and letting
// it fetch internally. Under Tauri's asset protocol an internal fetch that 404s,
// returns the wrong MIME type, or hangs can leave initialize() pending forever
// with no error surfaced. Doing the fetch here means those failures become real
// rejections (which the onmessage catch turns into a {type:'error'} reply), and
// compiling from bytes sidesteps the streaming-compile MIME requirement.
async function initEsbuild(): Promise<void> {
  emitLog("info", `esbuild-wasm: fetching binary from ${wasmURL}`);
  const res = await fetch(wasmURL);
  if (!res.ok) {
    throw new Error(
      `Failed to load esbuild.wasm (${res.status} ${res.statusText}) from ${wasmURL}`,
    );
  }
  const bytes = await res.arrayBuffer();
  emitLog("info", `esbuild-wasm: fetched ${bytes.byteLength} bytes, compiling module...`);
  const wasmModule = await WebAssembly.compile(bytes);
  emitLog("info", "esbuild-wasm: module compiled, initializing...");
  await esbuild.initialize({ wasmModule, worker: false });
  emitLog("info", "esbuild-wasm: ready");
}

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) {
    // On failure, clear the cached promise so a later compile retries instead of
    // re-awaiting a permanently-rejected init.
    initPromise = withTimeout(initEsbuild(), INIT_TIMEOUT_MS, "esbuild-wasm init").catch(
      (err) => {
        initPromise = null;
        throw err;
      },
    );
  }
  return initPromise;
}

// esbuild-wasm with `worker:false` runs the build on this single thread's one wasm
// instance and is NOT safe for overlapping build calls -- two in flight at once can
// DEADLOCK, so the second `compile` never produces a `compiled`/`error` reply and the
// preview overlay sticks forever. We therefore single-flight all builds: `pending` holds
// the latest unprocessed request and `processing` guards the drain loop, so only one
// esbuild.build ever runs at a time. (build() is the same single-wasm-instance call that
// transform() was, so this guard covers it unchanged -- no second concurrent build path.)
let pending: CompileRequest | null = null;
let processing = false;

async function compileOne(req: CompileRequest): Promise<CompileResult> {
  try {
    await ensureInit();
    const files = req.files ?? {};
    const entry = entryKey(req.entry ?? DEFAULT_ENTRY);
    emitLog(
      "info",
      `bundling ${Object.keys(files).length} file(s) from '${entry}'...`,
    );
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "AnimationExports",
      jsx: "transform", // classic runtime -> React.createElement on the window global
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      plugins: [virtualFsPlugin(files)],
      // Surface diagnostics through our catch (the thrown BuildFailure message), not stdout.
      logLevel: "silent",
    });
    const output = result.outputFiles?.[0]?.text;
    if (output === undefined) {
      return { type: "error", message: "esbuild produced no output.", id: req.id };
    }
    return { type: "compiled", bundle: output, id: req.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { type: "error", message, id: req.id };
  }
}

async function drain(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (pending) {
      const req = pending;
      pending = null;
      const result = await compileOne(req);
      // Coalesce: if a newer compile arrived while this one ran, the result is
      // stale -- skip posting it and let the loop process the latest request. The
      // newest request is the only one whose result the UI still cares about.
      if (pending) continue;
      ctx.postMessage(result);
    }
  } finally {
    processing = false;
  }
}

ctx.onmessage = (ev: MessageEvent) => {
  const data = ev.data as CompileRequest;
  if (!data || data.type !== "compile") return;
  // Overwrite any not-yet-started request: only the latest source matters.
  pending = data;
  void drain();
};
