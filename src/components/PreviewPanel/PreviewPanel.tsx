import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// The sandbox HTML shell + the three local runtime files are pulled in as raw strings and
// inlined into the iframe via srcdoc. Everything ships locally (no CDN); see
// scripts/build-preview-runtime.mjs and src/assets/sandbox-frame.html.
import sandboxFrameHtml from "../../assets/sandbox-frame.html?raw";
import reactRuntime from "../../../src-tauri/resources/react.production.min.js?raw";
import reactDomRuntime from "../../../src-tauri/resources/react-dom.production.min.js?raw";
import previewRuntime from "../../../src-tauri/resources/preview-runtime.js?raw";

// Composition is 9:16 (1080x1920); the preview box is scaled to fit its container.
const COMPOSITION_WIDTH = 1080;
const COMPOSITION_HEIGHT = 1920;

// Stand-in animation so the preview is demonstrable before Monaco (T-025) / Claude
// codegen (T-024) are wired in during integration (T-032).
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
  return sandboxFrameHtml.replace("<!--RUNTIME-->", runtime);
}

type WorkerMessage =
  | { type: "compiled"; bundle: string; id?: number }
  | { type: "error"; message: string; id?: number };

type SandboxMessage =
  | { type: "sandboxReady" }
  | { type: "renderOk" }
  | { type: "renderError"; message: string }
  | { type: "frameUpdate"; frame: number; totalFrames: number; isPlaying: boolean };

function PreviewPanel() {
  // Pre-built once; future code edits only re-post a compiled bundle, not a new srcdoc.
  const srcDoc = useMemo(buildSrcDoc, []);

  const [code] = useState(SAMPLE_CODE);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [scaleStyle, setScaleStyle] = useState<React.CSSProperties>({});

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Latest compiled bundle, held until the sandbox reports it is ready to render.
  const pendingBundleRef = useRef<string | null>(null);
  const sandboxReadyRef = useRef(false);

  const postToSandbox = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  // --- Worker: TSX -> compiled IIFE -------------------------------------------------
  useEffect(() => {
    const worker = new Worker(
      new URL("../../workers/sandbox-compiler.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;

    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      const data = ev.data;
      if (data.type === "compiled") {
        setError(null);
        pendingBundleRef.current = data.bundle;
        if (sandboxReadyRef.current) {
          postToSandbox({ type: "render", bundle: data.bundle });
        }
      } else if (data.type === "error") {
        setError(data.message);
        setIsLoading(false);
      }
    };
    worker.onerror = (ev) => {
      setError(ev.message || "Compiler worker crashed.");
      setIsLoading(false);
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [postToSandbox]);

  // --- Sandbox iframe -> parent messages --------------------------------------------
  useEffect(() => {
    const onMessage = (ev: MessageEvent<SandboxMessage>) => {
      // Only trust messages coming from our sandbox iframe's window.
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const data = ev.data;
      if (!data || typeof data.type !== "string") return;

      if (data.type === "sandboxReady") {
        sandboxReadyRef.current = true;
        if (pendingBundleRef.current) {
          postToSandbox({ type: "render", bundle: pendingBundleRef.current });
        }
      } else if (data.type === "renderOk") {
        setError(null);
        setIsLoading(false);
      } else if (data.type === "renderError") {
        setError(data.message);
        setIsLoading(false);
      }
      // frameUpdate is consumed by the replay controls (T-030) once wired.
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [postToSandbox]);

  // --- Compile whenever the code changes --------------------------------------------
  useEffect(() => {
    setIsLoading(true);
    workerRef.current?.postMessage({ type: "compile", code });
  }, [code]);

  // --- Fit the 1080x1920 box into the container, preserving aspect ------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      const { width, height } = container.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const scale = Math.min(width / COMPOSITION_WIDTH, height / COMPOSITION_HEIGHT);
      const offsetX = (width - COMPOSITION_WIDTH * scale) / 2;
      const offsetY = (height - COMPOSITION_HEIGHT * scale) / 2;
      setScaleStyle({
        width: COMPOSITION_WIDTH,
        height: COMPOSITION_HEIGHT,
        transformOrigin: "top left",
        transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
      });
    };

    const observer = new ResizeObserver(update);
    observer.observe(container);
    update();
    return () => observer.disconnect();
  }, []);

  return (
    <section className="panel panel--preview">
      <div
        ref={containerRef}
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          background: "#000",
        }}
      >
        <iframe
          ref={iframeRef}
          title="Remotion preview sandbox"
          // allow-scripts WITHOUT allow-same-origin: the sandbox runs on an opaque origin,
          // isolated from the app. Compiled code cannot touch the host window or network.
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            border: "none",
            background: "#000",
            ...scaleStyle,
          }}
        />

        {isLoading && !error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#9aa",
              fontFamily: "sans-serif",
              fontSize: 13,
              background: "rgba(0,0,0,0.6)",
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
              background: "#3a0d0d",
              color: "#ffb4b4",
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              borderTop: "1px solid #802",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </section>
  );
}

export default PreviewPanel;
