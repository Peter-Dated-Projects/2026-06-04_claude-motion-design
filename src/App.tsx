import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import SplitLayout, {
  getLeaves,
  type LayoutNode,
  type PanelId,
} from "./components/PanelLayout/SplitLayout";
import Toolbar from "./components/layout/Toolbar";
import StatusBar from "./components/layout/StatusBar";
import WorkspaceBar from "./components/layout/WorkspaceBar";
import TerminalPanel from "./components/TerminalPanel/TerminalPanel";
import CodePanel, { ENTRY_FILE } from "./components/CodePanel/CodePanel";
import PreviewPanel from "./components/PreviewPanel/PreviewPanel";
import Onboarding, { type OnboardingPhase } from "./components/Onboarding";
import Settings from "./components/Settings";
import RenderModal from "./components/RenderModal";
import { ChevronDownIcon, CheckIcon } from "./components/icons";
import { useProjectStore } from "./store/projectStore";
import { useUIStore } from "./store/uiStore";
import {
  useWorkspaceStore,
  selectActiveLayout,
  selectActiveAvailablePanels,
  selectActiveDefaultLayout,
} from "./store/workspaceStore";
import type { ProjectFile } from "./types";

const LAST_PROJECT_KEY = "claude-motion:lastProject";

// --- Two-pass phased generation (layout pass -> motion pass) -----------------
// A pass constrains the Claude session to one design concern. `null` is a normal
// (unphased) session and reproduces the original behavior exactly.
export type PassMode = "layout" | "motion" | null;

// Layout-pass starter: motion imports are intentionally ABSENT so Claude cannot
// reach for them (structural prevention). Seeded into animation.tsx at pass start.
// Two-pass phase directives. These are sent as a normal user turn into the LIVE
// Claude session (via terminal_input) rather than relaunching the CLI with a phase
// skills file appended — restarting killed the conversation and garbled the
// terminal. The detailed motion knowledge already lives in the appended skills
// system prompt; these messages just scope the current turn to one phase. The
// layout-pass validator below still enforces "no motion code" structurally.
const LAYOUT_PASS_PROMPT =
  "Start the LAYOUT pass. Rewrite animation.tsx as a STATIC frame only: " +
  "establish element placement, copy, hierarchy, palette, and typography. " +
  "Do NOT add any animation yet — no useCurrentFrame, spring, interpolate, or " +
  "Easing. I'll trigger the motion pass next.";
const MOTION_PASS_PROMPT =
  "Start the MOTION pass. The layout in animation.tsx is LOCKED — do not change " +
  "element positions, sizes, copy, or palette. Add animation only: spring/" +
  "interpolate on transform and opacity, staggered entrances, arced motion, a " +
  "readable hold, and a fast exit, following the named motion presets.";

// --- Panel shell -------------------------------------------------------------
// The three panels render through a custom recursive SplitLayout: each split has
// a draggable gutter to resize. The layout tree is a simple binary tree
// (leaf = panel id; parent = a row/column split) that drives persistence and
// show/hide; PanelId / LayoutNode come from SplitLayout.
const PANEL_TITLES: Record<PanelId, string> = {
  terminal: "Claude",
  editor: "Editor",
  preview: "Preview",
};

// Canonical left-to-right order, used to dock a re-added panel on a sensible
// side (a panel that sorts before everything currently shown docks left).
const PANEL_ORDER: PanelId[] = ["terminal", "editor", "preview"];

// The active workspace's panel arrangement is owned by the workspace store
// (each workspace = a stage of the design flow with its own layout over the
// SAME shared panels). DEFAULT_LAYOUT lives there too.

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
  available,
  onToggle,
  onReset,
}: {
  visible: PanelId[];
  // The active workspace's allowed panels; the menu only offers these.
  available: PanelId[];
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
        Panels
        <ChevronDownIcon className="panels-controls__caret" />
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
          {PANEL_ORDER.filter((id) => available.includes(id)).map((id) => {
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
                <span className="panels-controls__check">
                  {shown && <CheckIcon />}
                </span>
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
  // The layout shown is the active workspace's; switching workspaces swaps the
  // tree SplitLayout renders while the panel hosts (PTY/preview/editor) stay
  // mounted, so those sessions are shared across workspaces.
  const layout = useWorkspaceStore(selectActiveLayout);
  const availablePanels = useWorkspaceStore(selectActiveAvailablePanels);
  const activeDefaultLayout = useWorkspaceStore(selectActiveDefaultLayout);
  const setWorkspaceLayout = useWorkspaceStore((s) => s.setLayout);

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
  // The COMPLETE content of every non-entry `.ts`/`.tsx` file, fed to the preview
  // compiler so relative imports (`./theme`, `./components/X`) resolve at preview
  // time. Distinct from `fileContents` (which is lazy -- only tabs the user opened);
  // this must hold ALL of them for the bundle. The entry file (animation.tsx) is
  // `code`, combined into the map below.
  const [previewFiles, setPreviewFiles] = useState<Record<string, string>>({});

  // Active two-pass generation phase. Drives the trigger UI's active state and
  // which directive `startPass` sends. Defaults to "layout": a fresh session is
  // expected to start by establishing structure, then advance to motion.
  const [passMode, setPassMode] = useState<PassMode>("layout");

  const activeFile = useUIStore((s) => s.activeFile);
  const resetEditorFiles = useUIStore((s) => s.resetEditorFiles);
  const videoExportOpen = useUIStore((s) => s.videoExportOpen);
  const closeVideoExport = useUIStore((s) => s.closeVideoExport);

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

  // Read the COMPLETE set of non-entry `.ts`/`.tsx` files for the preview compiler.
  // Re-listing from disk (rather than diffing event paths) makes add / delete / rename
  // self-correcting: a removed file simply drops out of the list, so the map never
  // carries a stale entry. The entry file is excluded here -- it's `code`.
  const loadPreviewFiles = useCallback(
    async (slug: string): Promise<Record<string, string>> => {
      const list = await invoke<ProjectFile[]>("list_project_files", { slug });
      const targets = list.filter(
        (f) => !f.isDir && /\.tsx?$/.test(f.path) && f.path !== ENTRY_FILE,
      );
      const entries = await Promise.all(
        targets.map(
          async (f) =>
            [f.path, await invoke<string>("read_file", { slug, path: f.path })] as const,
        ),
      );
      return Object.fromEntries(entries);
    },
    [],
  );

  // --- Two-pass generation trigger --------------------------------------------------
  // Start a layout or motion pass by sending a phase directive into the LIVE Claude
  // session and auto-submitting it. Crucially this does NOT restart the CLI or
  // overwrite animation.tsx: the conversation context is preserved and the terminal
  // isn't torn down.
  const startPass = useCallback(
    (mode: Exclude<PassMode, null>) => {
      const slug = useProjectStore.getState().activeProject?.slug;
      if (!slug) return;
      setPassMode(mode);
      const directive =
        mode === "layout" ? LAYOUT_PASS_PROMPT : MOTION_PASS_PROMPT;
      // Send the directive text, then the Enter as a SEPARATE keystroke after a
      // short beat. One combined "text\r" write lands as a multi-line paste that
      // Claude's input box parks (waiting for the user to hit Enter); a discrete
      // trailing CR after the paste settles is what actually submits the turn.
      invoke("terminal_input", { data: directive })
        .then(() => new Promise((res) => window.setTimeout(res, 150)))
        .then(() => invoke("terminal_input", { data: "\r" }))
        .catch((err) =>
          pushToast({
            kind: "error",
            text: `Couldn't start ${mode} pass (is the Claude session running?): ${String(err)}`,
          }),
        );
    },
    [pushToast],
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
    // non-entry content (editor tabs + preview map) from the previous project.
    setFileContents({});
    setPreviewFiles({});
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
    // Load the full non-entry source map so the preview can resolve relative imports
    // immediately, before any edit.
    loadPreviewFiles(slug)
      .then((map) => {
        if (!cancelled) setPreviewFiles(map);
      })
      .catch(() => {
        // Non-fatal: a single-file animation.tsx still previews from `code`.
        if (!cancelled) setPreviewFiles({});
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.slug, resetEditorFiles, pushToast, loadPreviewFiles]);

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

  // --- Watch the project's .ts/.tsx on disk: the display + preview source of truth ---
  // Both the user (Monaco) and Claude (terminal) write these files; the backend file
  // watcher emits the set of changed project-relative paths after a debounced burst.
  // animation.tsx flows into `code` (editor + preview entry); every other .ts/.tsx is
  // re-read into the preview map so relative imports resolve. This replaces the old
  // chat onCodeGenerated.
  useEffect(() => {
    const slug = activeProject?.slug;
    if (!slug) return;

    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<{ paths: string[] }>("animation://changed", (event) => {
      if (disposed) return;
      const paths = event.payload.paths ?? [];
      // Entry file changed -> refresh `code` (editor mirror + preview entry).
      if (paths.includes(ENTRY_FILE)) {
        invoke<string>("load_animation", { slug })
          .then((src) => {
            if (disposed) return;
            setCode(src);
          })
          .catch(() => {});
      }
      // Any non-entry .ts/.tsx changed (added / edited / deleted) -> rebuild the
      // full preview map from disk so add/delete are self-correcting.
      const nonEntryChanged = paths.some(
        (p) => p !== ENTRY_FILE && /\.tsx?$/.test(p),
      );
      if (nonEntryChanged) {
        loadPreviewFiles(slug)
          .then((map) => {
            if (!disposed) setPreviewFiles(map);
          })
          .catch(() => {});
      }
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
  }, [activeProject?.slug, pushToast, loadPreviewFiles]);

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

  // Persist the active workspace's layout so a rearranged/resized workspace
  // survives reloads. Accepts null (all panels hidden), stored as-is. The store
  // handles localStorage; this just writes to the active workspace.
  const applyLayout = useCallback(
    (next: LayoutNode | null) => setWorkspaceLayout(next),
    [setWorkspaceLayout],
  );

  // Panels currently in the tree; drives the menu checkmarks and last-panel lock.
  const visiblePanels = getLeaves(layout);

  const togglePanel = useCallback(
    (id: PanelId) => {
      const leaves = getLeaves(layout);
      if (leaves.includes(id)) {
        if (leaves.length <= 1) return; // never hide the last panel
        applyLayout(removeLeaf(layout, id));
      } else {
        // Only panels in the active workspace's config can be added.
        if (!availablePanels.includes(id)) return;
        applyLayout(addLeaf(layout, id));
      }
    },
    [layout, availablePanels, applyLayout],
  );

  // Reset to the active workspace's hard-coded default arrangement (which only
  // ever contains panels the workspace's config allows).
  const resetLayout = useCallback(
    () => applyLayout(activeDefaultLayout),
    [applyLayout, activeDefaultLayout],
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

  // Complete snapshot handed to the preview compiler: every non-entry .ts/.tsx plus the
  // live entry (`code`, the editor's source of truth). Memoized so unrelated re-renders
  // don't change identity and trigger needless recompiles.
  const previewFileMap = useMemo(
    () => ({ ...previewFiles, [ENTRY_FILE]: code }),
    [previewFiles, code],
  );

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
          return (
            <PreviewPanel
              files={previewFileMap}
              passMode={passMode}
              onStartPass={startPass}
            />
          );
      }
    },
    [
      previewFileMap,
      files,
      activeContent,
      contentLoading,
      handleContentChange,
      passMode,
      startPass,
    ],
  );

  return (
    <div className="app">
      <Toolbar
        onOpenSettings={() => setSettingsOpen(true)}
        onNewProject={() => setNewProjectOpen(true)}
      />
      <div className="panels">
        <PanelsControls
          visible={visiblePanels}
          available={availablePanels}
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
      <WorkspaceBar />

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

      <RenderModal
        open={videoExportOpen}
        slug={activeProject?.slug ?? null}
        files={previewFileMap}
        onClose={closeVideoExport}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default App;
