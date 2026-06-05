import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "react-mosaic-component/react-mosaic-component.css";
import "./App.css";
import SplitLayout, {
  getLeaves,
  type LayoutNode,
  type PanelId,
} from "./components/PanelLayout/SplitLayout";
import Toolbar from "./components/layout/Toolbar";
import StatusBar from "./components/layout/StatusBar";
import TerminalPanel from "./components/TerminalPanel/TerminalPanel";
import CodePanel, { ENTRY_FILE } from "./components/CodePanel/CodePanel";
import PreviewPanel from "./components/PreviewPanel/PreviewPanel";
import Onboarding, { type OnboardingPhase } from "./components/Onboarding";
import Settings from "./components/Settings";
import { useProjectStore } from "./store/projectStore";
import { useUIStore } from "./store/uiStore";
import type { ProjectFile } from "./types";

const LAST_PROJECT_KEY = "claude-motion:lastProject";

// --- Panel shell -------------------------------------------------------------
// The three panels render through a custom recursive SplitLayout: each split has
// a draggable gutter to resize. The layout tree keeps react-mosaic's node shape
// (leaf = panel id; parent = a row/column split) so persistence and show/hide
// keep working; PanelId / LayoutNode now come from SplitLayout.
const PANEL_TITLES: Record<PanelId, string> = {
  terminal: "Claude",
  editor: "Editor",
  preview: "Preview",
};

// Canonical left-to-right order, used to dock a re-added panel on a sensible
// side (a panel that sorts before everything currently shown docks left).
const PANEL_ORDER: PanelId[] = ["terminal", "editor", "preview"];

const LAYOUT_KEY = "claude-motion:panelLayout";

const DEFAULT_LAYOUT: LayoutNode = {
  direction: "row",
  first: "terminal",
  second: {
    direction: "row",
    first: "editor",
    second: "preview",
    splitPercentage: 50,
  },
  splitPercentage: 33,
};

// A null layout means every panel is hidden -- a valid (if degenerate) state we
// render as an empty state rather than crashing Mosaic on an empty tree.
function loadLayout(): LayoutNode | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return JSON.parse(raw) as LayoutNode | null;
  } catch {
    // Corrupt/absent layout falls back to the default.
  }
  return DEFAULT_LAYOUT;
}

// Remove a panel leaf from the layout tree, collapsing its now-only-child
// parent into the surviving sibling so the rest of the user's arrangement is
// preserved. Returns null when the tree becomes empty (last panel removed).
function removeLeaf(
  tree: LayoutNode | null,
  id: PanelId,
): LayoutNode | null {
  if (tree == null) return null;
  if (typeof tree === "string") return tree === id ? null : tree;
  const first = removeLeaf(tree.first, id);
  const second = removeLeaf(tree.second, id);
  if (first == null) return second;
  if (second == null) return first;
  return { ...tree, first, second };
}

// Splice a hidden panel back into the layout. An empty tree becomes the lone
// leaf; otherwise it docks as a new row split, on the left if it sorts before
// every currently-shown panel (per PANEL_ORDER), else on the right.
function addLeaf(
  tree: LayoutNode | null,
  id: PanelId,
): LayoutNode {
  if (tree == null) return id;
  const idIndex = PANEL_ORDER.indexOf(id);
  const placeFirst = getLeaves(tree).every(
    (leaf) => idIndex < PANEL_ORDER.indexOf(leaf),
  );
  return placeFirst
    ? { direction: "row", first: id, second: tree, splitPercentage: 33 }
    : { direction: "row", first: tree, second: id, splitPercentage: 66 };
}

// ---------------------------------------------------------------------------
// Toasts (App-owned). Used for manual-save confirmation/errors (Cmd/Ctrl+S);
// Claude auth/errors now surface inline in the embedded terminal.
// ---------------------------------------------------------------------------
type ToastKind = "success" | "error" | "warn";
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  action?: { label: string; onClick: () => void };
  sticky?: boolean;
}

const TOAST_COLORS: Record<ToastKind, string> = {
  success: "#22c55e",
  error: "#ef4444",
  warn: "#f59e0b",
};

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 40,
        right: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 1100,
        maxWidth: 360,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          style={{
            background: "#ffffff",
            color: "#1f1f1f",
            border: `1px solid ${TOAST_COLORS[t.kind]}`,
            borderLeft: `4px solid ${TOAST_COLORS[t.kind]}`,
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 13,
            fontFamily: "Inter, sans-serif",
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ flex: 1 }}>{t.text}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action?.onClick();
                onDismiss(t.id);
              }}
              style={{
                background: "transparent",
                color: TOAST_COLORS[t.kind],
                border: `1px solid ${TOAST_COLORS[t.kind]}`,
                borderRadius: 4,
                padding: "3px 8px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => onDismiss(t.id)}
            style={{
              background: "transparent",
              color: "#888",
              border: "none",
              fontSize: 15,
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}

// Floating control cluster (top-right of the panels region) to show/hide each
// panel and reset the layout. The toolbar is a separate component out of this
// ticket's scope, so the controls live on the panels region itself.
function PanelsControls({
  visible,
  onToggle,
  onReset,
}: {
  visible: PanelId[];
  onToggle: (id: PanelId) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div className="panels-controls" ref={ref}>
      <button
        type="button"
        className="panels-controls__btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        Panels <span className="panels-controls__caret">v</span>
      </button>
      <button
        type="button"
        className="panels-controls__btn"
        onClick={onReset}
        title="Reset to the default panel layout"
      >
        Reset layout
      </button>
      {open && (
        <div className="panels-controls__dropdown" role="menu">
          {PANEL_ORDER.map((id) => {
            const shown = visible.includes(id);
            // Never let the user hide the last remaining panel.
            const lockLast = shown && visible.length <= 1;
            return (
              <button
                key={id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={shown}
                className="panels-controls__item"
                disabled={lockLast}
                title={lockLast ? "Can't hide the last panel" : undefined}
                onClick={() => onToggle(id)}
              >
                <span className="panels-controls__check">{shown ? "x" : ""}</span>
                {PANEL_TITLES[id]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function App() {
  const [layout, setLayout] = useState<LayoutNode | null>(loadLayout);
  // True while a mosaic tile is being dragged by its header. We use it to drop
  // pointer events on tile content (the preview iframe / Monaco) for the
  // duration of the drag -- otherwise those heavy children swallow the native
  // HTML5 drag as the cursor passes over them, react-mosaic never sees a valid
  // drop, and the layout snaps back to where it started.
  const [isDragging, setIsDragging] = useState(false);

  const projects = useProjectStore((s) => s.projects);
  const activeProject = useProjectStore((s) => s.activeProject);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const openProject = useProjectStore((s) => s.openProject);
  const createProject = useProjectStore((s) => s.createProject);

  // Current animation source, owned here and fed to both the editor and preview.
  // animation.tsx (ENTRY_FILE) is the one file the preview renders; its content
  // lives in `code` and is mirrored from disk by the watcher.
  const [code, setCode] = useState("");
  // The project's source tree (file-tree rail) and the loaded content of any
  // non-entry files the user has opened in a tab.
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});

  const activeFile = useUIStore((s) => s.activeFile);
  const resetEditorFiles = useUIStore((s) => s.resetEditorFiles);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [claudeInstalled, setClaudeInstalled] = useState<boolean | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { ...t, id }]);
    if (!t.sticky) {
      window.setTimeout(
        () => setToasts((prev) => prev.filter((x) => x.id !== id)),
        5000,
      );
    }
  }, []);
  const dismissToast = useCallback(
    (id: number) => setToasts((prev) => prev.filter((x) => x.id !== id)),
    [],
  );

  // Ref so the global Cmd/Ctrl+S handler reads the latest code without re-binding.
  const codeRef = useRef(code);
  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  // Editor edits: keep state in sync and auto-save (Monaco already debounces 500ms).
  const handleCodeChange = useCallback(
    (next: string) => {
      setCode(next);
      const slug = useProjectStore.getState().activeProject?.slug;
      if (slug)
        invoke("save_animation", { slug, code: next }).catch((err) =>
          pushToast({
            kind: "error",
            text: `Couldn't save animation: ${String(err)}`,
          }),
        );
    },
    [pushToast],
  );

  // Route a debounced editor change to the right file. The entry file flows
  // through handleCodeChange (which also feeds the preview); any other file is
  // saved by path via write_file. Non-entry edits do NOT yet affect the preview
  // -- the sandbox compiler still bundles only animation.tsx.
  const handleContentChange = useCallback(
    (next: string) => {
      const slug = useProjectStore.getState().activeProject?.slug;
      const path = useUIStore.getState().activeFile;
      if (!slug || !path) return;
      if (path === ENTRY_FILE) {
        handleCodeChange(next);
        return;
      }
      setFileContents((prev) => ({ ...prev, [path]: next }));
      invoke("write_file", { slug, path, contents: next }).catch((err) =>
        pushToast({
          kind: "error",
          text: `Couldn't save ${path}: ${String(err)}`,
        }),
      );
    },
    [handleCodeChange, pushToast],
  );

  // --- Startup: check the CLI, load projects, reopen the last one -------------------
  useEffect(() => {
    void (async () => {
      try {
        setClaudeInstalled(await invoke<boolean>("check_claude_installed"));
      } catch {
        setClaudeInstalled(false);
      }
      try {
        await loadProjects();
        const last = localStorage.getItem(LAST_PROJECT_KEY);
        const list = useProjectStore.getState().projects;
        if (last && list.some((p) => p.slug === last)) {
          await openProject(last);
        }
      } catch (err) {
        // Onboarding/empty state still takes over, but tell the user the load failed
        // rather than leaving them staring at an empty workspace with no explanation.
        pushToast({
          kind: "warn",
          text: `Couldn't load your projects: ${String(err)}`,
        });
      }
    })();
  }, [loadProjects, openProject, pushToast]);

  // --- Load the active project's animation source -----------------------------------
  useEffect(() => {
    const slug = activeProject?.slug;
    if (!slug) {
      setCode("");
      return;
    }
    let cancelled = false;
    invoke<string>("load_animation", { slug })
      .then((src) => {
        if (!cancelled) setCode(src);
      })
      .catch((err) => {
        if (!cancelled) {
          setCode("");
          pushToast({
            kind: "error",
            text: `Couldn't load animation: ${String(err)}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.slug, pushToast]);

  // --- Load the project's source tree + reset the editor on project switch ----------
  useEffect(() => {
    const slug = activeProject?.slug;
    // A new project starts with just the entry tab open; drop any cached
    // non-entry content from the previous project.
    setFileContents({});
    resetEditorFiles(ENTRY_FILE);
    if (!slug) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    invoke<ProjectFile[]>("list_project_files", { slug })
      .then((f) => {
        if (!cancelled) setFiles(f);
      })
      .catch((err) => {
        if (!cancelled) {
          setFiles([]);
          pushToast({
            kind: "warn",
            text: `Couldn't list project files: ${String(err)}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.slug, resetEditorFiles, pushToast]);

  // --- Lazily load a non-entry file's content when its tab becomes active ------------
  // The entry file's content is `code` (mirrored by the watcher); other files are
  // read on demand and cached in `fileContents`.
  useEffect(() => {
    const slug = activeProject?.slug;
    if (!slug || !activeFile || activeFile === ENTRY_FILE) return;
    if (activeFile in fileContents) return;
    let cancelled = false;
    invoke<string>("read_file", { slug, path: activeFile })
      .then((c) => {
        if (!cancelled) setFileContents((prev) => ({ ...prev, [activeFile]: c }));
      })
      .catch((err) => {
        if (!cancelled)
          pushToast({
            kind: "error",
            text: `Couldn't open ${activeFile}: ${String(err)}`,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [activeFile, activeProject?.slug, fileContents, pushToast]);

  // --- Watch animation.tsx on disk: it is the display source of truth ---------------
  // Both the user (Monaco) and Claude (terminal) write this file; the backend
  // file watcher emits its latest contents and we mirror them into `code`, which
  // flows to the editor and preview. This replaces the old chat onCodeGenerated.
  useEffect(() => {
    const slug = activeProject?.slug;
    if (!slug) return;

    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<{ code: string }>("animation://changed", (event) => {
      setCode(event.payload.code);
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });

    invoke("watch_animation", { slug }).catch((err) =>
      pushToast({
        kind: "warn",
        text: `File watching unavailable -- external edits won't refresh the preview: ${String(err)}`,
      }),
    );

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeProject?.slug, pushToast]);

  // --- Window title + remember the last project -------------------------------------
  useEffect(() => {
    const title = activeProject?.name
      ? `${activeProject.name} — ClaudeMotion`
      : "ClaudeMotion";
    document.title = title;
    getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
    if (activeProject?.slug) {
      try {
        localStorage.setItem(LAST_PROJECT_KEY, activeProject.slug);
      } catch {
        // Best-effort.
      }
    }
  }, [activeProject?.slug, activeProject?.name]);

  // --- Global shortcut: Cmd/Ctrl+S save ---------------------------------------------
  // (Space play/pause lives in ReplayControls.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        const slug = useProjectStore.getState().activeProject?.slug;
        if (!slug) return;
        invoke("save_animation", { slug, code: codeRef.current })
          .then(() => pushToast({ kind: "success", text: "Saved" }))
          .catch((err) =>
            pushToast({ kind: "error", text: `Save failed: ${String(err)}` }),
          );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pushToast]);

  // --- Onboarding / new-project modal decisioning -----------------------------------
  const needsFirstProject =
    claudeInstalled === true && !activeProject && projects.length === 0;

  let onboardingPhase: OnboardingPhase | null = null;
  let cancelable = false;
  if (claudeInstalled === false) {
    onboardingPhase = "install";
  } else if (needsFirstProject) {
    onboardingPhase = "project";
  } else if (newProjectOpen) {
    onboardingPhase = "project";
    cancelable = true;
  }

  const onRecheck = useCallback(async () => {
    setRechecking(true);
    try {
      setClaudeInstalled(await invoke<boolean>("check_claude_installed"));
    } catch {
      setClaudeInstalled(false);
    } finally {
      setRechecking(false);
    }
  }, []);

  const onCreate = useCallback(
    async (name: string) => {
      setCreating(true);
      try {
        await createProject(name);
        setNewProjectOpen(false);
      } catch (e) {
        pushToast({ kind: "error", text: `Could not create project: ${String(e)}` });
      } finally {
        setCreating(false);
      }
    },
    [createProject, pushToast],
  );

  // Persist the tile layout so a rearranged/resized workspace survives reloads.
  // Accepts null (all panels hidden) -- stored as-is so the empty state sticks.
  const applyLayout = useCallback((next: LayoutNode | null) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
    } catch {
      // Best-effort.
    }
  }, []);

  // Panels currently in the tree; drives the menu checkmarks and last-panel lock.
  const visiblePanels = getLeaves(layout);

  const togglePanel = useCallback(
    (id: PanelId) => {
      const leaves = getLeaves(layout);
      if (leaves.includes(id)) {
        if (leaves.length <= 1) return; // never hide the last panel
        applyLayout(removeLeaf(layout, id));
      } else {
        applyLayout(addLeaf(layout, id));
      }
    },
    [layout, applyLayout],
  );

  const resetLayout = useCallback(
    () => applyLayout(DEFAULT_LAYOUT),
    [applyLayout],
  );

  // Content shown in the editor for the active tab: the entry file uses `code`
  // (the preview source); any other open file uses its cached content.
  const activeContent =
    activeFile === ENTRY_FILE
      ? code
      : activeFile
        ? (fileContents[activeFile] ?? "")
        : "";
  const contentLoading =
    !!activeFile && activeFile !== ENTRY_FILE && !(activeFile in fileContents);

  const renderPanel = useCallback(
    (id: PanelId) => {
      switch (id) {
        case "terminal":
          return <TerminalPanel />;
        case "editor":
          return (
            <CodePanel
              files={files}
              activeContent={activeContent}
              loading={contentLoading}
              onContentChange={handleContentChange}
            />
          );
        case "preview":
          return <PreviewPanel code={code} />;
      }
    },
    [code, files, activeContent, contentLoading, handleContentChange],
  );

  return (
    <div className="app">
      <Toolbar
        onOpenSettings={() => setSettingsOpen(true)}
        onNewProject={() => setNewProjectOpen(true)}
      />
      <div
        className={`panels mosaic-light${isDragging ? " panels--dragging" : ""}`}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={() => setIsDragging(false)}
        onDrop={() => setIsDragging(false)}
      >
        <PanelsControls
          visible={visiblePanels}
          onToggle={togglePanel}
          onReset={resetLayout}
        />
        {layout ? (
          <SplitLayout
            value={layout}
            onChange={applyLayout}
            renderPanel={renderPanel}
            panelTitles={PANEL_TITLES}
          />
        ) : (
          <div className="panels-empty">
            <p className="panels-empty__text">All panels are hidden.</p>
            <button
              type="button"
              className="panels-empty__btn"
              onClick={resetLayout}
            >
              Reset layout
            </button>
          </div>
        )}
      </div>
      <StatusBar />

      {onboardingPhase && (
        <Onboarding
          phase={onboardingPhase}
          rechecking={rechecking}
          onRecheck={() => void onRecheck()}
          creating={creating}
          onCreate={(name) => void onCreate(name)}
          cancelable={cancelable}
          onCancel={() => setNewProjectOpen(false)}
        />
      )}

      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default App;
