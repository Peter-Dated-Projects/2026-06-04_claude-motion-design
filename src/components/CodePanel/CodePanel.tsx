import { Suspense, lazy, useCallback, useRef, useState } from "react";
import { useUIStore } from "../../store/uiStore";
import type { CodeEditor } from "../../hooks/useMonaco";
import "./CodePanel.css";

const MonacoEditor = lazy(() => import("./MonacoEditor"));

// Shown until the parent feeds in a project's animation source. Kept minimal and
// valid TSX so the editor (and a first compile) has something real to chew on.
const DEFAULT_STARTER = `import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";

export const MyAnimation = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#0f172a" }}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          color: "white",
          fontSize: 80,
          opacity,
        }}
      >
        Hello
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
`;

interface CodePanelProps {
  /** Current animation source. The parent (integration wiring) loads this from
   *  the active project and pushes Claude-generated code here; when it changes
   *  from outside, the editor updates imperatively with a flash. */
  code?: string;
  /** Debounced (500ms) emit of editor content for the esbuild recompile. */
  onCodeChange?: (code: string) => void;
  /** Live editor line count, for the status bar. */
  onLineCountChange?: (lineCount: number) => void;
}

function CodePanel({ code, onCodeChange, onLineCountChange }: CodePanelProps) {
  const isGenerating = useUIStore((s) => s.isGenerating);
  const editorRef = useRef<CodeEditor | null>(null);
  const [copied, setCopied] = useState(false);

  const source = code ?? DEFAULT_STARTER;

  const handleCopy = useCallback(() => {
    // Copy the live editor content, not the (possibly stale) prop.
    const text = editorRef.current?.getValue() ?? source;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard unavailable (e.g. denied permission) — fail quietly.
      });
  }, [source]);

  return (
    <section className="panel panel--code">
      <header className="panel__header codepanel__header">
        <span className="codepanel__title">animation.tsx</span>
        <button
          type="button"
          className="codepanel__copy"
          onClick={handleCopy}
          aria-label="Copy code to clipboard"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </header>
      <div className="codepanel__body">
        <Suspense
          fallback={<div className="monaco-host__loading">Loading editor...</div>}
        >
          <MonacoEditor
            code={source}
            readOnly={isGenerating}
            editorRef={editorRef}
            onCodeChange={onCodeChange}
            onLineCountChange={onLineCountChange}
          />
        </Suspense>
        {isGenerating && (
          <div className="codepanel__overlay" aria-hidden="true" />
        )}
      </div>
    </section>
  );
}

export default CodePanel;
