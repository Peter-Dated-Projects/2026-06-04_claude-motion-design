import { useEffect, useRef, useState } from "react";
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

const FLASH_MS = 500;

interface MonacoEditorProps {
  /** Current source. External changes (e.g. generated code) are applied
   *  imperatively with a flash; user typing flows out via onCodeChange. */
  code: string;
  readOnly: boolean;
  editorRef: React.MutableRefObject<CodeEditor | null>;
  onCodeChange?: (code: string) => void;
  onLineCountChange?: (lineCount: number) => void;
}

function MonacoEditor({
  code,
  readOnly,
  editorRef,
  onCodeChange,
  onLineCountChange,
}: MonacoEditorProps) {
  const { handleMount } = useMonaco({ editorRef, onCodeChange, onLineCountChange });
  const [flash, setFlash] = useState(false);
  // The value Monaco mounts with; later `code` changes are applied imperatively.
  const initialValue = useRef(code);

  // Apply external code updates (a freshly generated animation) imperatively,
  // with a brief highlight. The getValue() guard breaks the typing feedback
  // loop: user keystrokes already match the editor, so they never re-trigger
  // a setValue (which would jump the cursor).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.getValue() === code) return;
    editor.setValue(code);
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [code, editorRef]);

  return (
    <div className={`monaco-host${flash ? " monaco-host--flash" : ""}`}>
      <Editor
        defaultLanguage="typescript"
        defaultValue={initialValue.current}
        path="animation.tsx"
        theme="vs-dark"
        onMount={handleMount}
        options={{ ...EDITOR_OPTIONS, readOnly }}
        loading={<div className="monaco-host__loading">Loading editor...</div>}
      />
    </div>
  );
}

export default MonacoEditor;
