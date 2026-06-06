// Sandbox compiler worker (charm T-026).
//
// Compiles generated Remotion TSX into a classic-runtime IIFE that the preview iframe
// runs via a blob-URL <script>. Runs OFF the main thread so a heavy first esbuild-wasm
// init (loads a ~12 MB wasm) never janks the UI.
//
// Key design points (see PLAN.md T-IMPL-007 / the preview-sandbox KB note):
//   - esbuild runs in TRANSFORM mode, not bundle mode: it cannot resolve bare imports, so
//     we rewrite `import ... from 'react' | 'remotion' | '@remotion/player'` into const
//     bindings off the window globals the sandbox loads (window.React / window.RemotionRuntime)
//     BEFORE handing the source to esbuild.
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

type CompileRequest = { type: "compile"; code: string; id?: number };
type CompileResult =
  | { type: "compiled"; bundle: string; id?: number }
  | { type: "error"; message: string; id?: number };

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

// Strip + rewrite all known bare imports to global bindings, so the transformed output
// (which cannot resolve imports) references the sandbox's window globals instead.
function bindImportsToGlobals(source: string): string {
  return source.replace(IMPORT_RE, (_full, clause: string | undefined, mod: string) =>
    rewriteClause(clause, GLOBAL_FOR[mod]),
  );
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

// esbuild-wasm with `worker:false` runs the transform on this single thread's one
// wasm instance and is NOT safe for overlapping transform calls -- two in flight at
// once can DEADLOCK, so the second `compile` never produces a `compiled`/`error`
// reply and the preview overlay sticks forever. We therefore single-flight all
// transforms: `pending` holds the latest unprocessed request and `processing`
// guards the drain loop, so only one esbuild.transform ever runs at a time.
let pending: CompileRequest | null = null;
let processing = false;

async function compileOne(req: CompileRequest): Promise<CompileResult> {
  try {
    await ensureInit();
    emitLog("info", `transforming TSX (${req.code.length} chars)...`);
    const prepared = bindImportsToGlobals(req.code);
    const result = await esbuild.transform(prepared, {
      loader: "tsx",
      format: "iife",
      globalName: "AnimationExports",
      jsx: "transform", // classic runtime -> React.createElement on the window global
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
    });
    return { type: "compiled", bundle: result.code, id: req.id };
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
