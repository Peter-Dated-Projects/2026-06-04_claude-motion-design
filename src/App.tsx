import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Mosaic, MosaicWindow, type MosaicNode } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import "./App.css";
import Toolbar from "./components/layout/Toolbar";
import StatusBar from "./components/layout/StatusBar";
import TerminalPanel from "./components/TerminalPanel/TerminalPanel";
import CodePanel from "./components/CodePanel/CodePanel";
import PreviewPanel from "./components/PreviewPanel/PreviewPanel";
import Onboarding, { type OnboardingPhase } from "./components/Onboarding";
import Settings from "./components/Settings";
import { useProjectStore } from "./store/projectStore";

const LAST_PROJECT_KEY = "claude-motion:lastProject";

// --- Mosaic panel shell ------------------------------------------------------
// The three panels live as draggable tiles in a react-mosaic layout: grab a
// tile's header to re-tile into any horizontal/vertical split, drag dividers to
// resize. Replaces the old hand-rolled fixed-width resize logic.
type PanelId = "terminal" | "editor" | "preview";

const PANEL_TITLES: Record<PanelId, string> = {
  terminal: "Claude",
  editor: "Editor",
  preview: "Preview",
};

const LAYOUT_KEY = "claude-motion:panelLayout";

const DEFAULT_LAYOUT: MosaicNode<PanelId> = {
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

function loadLayout(): MosaicNode<PanelId> {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return JSON.parse(raw) as MosaicNode<PanelId>;
  } catch {
    // Corrupt/absent layout falls back to the default.
  }
  return DEFAULT_LAYOUT;
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
            background: "#2a2a2a",
            color: "#f6f6f6",
            border: `1px solid ${TOAST_COLORS[t.kind]}`,
            borderLeft: `4px solid ${TOAST_COLORS[t.kind]}`,
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 13,
            fontFamily: "Inter, sans-serif",
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
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
              color: "#9a9a9a",
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

function App() {
  const [layout, setLayout] = useState<MosaicNode<PanelId>>(loadLayout);

  const projects = useProjectStore((s) => s.projects);
  const activeProject = useProjectStore((s) => s.activeProject);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const openProject = useProjectStore((s) => s.openProject);
  const createProject = useProjectStore((s) => s.createProject);

  // Current animation source, owned here and fed to both the editor and preview.
  const [code, setCode] = useState("");
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
  const handleCodeChange = useCallback((next: string) => {
    setCode(next);
    const slug = useProjectStore.getState().activeProject?.slug;
    if (slug) invoke("save_animation", { slug, code: next }).catch(() => {});
  }, []);

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
      } catch {
        // A failed project load leaves the onboarding/empty state to take over.
      }
    })();
  }, [loadProjects, openProject]);

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
      .catch(() => {
        if (!cancelled) setCode("");
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.slug]);

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

    invoke("watch_animation", { slug }).catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeProject?.slug]);

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
  const onLayoutChange = useCallback((next: MosaicNode<PanelId> | null) => {
    if (!next) return;
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
    } catch {
      // Best-effort.
    }
  }, []);

  const renderPanel = useCallback(
    (id: PanelId) => {
      switch (id) {
        case "terminal":
          return <TerminalPanel />;
        case "editor":
          return <CodePanel code={code} onCodeChange={handleCodeChange} />;
        case "preview":
          return <PreviewPanel code={code} />;
      }
    },
    [code, handleCodeChange],
  );

  return (
    <div className="app">
      <Toolbar
        onOpenSettings={() => setSettingsOpen(true)}
        onNewProject={() => setNewProjectOpen(true)}
      />
      <div className="panels mosaic-dark">
        <Mosaic<PanelId>
          className=""
          value={layout}
          onChange={onLayoutChange}
          renderTile={(id, path) => (
            <MosaicWindow<PanelId>
              path={path}
              title={PANEL_TITLES[id]}
              toolbarControls={<></>}
            >
              {renderPanel(id)}
            </MosaicWindow>
          )}
        />
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
