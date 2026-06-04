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

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = esbuild.initialize({ wasmURL, worker: false });
  }
  return initPromise;
}

ctx.onmessage = async (ev: MessageEvent) => {
  const data = ev.data as CompileRequest;
  if (!data || data.type !== "compile") return;

  try {
    await ensureInit();
    const prepared = bindImportsToGlobals(data.code);
    const result = await esbuild.transform(prepared, {
      loader: "tsx",
      format: "iife",
      globalName: "AnimationExports",
      jsx: "transform", // classic runtime -> React.createElement on the window global
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
    });
    const msg: CompileResult = { type: "compiled", bundle: result.code, id: data.id };
    ctx.postMessage(msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const msg: CompileResult = { type: "error", message, id: data.id };
    ctx.postMessage(msg);
  }
};
