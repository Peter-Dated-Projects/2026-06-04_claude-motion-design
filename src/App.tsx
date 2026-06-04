import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import Toolbar from "./components/layout/Toolbar";
import StatusBar from "./components/layout/StatusBar";
import ChatPanel from "./components/ChatPanel/ChatPanel";
import CodePanel from "./components/CodePanel/CodePanel";
import PreviewPanel from "./components/PreviewPanel/PreviewPanel";
import Onboarding, { type OnboardingPhase } from "./components/Onboarding";
import Settings from "./components/Settings";
import { useUIStore } from "./store/uiStore";
import { useProjectStore } from "./store/projectStore";
import { useClaude } from "./hooks/useClaude";

const MIN_PANEL_PX = 180;
const LAST_PROJECT_KEY = "claude-motion:lastProject";
const GENERATION_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Toasts (App-owned). Used for the Claude edge cases the ticket calls out:
// auth ("claude login"), network errors, generation timeout, and manual-save
// confirmation.
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
  const panelWidths = useUIStore((s) => s.panelWidths);
  const setPanelWidths = useUIStore((s) => s.setPanelWidths);
  const panelsRef = useRef<HTMLDivElement>(null);

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

  // Generated code: mirror into the editor/preview state and persist immediately.
  const handleCodeGenerated = useCallback((generated: string) => {
    setCode(generated);
    const slug = useProjectStore.getState().activeProject?.slug;
    if (slug) invoke("save_animation", { slug, code: generated }).catch(() => {});
  }, []);

  const { messages, streamingText, isGenerating, isWaiting, error, send, cancel } =
    useClaude({ onCodeGenerated: handleCodeGenerated });

  // Refs so the global key handler / timeout read fresh values without re-binding.
  const codeRef = useRef(code);
  const generatingRef = useRef(isGenerating);
  const waitingRef = useRef(isWaiting);
  useEffect(() => {
    codeRef.current = code;
  }, [code]);
  useEffect(() => {
    generatingRef.current = isGenerating;
  }, [isGenerating]);
  useEffect(() => {
    waitingRef.current = isWaiting;
  }, [isWaiting]);

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

  // --- Window title + remember the last project -------------------------------------
  useEffect(() => {
    const title = activeProject?.name
      ? `${activeProject.name} — Claude Motion`
      : "Claude Motion";
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

  // --- Global shortcuts: Cmd/Ctrl+S save, Escape cancel -----------------------------
  // (Cmd+Enter send lives in ChatPanel; Space play/pause lives in ReplayControls.)
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
      } else if (e.key === "Escape" && generatingRef.current) {
        void cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, pushToast]);

  // --- Map Claude errors to actionable toasts ---------------------------------------
  const lastErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!error) {
      lastErrorRef.current = null;
      return;
    }
    if (error === lastErrorRef.current) return;
    lastErrorRef.current = error;

    const lc = error.toLowerCase();
    if (
      lc.includes("login") ||
      lc.includes("logged in") ||
      lc.includes("authenticat") ||
      lc.includes("unauthor") ||
      lc.includes("not authenticated")
    ) {
      pushToast({
        kind: "error",
        text: "Run `claude login` in your terminal to authenticate.",
      });
    } else if (
      lc.includes("network") ||
      lc.includes("connection") ||
      lc.includes("econn") ||
      lc.includes("timed out") ||
      lc.includes("fetch") ||
      lc.includes("dns") ||
      lc.includes("offline")
    ) {
      pushToast({
        kind: "error",
        text: "Network error reaching Claude. Check your connection and try again.",
      });
    } else {
      pushToast({ kind: "error", text: error });
    }
  }, [error, pushToast]);

  // --- Generation timeout: warn (with Stop) if no token after 60s -------------------
  useEffect(() => {
    if (!isWaiting) return;
    const id = window.setTimeout(() => {
      if (generatingRef.current && waitingRef.current) {
        pushToast({
          kind: "warn",
          text: "Claude has not responded for a while.",
          action: { label: "Stop", onClick: () => void cancel() },
          sticky: true,
        });
      }
    }, GENERATION_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [isWaiting, cancel, pushToast]);

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

  // Drag a handle that sits between panel `index` and panel `index + 1`.
  // Only those two panels resize; their combined width is conserved so the
  // other panel never shifts. Widths are stored as percentages.
  const startDrag = useCallback(
    (index: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      const container = panelsRef.current;
      if (!container) return;

      const containerWidth = container.getBoundingClientRect().width;
      const minPct = (MIN_PANEL_PX / containerWidth) * 100;
      const startX = e.clientX;
      const startWidths = useUIStore.getState().panelWidths;
      const combined = startWidths[index] + startWidths[index + 1];

      const onMove = (move: MouseEvent) => {
        const deltaPct = ((move.clientX - startX) / containerWidth) * 100;
        let left = startWidths[index] + deltaPct;
        // Clamp both panels to the minimum width.
        left = Math.max(minPct, Math.min(combined - minPct, left));
        const right = combined - left;

        const next = [...startWidths] as [number, number, number];
        next[index] = left;
        next[index + 1] = right;
        setPanelWidths(next);
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.classList.remove("is-resizing");
      };

      document.body.classList.add("is-resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setPanelWidths],
  );

  return (
    <div className="app">
      <Toolbar
        onOpenSettings={() => setSettingsOpen(true)}
        onNewProject={() => setNewProjectOpen(true)}
      />
      <div className="panels" ref={panelsRef}>
        <div className="panel-slot" style={{ flexBasis: `${panelWidths[0]}%` }}>
          <ChatPanel
            messages={messages}
            streamingText={streamingText}
            isGenerating={isGenerating}
            isWaiting={isWaiting}
            onSend={(text) => void send(text)}
            onCancel={() => void cancel()}
            disabled={!activeProject}
          />
        </div>
        <div
          className="resize-handle"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startDrag(0)}
        />
        <div className="panel-slot" style={{ flexBasis: `${panelWidths[1]}%` }}>
          <CodePanel code={code} onCodeChange={handleCodeChange} />
        </div>
        <div
          className="resize-handle"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startDrag(1)}
        />
        <div className="panel-slot" style={{ flexBasis: `${panelWidths[2]}%` }}>
          <PreviewPanel code={code} />
        </div>
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
