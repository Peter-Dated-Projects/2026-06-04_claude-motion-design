import { create } from "zustand";

export type SafeZonePlatform = "universal" | "tiktok" | "instagram" | "youtube";

/** Which view the Code panel's left rail shows: the source file tree or the
 *  project's image assets. */
export type CodePanelView = "files" | "assets";

export interface Selection {
  text: string;
  startLine: number;
  endLine: number;
}

export interface UIState {
  /** Panel widths as percentages [chat, code, preview]; always sums to ~100. */
  panelWidths: [number, number, number];
  isGenerating: boolean;
  showSafeZone: boolean;
  safeZonePlatform: SafeZonePlatform;
  selection: Selection | null;

  /** Whether the Code panel's file-tree rail is shown. Persisted. */
  showFileTree: boolean;

  /** Which view the Code panel's left rail shows: file tree or assets. Persisted. */
  codePanelView: CodePanelView;

  /** Project-relative paths of files with an open editor tab, in tab order. */
  openFiles: string[];
  /** The path of the file currently shown in the editor, or null if none. */
  activeFile: string | null;

  setPanelWidths: (widths: [number, number, number]) => void;
  setIsGenerating: (value: boolean) => void;
  toggleSafeZone: () => void;
  setSafeZonePlatform: (platform: SafeZonePlatform) => void;
  setSelection: (selection: Selection | null) => void;
  /** Show or hide the Code panel's file-tree rail (persisted). */
  toggleFileTree: () => void;
  /** Switch the Code panel's left rail between the file tree and assets (persisted). */
  setCodePanelView: (view: CodePanelView) => void;

  /** Open a file: add a tab if absent and make it active. */
  openFile: (path: string) => void;
  /** Close a tab; if it was active, fall back to a neighbouring tab. */
  closeFile: (path: string) => void;
  /** Switch the active tab without changing which tabs are open. */
  setActiveFile: (path: string) => void;
  /** Reset the editor to a single open tab (used on project switch). */
  resetEditorFiles: (entry: string) => void;
}

const PANEL_WIDTHS_KEY = "claude-motion:panelWidths";
const DEFAULT_WIDTHS: [number, number, number] = [25, 37, 38];

const FILE_TREE_KEY = "claude-motion:showFileTree";

function loadShowFileTree(): boolean {
  try {
    const raw = localStorage.getItem(FILE_TREE_KEY);
    if (raw === null) return true;
    return raw === "true";
  } catch {
    // Storage unavailable -> default to shown.
    return true;
  }
}

function persistShowFileTree(show: boolean): void {
  try {
    localStorage.setItem(FILE_TREE_KEY, String(show));
  } catch {
    // Best-effort; ignore quota/availability errors.
  }
}

const CODE_PANEL_VIEW_KEY = "claude-motion:codePanelView";

function loadCodePanelView(): CodePanelView {
  try {
    const raw = localStorage.getItem(CODE_PANEL_VIEW_KEY);
    return raw === "assets" ? "assets" : "files";
  } catch {
    // Storage unavailable -> default to the file tree.
    return "files";
  }
}

function persistCodePanelView(view: CodePanelView): void {
  try {
    localStorage.setItem(CODE_PANEL_VIEW_KEY, view);
  } catch {
    // Best-effort; ignore quota/availability errors.
  }
}

function loadPanelWidths(): [number, number, number] {
  try {
    const raw = localStorage.getItem(PANEL_WIDTHS_KEY);
    if (!raw) return DEFAULT_WIDTHS;
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return parsed as [number, number, number];
    }
  } catch {
    // Corrupt or unavailable storage -> fall back to defaults.
  }
  return DEFAULT_WIDTHS;
}

function persistPanelWidths(widths: [number, number, number]): void {
  try {
    localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Best-effort; ignore quota/availability errors.
  }
}

export const useUIStore = create<UIState>((set) => ({
  panelWidths: loadPanelWidths(),
  isGenerating: false,
  showSafeZone: true,
  safeZonePlatform: "universal",
  selection: null,
  showFileTree: loadShowFileTree(),
  codePanelView: loadCodePanelView(),
  openFiles: [],
  activeFile: null,

  setPanelWidths: (widths) => {
    persistPanelWidths(widths);
    set({ panelWidths: widths });
  },
  setIsGenerating: (value) => set({ isGenerating: value }),
  toggleSafeZone: () => set((state) => ({ showSafeZone: !state.showSafeZone })),
  setSafeZonePlatform: (platform) => set({ safeZonePlatform: platform }),
  setSelection: (selection) => set({ selection }),
  toggleFileTree: () =>
    set((state) => {
      const showFileTree = !state.showFileTree;
      persistShowFileTree(showFileTree);
      return { showFileTree };
    }),
  setCodePanelView: (view) => {
    persistCodePanelView(view);
    set({ codePanelView: view });
  },

  openFile: (path) =>
    set((state) => ({
      openFiles: state.openFiles.includes(path)
        ? state.openFiles
        : [...state.openFiles, path],
      activeFile: path,
    })),

  closeFile: (path) =>
    set((state) => {
      const idx = state.openFiles.indexOf(path);
      if (idx === -1) return state;
      const openFiles = state.openFiles.filter((p) => p !== path);
      let activeFile = state.activeFile;
      if (activeFile === path) {
        // Fall back to the previous tab, else the next, else nothing.
        activeFile = openFiles[idx - 1] ?? openFiles[idx] ?? null;
      }
      return { openFiles, activeFile };
    }),

  setActiveFile: (path) => set({ activeFile: path }),

  resetEditorFiles: (entry) => set({ openFiles: [entry], activeFile: entry }),
}));
