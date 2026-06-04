import { Suspense, lazy, useCallback, useMemo, useRef, useState } from "react";
import { useUIStore } from "../../store/uiStore";
import type { CodeEditor } from "../../hooks/useMonaco";
import type { ProjectFile } from "../../types";
import "./CodePanel.css";

const MonacoEditor = lazy(() => import("./MonacoEditor"));
const AssetsView = lazy(() => import("./AssetsView"));

/** The entry point: the only file the sandbox compiler bundles and the preview
 *  renders. Editing any other file saves to disk but does NOT yet affect the
 *  preview (multi-file compilation is a separate, future change). */
export const ENTRY_FILE = "animation.tsx";

// --- file tree model --------------------------------------------------------

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

/** Build a nested tree from the flat `list_project_files` result, synthesizing
 *  any intermediate directories that weren't returned explicitly. */
function buildTree(files: ProjectFile[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (path: string): TreeNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const segments = path.split("/");
    const name = segments[segments.length - 1];
    const parent = ensureDir(segments.slice(0, -1).join("/"));
    const node: TreeNode = { name, path, isDir: true, children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };

  for (const file of files) {
    if (file.isDir) {
      ensureDir(file.path);
      continue;
    }
    const segments = file.path.split("/");
    const name = segments[segments.length - 1];
    const parent = ensureDir(segments.slice(0, -1).join("/"));
    parent.children.push({ name, path: file.path, isDir: false, children: [] });
  }

  const sortRec = (node: TreeNode) => {
    node.children.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
    );
    node.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

// --- tree view --------------------------------------------------------------

interface TreeViewProps {
  nodes: TreeNode[];
  depth: number;
  activeFile: string | null;
  collapsed: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function TreeView({
  nodes,
  depth,
  activeFile,
  collapsed,
  onToggleDir,
  onOpenFile,
}: TreeViewProps) {
  return (
    <ul className="filetree__list">
      {nodes.map((node) => {
        const indent = { paddingLeft: 8 + depth * 12 };
        if (node.isDir) {
          const isOpen = !collapsed.has(node.path);
          return (
            <li key={node.path}>
              <button
                type="button"
                className="filetree__row filetree__row--dir"
                style={indent}
                onClick={() => onToggleDir(node.path)}
              >
                <span className="filetree__chevron">{isOpen ? "v" : ">"}</span>
                <span className="filetree__name">{node.name}</span>
              </button>
              {isOpen && node.children.length > 0 && (
                <TreeView
                  nodes={node.children}
                  depth={depth + 1}
                  activeFile={activeFile}
                  collapsed={collapsed}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                />
              )}
            </li>
          );
        }
        const isActive = node.path === activeFile;
        const isEntry = node.path === ENTRY_FILE;
        return (
          <li key={node.path}>
            <button
              type="button"
              className={`filetree__row filetree__row--file${
                isActive ? " filetree__row--active" : ""
              }`}
              style={indent}
              onClick={() => onOpenFile(node.path)}
              title={isEntry ? "Entry point -- drives the preview" : node.path}
            >
              <span className="filetree__name">{node.name}</span>
              {isEntry && (
                <span
                  className="filetree__badge"
                  aria-label="Entry point -- drives the preview"
                >
                  entry
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// --- panel ------------------------------------------------------------------

interface CodePanelProps {
  /** The project's source tree from `list_project_files`. */
  files: ProjectFile[];
  /** Content of the active file (controlled). For the entry file this is the
   *  preview source mirrored from disk; for others it is loaded on open. */
  activeContent: string;
  /** Whether the active file's content is still loading from disk. */
  loading?: boolean;
  /** Debounced (500ms) emit of editor content for the active file. */
  onContentChange?: (code: string) => void;
  /** Live editor line count, for the status bar. */
  onLineCountChange?: (lineCount: number) => void;
}

function CodePanel({
  files,
  activeContent,
  loading,
  onContentChange,
  onLineCountChange,
}: CodePanelProps) {
  const isGenerating = useUIStore((s) => s.isGenerating);
  const openFiles = useUIStore((s) => s.openFiles);
  const activeFile = useUIStore((s) => s.activeFile);
  const openFile = useUIStore((s) => s.openFile);
  const closeFile = useUIStore((s) => s.closeFile);
  const setActiveFile = useUIStore((s) => s.setActiveFile);
  const showFileTree = useUIStore((s) => s.showFileTree);
  const toggleFileTree = useUIStore((s) => s.toggleFileTree);
  const codePanelView = useUIStore((s) => s.codePanelView);
  const setCodePanelView = useUIStore((s) => s.setCodePanelView);

  const editorRef = useRef<CodeEditor | null>(null);
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(files), [files]);

  const onToggleDir = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleCopy = useCallback(() => {
    const text = editorRef.current?.getValue() ?? activeContent;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard unavailable (e.g. denied permission) -- fail quietly.
      });
  }, [activeContent]);

  return (
    <section className="panel panel--code">
      <div className="codepanel__layout">
        {showFileTree && (
          <aside
            className={`filetree${
              codePanelView === "assets" ? " filetree--assets" : ""
            }`}
            aria-label="Project files"
          >
            <div className="filetree__header">
              <div className="filetree__views" role="tablist" aria-label="Rail view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={codePanelView === "files"}
                  className={`filetree__view${
                    codePanelView === "files" ? " filetree__view--active" : ""
                  }`}
                  onClick={() => setCodePanelView("files")}
                >
                  Files
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={codePanelView === "assets"}
                  className={`filetree__view${
                    codePanelView === "assets" ? " filetree__view--active" : ""
                  }`}
                  onClick={() => setCodePanelView("assets")}
                >
                  Assets
                </button>
              </div>
              <button
                type="button"
                className="filetree__collapse"
                onClick={toggleFileTree}
                aria-label="Hide file tree"
                title="Hide file tree"
              >
                {"<<"}
              </button>
            </div>
            {codePanelView === "assets" ? (
              <Suspense fallback={<div className="assets__empty">Loading...</div>}>
                <AssetsView />
              </Suspense>
            ) : tree.length === 0 ? (
              <div className="filetree__empty">No files</div>
            ) : (
              <TreeView
                nodes={tree}
                depth={0}
                activeFile={activeFile}
                collapsed={collapsed}
                onToggleDir={onToggleDir}
                onOpenFile={openFile}
              />
            )}
          </aside>
        )}

        <div className="codepanel__main">
          <div className="codetabs" role="tablist">
            {!showFileTree && (
              <button
                type="button"
                className="codepanel__tree-toggle"
                onClick={toggleFileTree}
                aria-label="Show file tree"
                aria-pressed={false}
                title="Show file tree"
              >
                {">>"}
              </button>
            )}
            <div className="codetabs__scroll">
              {openFiles.map((path) => {
                const isActive = path === activeFile;
                return (
                  <div
                    key={path}
                    role="tab"
                    aria-selected={isActive}
                    className={`codetab${isActive ? " codetab--active" : ""}`}
                    onClick={() => setActiveFile(path)}
                  >
                    <span className="codetab__name">{basename(path)}</span>
                    <button
                      type="button"
                      className="codetab__close"
                      aria-label={`Close ${basename(path)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeFile(path);
                      }}
                    >
                      x
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              className="codepanel__copy"
              onClick={handleCopy}
              aria-label="Copy code to clipboard"
              disabled={!activeFile}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <div className="codepanel__body">
            {activeFile ? (
              <Suspense
                fallback={
                  <div className="monaco-host__loading">Loading editor...</div>
                }
              >
                <MonacoEditor
                  path={activeFile}
                  value={activeContent}
                  readOnly={isGenerating}
                  editorRef={editorRef}
                  onCodeChange={onContentChange}
                  onLineCountChange={onLineCountChange}
                />
              </Suspense>
            ) : (
              <div className="codepanel__placeholder">
                Select a file to start editing.
              </div>
            )}
            {((loading && activeFile) || isGenerating) && (
              <div className="codepanel__overlay" aria-hidden="true" />
            )}
            {activeFile && activeFile !== ENTRY_FILE && (
              <div className="codepanel__hint" role="note">
                Editing {basename(activeFile)} -- only {ENTRY_FILE} drives the
                preview.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export default CodePanel;
