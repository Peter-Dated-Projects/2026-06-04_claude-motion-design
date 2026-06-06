import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// The sandbox HTML shell + the three local runtime files are pulled in as raw strings and
// inlined into the iframe via srcdoc. Everything ships locally (no CDN); see
// scripts/build-preview-runtime.mjs and src/assets/sandbox-frame.html.
import sandboxFrameHtml from "../../assets/sandbox-frame.html?raw";
import reactRuntime from "../../../src-tauri/resources/react.production.min.js?raw";
import reactDomRuntime from "../../../src-tauri/resources/react-dom.production.min.js?raw";
import previewRuntime from "../../../src-tauri/resources/preview-runtime.js?raw";
import PhoneBezel, {
  BEZEL_OUTER_WIDTH,
  BEZEL_OUTER_HEIGHT,
} from "./PhoneBezel";
import SafeZoneOverlay from "./SafeZoneOverlay";
import ReplayControls from "./ReplayControls";
import RenderLogPanel from "./RenderLogPanel";
import {
  useUIStore,
  type SafeZonePlatform,
} from "../../store/uiStore";
import {
  createRenderLogStore,
  RenderLogProvider,
  selectErrorCount,
} from "../../store/renderLogStore";
import { ENTRY_FILE } from "../CodePanel/CodePanel";

const PLATFORM_OPTIONS: { value: SafeZonePlatform; label: string }[] = [
  { value: "universal", label: "Universal" },
  { value: "tiktok", label: "TikTok" },
  { value: "instagram", label: "Instagram" },
  { value: "youtube", label: "YouTube" },
];

const TOOLBAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderBottom: "1px solid #e0e0e0",
  flex: "0 0 auto",
};

const SELECT_STYLE: React.CSSProperties = {
  background: "#ffffff",
  color: "#333",
  border: "1px solid #cfcfcf",
  borderRadius: 4,
  padding: "3px 6px",
  fontSize: 12,
  fontFamily: "sans-serif",
};

const TOGGLE_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid #cfcfcf",
  borderRadius: 4,
  padding: "3px 8px",
  fontSize: 12,
  fontFamily: "sans-serif",
  cursor: "pointer",
};

// Eye / eye-off glyph for the Safe Zone toggle. Inline SVG (currentColor) rather than an
// emoji or icon-font dependency. `open` draws the eye; otherwise a slash crosses it out.
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx={12} cy={12} r={3} />
      {!open && <line x1={3} y1={3} x2={21} y2={21} />}
    </svg>
  );
}

// List/log glyph for the render-log toggle. Inline SVG (currentColor), matching the
// EyeIcon approach -- no icon-font dependency.
function LogIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      <line x1={8} y1={6} x2={21} y2={6} />
      <line x1={8} y1={12} x2={21} y2={12} />
      <line x1={8} y1={18} x2={21} y2={18} />
      <line x1={3} y1={6} x2={3.01} y2={6} />
      <line x1={3} y1={12} x2={3.01} y2={12} />
      <line x1={3} y1={18} x2={3.01} y2={18} />
    </svg>
  );
}

// Fallback animation shown when no project is open yet (empty code). Once a project's
// animation.tsx is loaded or Claude generates code, the parent passes it via `code`.
const SAMPLE_CODE = `import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

export default function Sample() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 12 } });
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ backgroundColor: '#0b0b14', justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ transform: \`scale(\${scale})\`, opacity, color: '#fff', fontFamily: 'sans-serif', fontSize: 120, fontWeight: 800 }}>
        Hello
      </div>
    </AbsoluteFill>
  );
}`;

// Inline a runtime file into a <script> body. The only sequence that can break out of an
// inline script is a literal "</script", so neutralize it; minified bundles can contain it
// inside string literals.
function inlineScript(code: string): string {
  return `<script>${code.replace(/<\/(script)/gi, "<\\/$1")}<\/script>`;
}

// Build the full iframe document once: the shell HTML with the runtime scripts injected.
function buildSrcDoc(): string {
  const runtime = [reactRuntime, reactDomRuntime, previewRuntime]
    .map(inlineScript)
    .join("\n");
  // Use a REPLACEMENT FUNCTION, not a string. With a string replacement, String.replace
  // interprets `$$`, `$&`, `` $` ``, `$'` as special patterns -- and minified React/Remotion
  // is full of them (e.g. React's `$$typeof`, minifier vars like `x$` before `&&`). A string
  // replacement would collapse `$$`->`$` and splice the matched `<!--RUNTIME-->` text in place
  // of every `$&`, corrupting the injected JS into syntax errors so the runtime globals never
  // get set ("Preview runtime failed to load."). A function's return value is inserted verbatim.
  return sandboxFrameHtml.replace("<!--RUNTIME-->", () => runtime);
}

type LogLevel = "info" | "warn" | "error";

type WorkerMessage =
  | { type: "compiled"; bundle: string; id?: number }
  | { type: "error"; message: string; id?: number }
  | { type: "log"; level: LogLevel; message: string };

type SandboxMessage =
  | { type: "sandboxReady" }
  | { type: "renderOk"; fps?: number; durationInFrames?: number }
  | { type: "renderError"; message: string }
  | { type: "runtimeError"; message: string }
  | { type: "log"; level: LogLevel; message: string }
  | {
      type: "frameUpdate";
      frame: number;
      totalFrames: number;
      fps?: number;
      isPlaying: boolean;
    };

// Height of the open render-log drawer.
const LOG_DRAWER_HEIGHT = 160;

// Defaults until the sandbox reports the animation's resolved fps. Must match the
// DEFAULT_FPS in sandbox-frame.html.
const DEFAULT_FPS = 30;

// How long to wait for a compile+render round-trip before declaring the preview
// stuck and offering a Retry. Two tiers, because the FIRST compile after launch also
// has to cover the one-time esbuild-wasm init -- fetching + compiling a ~12 MB binary,
// which the worker itself caps at 10s (INIT_TIMEOUT_MS in sandbox-compiler.worker.ts).
// A single 5s watchdog trips mid-init on a cold/slow machine and shows a false timeout
// while compilation is still legitimately in flight, so the cold tier sits comfortably
// above that 10s init cap. Once we've seen the first compiled bundle (proof esbuild is
// initialized), every later compile is sub-second, so we drop to the tight warm tier
// and a genuine hang still surfaces quickly. Keep COLD_WATCHDOG_MS > the worker's
// INIT_TIMEOUT_MS if either changes.
const COLD_WATCHDOG_MS = 13_000;
const WARM_WATCHDOG_MS = 5_000;

interface PreviewPanelProps {
  /** The project's complete `.ts`/`.tsx` snapshot, keyed by project-relative path
   *  (`animation.tsx`, `theme.ts`, `components/X.tsx`), owned by the parent (App).
   *  The compiler bundles from `animation.tsx`, resolving relative imports against
   *  this map. Empty/missing entry before a project is open -> falls back to
   *  SAMPLE_CODE so the preview is never blank. */
  files?: Record<string, string>;
  /** Legacy single-file source: just `animation.tsx`'s contents. Callers that don't
   *  assemble the full map (e.g. RenderModal's render-preview) pass this; it's wrapped
   *  into a one-entry map. Ignored when `files` is provided. NOTE: a single-file caller
   *  cannot preview an animation that imports relative project files -- pass `files`
   *  for multi-file support. */
  code?: string;
  /** Active two-pass generation phase (drives the trigger buttons' active state). */
  passMode?: "layout" | "motion" | null;
  /** Start a layout/motion pass. When omitted, the pass-trigger controls are hidden
   *  (e.g. RenderModal's render-preview, which has no live PTY session to drive). */
  onStartPass?: (mode: "layout" | "motion") => void;
  /** Compact mode for hosting inside another surface (e.g. RenderModal). Drops the
   *  Log toggle + the full render-log drawer so a compile error isn't shown twice --
   *  the in-preview error strip already carries the full message. */
  embedded?: boolean;
}

function PreviewPanel({ files, code, passMode, onStartPass, embedded }: PreviewPanelProps) {
  // Pre-built once; future code edits only re-post a compiled bundle, not a new srcdoc.
  const srcDoc = useMemo(buildSrcDoc, []);

  // The file map handed to the compiler. Prefer the full `files` map; fall back to the
  // legacy single-file `code`. When no project is open (no entry file, or an empty one),
  // fall back to a single-file sample so the preview is never blank. Memoized so an
  // unrelated re-render doesn't change identity and trigger a needless recompile.
  const source = useMemo<Record<string, string>>(() => {
    const map = files ?? (code !== undefined ? { [ENTRY_FILE]: code } : {});
    const entry = map[ENTRY_FILE];
    if (!entry || entry.trim().length === 0) {
      return { [ENTRY_FILE]: SAMPLE_CODE };
    }
    return map;
  }, [files, code]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Shown alongside the timeout error: lets the user re-kick a compile when the
  // watchdog gave up (see startCompile below).
  const [canRetry, setCanRetry] = useState(false);
  // Mirrors the sandbox's playback state, read passively from `frameUpdate` events.
  // Drives "auto-off on play": the safe-zone overlay hides while the animation runs.
  // ReplayControls (T-030) owns the actual playback commands; we only listen.
  const [isPlaying, setIsPlaying] = useState(false);
  // Resolved fps reported by the sandbox (the animation may export its own). Threaded
  // into ReplayControls so the time readout reflects the real frame rate, not 30.
  const [fps, setFps] = useState(DEFAULT_FPS);
  // Fit transform for the bezel stage: how much to scale the 1080x1920 + bezel chrome
  // down to the container, and the centering offset. `scale` is also handed to the
  // safe-zone overlay so its strokes/labels stay crisp inside the scaled space.
  const [fit, setFit] = useState({ scale: 1, offsetX: 0, offsetY: 0 });

  const { showSafeZone, safeZonePlatform, toggleSafeZone, setSafeZonePlatform } =
    useUIStore();

  // Render log: each PreviewPanel owns its own store so two live previews (the main
  // editor preview and RenderModal's export preview, mounted at once) don't share one
  // bucket and double-log every compile. Provided down to RenderLogPanel via context.
  // `add` is a stable zustand action, safe in effect deps.
  const logStoreRef = useRef<ReturnType<typeof createRenderLogStore>>();
  if (!logStoreRef.current) logStoreRef.current = createRenderLogStore();
  const useLogStore = logStoreRef.current;
  const logAdd = useLogStore((s) => s.add);
  const logErrorCount = useLogStore(selectErrorCount);
  const [showLog, setShowLog] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Latest compiled bundle, held until the sandbox reports it is ready to render.
  const pendingBundleRef = useRef<string | null>(null);
  const sandboxReadyRef = useRef(false);

  // Monotonic compile generation. Every source change (or retry) bumps it and tags
  // the worker `compile` with it, so a late reply for superseded code can be ignored
  // and can't clear/leave-set the loading state for the wrong generation.
  const generationRef = useRef(0);
  // Watchdog timer for the current generation. If neither renderOk/renderError nor a
  // worker error arrives in time, it clears the stuck "Compiling preview..." overlay.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flipped true once the worker returns its first compiled bundle -- proof the one-time
  // esbuild-wasm init finished. Picks the watchdog tier in startCompile: cold (covers
  // init) before, warm (tight) after.
  const warmedUpRef = useRef(false);

  const postToSandbox = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  // Start (or retry) a compile for the current source: bump the generation, reset
  // loading/error, post the tagged compile, and arm the watchdog. A compile+render
  // round-trip is normally well under a second; if nothing terminal arrives within
  // WATCHDOG_MS something hung (e.g. the compiler or sandbox never replied), so we
  // surface a timeout with a Retry instead of spinning forever.
  const startCompile = useCallback(() => {
    clearWatchdog();
    const gen = ++generationRef.current;
    setError(null);
    setCanRetry(false);
    setIsLoading(true);
    logAdd("info", "compile", "Compiling animation...");
    workerRef.current?.postMessage({
      type: "compile",
      files: source,
      entry: ENTRY_FILE,
      id: gen,
    });
    // Cold tier until the first bundle proves esbuild is initialized; tight after.
    const watchdogMs = warmedUpRef.current ? WARM_WATCHDOG_MS : COLD_WATCHDOG_MS;
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      setIsLoading(false);
      const msg = "Preview timed out -- the compiler or renderer did not respond.";
      logAdd("error", "watchdog", msg);
      setError(msg);
      setCanRetry(true);
      setShowLog(true);
    }, watchdogMs);
  }, [source, clearWatchdog, logAdd]);

  // --- Worker: TSX -> compiled IIFE -------------------------------------------------
  useEffect(() => {
    const worker = new Worker(
      new URL("../../workers/sandbox-compiler.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;

    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      const data = ev.data;
      // Out-of-band progress log from the worker (esbuild init / transform narration).
      // Untagged (no id), so it's never gated by generation below.
      if (data.type === "log") {
        logAdd(data.level, "compile", data.message);
        if (data.level === "error") setShowLog(true);
        return;
      }
      // Ignore replies for a superseded generation -- a newer source change has
      // already bumped the generation and posted its own compile.
      if (typeof data.id === "number" && data.id !== generationRef.current) return;
      if (data.type === "compiled") {
        // First compiled bundle proves esbuild-wasm finished initializing, so later
        // compiles no longer need the cold (init-covering) watchdog budget.
        warmedUpRef.current = true;
        setError(null);
        logAdd("info", "compile", `Compiled (${data.bundle.length} bytes)`);
        pendingBundleRef.current = data.bundle;
        if (sandboxReadyRef.current) {
          postToSandbox({ type: "render", bundle: data.bundle });
        } else {
          // We have a bundle but never saw the iframe's one-time `sandboxReady`.
          // This happens after a Fast-Refresh remount: refs reset to not-ready but
          // the memoized srcDoc iframe never reloads, so it never re-announces and
          // we'd deadlock here forever (the watchdog would trip every time). Ping
          // it; the sandbox re-posts `sandboxReady`, whose handler flushes the
          // bundle we just parked. Self-heals instead of stranding the preview.
          postToSandbox({ type: "ping" });
        }
        // Don't clear the watchdog yet -- the round-trip isn't done until the
        // sandbox reports renderOk/renderError.
      } else if (data.type === "error") {
        clearWatchdog();
        logAdd("error", "compile", data.message);
        setError(data.message);
        setIsLoading(false);
        setShowLog(true);
      }
    };
    worker.onerror = (ev) => {
      clearWatchdog();
      const msg = ev.message || "Compiler worker crashed.";
      logAdd("error", "compile", msg);
      setError(msg);
      setIsLoading(false);
      setShowLog(true);
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [postToSandbox, clearWatchdog, logAdd]);

  // --- Sandbox iframe -> parent messages --------------------------------------------
  useEffect(() => {
    const onMessage = (ev: MessageEvent<SandboxMessage>) => {
      // Only trust messages coming from our sandbox iframe's window.
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const data = ev.data;
      if (!data || typeof data.type !== "string") return;

      if (data.type === "log") {
        // Sandbox-side narration (runtime-globals presence, bundle execution).
        logAdd(data.level, "render", data.message);
        if (data.level === "error") setShowLog(true);
      } else if (data.type === "sandboxReady") {
        sandboxReadyRef.current = true;
        if (pendingBundleRef.current) {
          postToSandbox({ type: "render", bundle: pendingBundleRef.current });
        }
      } else if (data.type === "renderOk") {
        clearWatchdog();
        const detail =
          typeof data.fps === "number" && typeof data.durationInFrames === "number"
            ? ` (${data.fps} fps, ${data.durationInFrames} frames)`
            : "";
        logAdd("info", "render", `Rendered OK${detail}`);
        setError(null);
        setCanRetry(false);
        setIsLoading(false);
      } else if (data.type === "renderError") {
        clearWatchdog();
        logAdd("error", "render", data.message);
        setError(data.message);
        setIsLoading(false);
        setShowLog(true);
      } else if (data.type === "runtimeError") {
        // A throw DURING playback, after renderOk -- the sandbox's persistent error
        // listener forwards these. Log it but do NOT touch error/loading state: the
        // preview is already mounted, and clobbering it would hide a working frame.
        logAdd("error", "runtime", data.message);
      } else if (data.type === "frameUpdate") {
        // Read-only: track playback state so the safe-zone overlay auto-hides during
        // play. Replay COMMANDS belong to ReplayControls; we never post from here.
        setIsPlaying(data.isPlaying);
        if (typeof data.fps === "number" && data.fps > 0) {
          setFps(data.fps);
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [postToSandbox, clearWatchdog, logAdd]);

  // --- Compile whenever the code changes --------------------------------------------
  // startCompile's identity changes with `source`, so this re-fires on every edit;
  // the cleanup cancels any in-flight watchdog on change and on unmount.
  useEffect(() => {
    startCompile();
    return clearWatchdog;
  }, [startCompile, clearWatchdog]);

  // --- Fit the bezel (screen + chrome) into the container, preserving aspect --------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      const { width, height } = container.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const scale = Math.min(
        width / BEZEL_OUTER_WIDTH,
        height / BEZEL_OUTER_HEIGHT,
      );
      const offsetX = (width - BEZEL_OUTER_WIDTH * scale) / 2;
      const offsetY = (height - BEZEL_OUTER_HEIGHT * scale) / 2;
      setFit({ scale, offsetX, offsetY });
    };

    const observer = new ResizeObserver(update);
    observer.observe(container);
    update();
    return () => observer.disconnect();
  }, []);

  return (
   <RenderLogProvider value={useLogStore}>
    <section
      className="panel panel--preview"
      style={{ flexDirection: "column" }}
    >
      <div style={TOOLBAR_STYLE}>
        <select
          aria-label="Safe zone platform"
          style={SELECT_STYLE}
          value={safeZonePlatform}
          onChange={(e) =>
            setSafeZonePlatform(e.target.value as SafeZonePlatform)
          }
        >
          {PLATFORM_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          style={{
            ...TOGGLE_STYLE,
            color: showSafeZone ? "#8a6d1b" : "#6a6a6a",
            borderColor: showSafeZone ? "#e6d28a" : "#cfcfcf",
            background: showSafeZone ? "#fff8e1" : "#ffffff",
          }}
          aria-pressed={showSafeZone}
          onClick={toggleSafeZone}
          title="Toggle safe-zone overlay"
        >
          <EyeIcon open={showSafeZone} />
          Safe Zone
        </button>

        {onStartPass && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            title="Two-pass generation: build the static layout first, then add motion."
          >
            <button
              type="button"
              style={{
                ...TOGGLE_STYLE,
                color: passMode === "layout" ? "#0e7490" : "#6a6a6a",
                borderColor: passMode === "layout" ? "#a5d8e6" : "#cfcfcf",
                background: passMode === "layout" ? "#e0f7fa" : "#ffffff",
              }}
              aria-pressed={passMode === "layout"}
              onClick={() => onStartPass("layout")}
              title="Ask Claude (in the current session) to build the static layout only — placement, copy, palette, type. No motion yet."
            >
              Layout
            </button>
            <button
              type="button"
              style={{
                ...TOGGLE_STYLE,
                color: passMode === "motion" ? "#0e7490" : "#6a6a6a",
                borderColor: passMode === "motion" ? "#a5d8e6" : "#cfcfcf",
                background: passMode === "motion" ? "#e0f7fa" : "#ffffff",
              }}
              aria-pressed={passMode === "motion"}
              onClick={() => onStartPass("motion")}
              title="Ask Claude (in the current session) to animate the locked layout — keeps your conversation, adds motion only."
            >
              Motion
            </button>
          </span>
        )}

        {!embedded && (
        <button
          type="button"
          style={{
            ...TOGGLE_STYLE,
            marginLeft: "auto",
            position: "relative",
            color: showLog ? "#0e7490" : "#6a6a6a",
            borderColor: showLog ? "#a5d8e6" : "#cfcfcf",
            background: showLog ? "#e0f7fa" : "#ffffff",
          }}
          aria-pressed={showLog}
          onClick={() => setShowLog((v) => !v)}
          title="Toggle render log"
        >
          <LogIcon />
          Log
          {!showLog && logErrorCount > 0 && (
            <span
              aria-label={`${logErrorCount} render errors`}
              style={{
                marginLeft: 2,
                minWidth: 16,
                height: 16,
                padding: "0 4px",
                borderRadius: 8,
                background: "#b3261e",
                color: "#fff",
                fontSize: 10,
                fontWeight: 700,
                lineHeight: "16px",
                textAlign: "center",
              }}
            >
              {logErrorCount > 99 ? "99+" : logErrorCount}
            </span>
          )}
        </button>
        )}
      </div>

      <div
        ref={containerRef}
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          background: "#e9e9e9",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            transformOrigin: "top left",
            transform: `translate(${fit.offsetX}px, ${fit.offsetY}px) scale(${fit.scale})`,
          }}
        >
          <PhoneBezel>
            <iframe
              ref={iframeRef}
              title="Remotion preview sandbox"
              // allow-scripts WITHOUT allow-same-origin: the sandbox runs on an opaque
              // origin, isolated from the app. Compiled code cannot touch the host
              // window or network.
              sandbox="allow-scripts"
              srcDoc={srcDoc}
              // A (re)load means a fresh sandbox that hasn't announced readiness yet,
              // so drop the stale ready flag and ping it. The load event and the
              // sandbox's one-time `sandboxReady` post can race; the ping makes the
              // sandbox re-announce so a lost initial message still self-heals (its
              // handler flushes any bundle parked in pendingBundleRef).
              onLoad={() => {
                sandboxReadyRef.current = false;
                postToSandbox({ type: "ping" });
              }}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                border: "none",
                background: "#000",
              }}
            />
            <SafeZoneOverlay
              show={showSafeZone && !isPlaying}
              platform={safeZonePlatform}
              scale={fit.scale}
            />
          </PhoneBezel>
        </div>

        {isLoading && !error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#444",
              fontFamily: "sans-serif",
              fontSize: 13,
              background: "rgba(255,255,255,0.72)",
            }}
          >
            Compiling preview...
          </div>
        )}

        {error && (
          <div
            role="alert"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              maxHeight: "50%",
              overflow: "auto",
              padding: "10px 12px",
              background: "#fdecea",
              color: "#b71c1c",
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              borderTop: "1px solid #f3b5b0",
            }}
          >
            {error}
            {canRetry && (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={startCompile}
                  style={{
                    background: "#ffffff",
                    color: "#b71c1c",
                    border: "1px solid #e6a6a1",
                    borderRadius: 4,
                    padding: "4px 12px",
                    fontSize: 12,
                    fontFamily: "sans-serif",
                    cursor: "pointer",
                  }}
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <ReplayControls iframeRef={iframeRef} containerRef={containerRef} fps={fps} />

      {showLog && !embedded && <RenderLogPanel height={LOG_DRAWER_HEIGHT} />}
    </section>
   </RenderLogProvider>
  );
}

export default PreviewPanel;
