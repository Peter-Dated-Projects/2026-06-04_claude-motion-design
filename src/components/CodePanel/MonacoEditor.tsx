import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { useMonaco, type CodeEditor } from "../../hooks/useMonaco";

// Offline-first: @monaco-editor/react fetches the Monaco runtime from a CDN by
// default, which fails in the packaged desktop app (no network). Point the
// loader at the bundled `monaco-editor` package and wire its web workers via
// Vite's `?worker` imports. Module-level so it runs once, before <Editor>
// initializes; this module is only ever reached through the lazy import in
// CodePanel, so none of this lands in the initial bundle.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};
loader.config({ monaco });

const EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  automaticLayout: true,
  tabSize: 2,
  fontLigatures: true,
} as const;

/** Map a file path to a Monaco language id. The TS language handles .tsx via the
 *  jsx compiler option useMonaco already sets. */
function languageForPath(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

interface MonacoEditorProps {
  /** Project-relative path of the active file. Drives Monaco's per-file model so
   *  each open tab keeps its own content, undo history, and scroll position. */
  path: string;
  /** Current content of the active file (controlled). External updates -- the
   *  animation.tsx watcher -- flow in here and are applied cursor-preservingly. */
  value: string;
  readOnly: boolean;
  editorRef: React.MutableRefObject<CodeEditor | null>;
  onCodeChange?: (code: string) => void;
  onLineCountChange?: (lineCount: number) => void;
}

function MonacoEditor({
  path,
  value,
  readOnly,
  editorRef,
  onCodeChange,
  onLineCountChange,
}: MonacoEditorProps) {
  const { handleMount } = useMonaco({ editorRef, onCodeChange, onLineCountChange });

  return (
    <div className="monaco-host">
      <Editor
        language={languageForPath(path)}
        path={path}
        value={value}
        theme="vs"
        onMount={handleMount}
        options={{ ...EDITOR_OPTIONS, readOnly }}
        loading={<div className="monaco-host__loading">Loading editor...</div>}
      />
    </div>
  );
}

export default MonacoEditor;
