import { useCallback, useEffect, useRef } from "react";
import type { OnMount } from "@monaco-editor/react";
import { useUIStore } from "../store/uiStore";

// The standalone editor instance type, derived from the onMount signature so we
// don't take a direct dependency on the `monaco-editor` type surface here.
export type CodeEditor = Parameters<OnMount>[0];

const SELECTION_DEBOUNCE_MS = 200;
const CONTENT_DEBOUNCE_MS = 500;

interface UseMonacoOptions {
  /** Caller-owned ref; populated with the editor instance on mount so siblings
   *  (e.g. the Copy button, the external-code sync effect) can reach it. */
  editorRef: React.MutableRefObject<CodeEditor | null>;
  /** Debounced (500ms) emit of editor content — the feed for the esbuild
   *  recompile worker wired up by the preview ticket. */
  onCodeChange?: (code: string) => void;
  /** Emitted immediately on every content change (and once on mount) so the
   *  status bar can show a live line count. */
  onLineCountChange?: (lineCount: number) => void;
}

/**
 * Wires a Monaco editor instance: TSX-aware compiler options, debounced
 * selection tracking into the UI store, and debounced content emission for
 * downstream recompilation. Returns an `onMount` handler to hand to <Editor>.
 */
export function useMonaco({
  editorRef,
  onCodeChange,
  onLineCountChange,
}: UseMonacoOptions) {
  // The editor listeners are bound exactly once on mount, but the callbacks can
  // change across renders. Funnel through refs so the listeners always invoke
  // the latest callback without needing to be rebound.
  const onCodeChangeRef = useRef(onCodeChange);
  const onLineCountChangeRef = useRef(onLineCountChange);
  useEffect(() => {
    onCodeChangeRef.current = onCodeChange;
  }, [onCodeChange]);
  useEffect(() => {
    onLineCountChangeRef.current = onLineCountChange;
  }, [onLineCountChange]);

  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      editorRef.current = editor;

      // TSX support: emit React-flavored JSX, target ES2020 to match tsconfig.
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        jsx: monaco.languages.typescript.JsxEmit.React,
        target: monaco.languages.typescript.ScriptTarget.ES2020,
        moduleResolution:
          monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        allowNonTsExtensions: true,
        esModuleInterop: true,
        reactNamespace: "React",
      });

      onLineCountChangeRef.current?.(editor.getModel()?.getLineCount() ?? 0);

      let selectionTimer: number | undefined;
      editor.onDidChangeCursorSelection((e) => {
        window.clearTimeout(selectionTimer);
        selectionTimer = window.setTimeout(() => {
          const model = editor.getModel();
          if (!model) return;
          const sel = e.selection;
          if (sel.isEmpty()) {
            useUIStore.getState().setSelection(null);
            return;
          }
          useUIStore.getState().setSelection({
            text: model.getValueInRange(sel),
            startLine: sel.startLineNumber,
            endLine: sel.endLineNumber,
          });
        }, SELECTION_DEBOUNCE_MS);
      });

      let contentTimer: number | undefined;
      editor.onDidChangeModelContent(() => {
        // Line count is cheap and wants to feel live — update it immediately.
        onLineCountChangeRef.current?.(
          editor.getModel()?.getLineCount() ?? 0,
        );
        // Recompile is expensive — debounce so we only emit once typing settles.
        window.clearTimeout(contentTimer);
        contentTimer = window.setTimeout(() => {
          onCodeChangeRef.current?.(editor.getValue());
        }, CONTENT_DEBOUNCE_MS);
      });
    },
    [editorRef],
  );

  return { handleMount };
}
