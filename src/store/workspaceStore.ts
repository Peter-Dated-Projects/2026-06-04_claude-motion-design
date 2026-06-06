import { create } from "zustand";
import type { LayoutNode, PanelId } from "../components/PanelLayout/SplitLayout";

// ---------------------------------------------------------------------------
// Workspaces = stages of the design workflow (Editing, and future stages like
// review / publish). They all belong to the SAME project and operate on the
// SAME three singleton panels (Claude terminal, editor, preview). A workspace
// is therefore NOT a separate copy of the app -- it is just a saved *panel
// arrangement* over those shared panels, plus a name + icon + the set of panels
// it is allowed to show.
//
// CONFIG vs STATE. Workspaces are curated stages defined HERE in code
// (WORKSPACE_DEFS), not created or configured by users. The config fields --
// name, icon, availablePanels, defaultLayout -- are hard-coded and never
// persisted, so editing a def in code takes effect immediately for everyone.
// The only USER state is mutable and persisted (see WorkspaceState below):
//   - each workspace's rearranged layout (overrides the def's defaultLayout)
//   - which workspace is active
//
// Why this shares the Claude PTY and preview across workspaces: SplitLayout
// mounts each panel exactly once into a persistent host div and merely
// re-parents it when the layout tree changes (see SplitLayout.tsx). Switching
// workspaces only swaps which tree SplitLayout renders -- the live PTY session,
// preview iframe, and Monaco state are never torn down. Sharing is automatic;
// this store just owns the per-workspace layout it renders.
//
// Editor tabs are currently global (uiStore.openFiles / activeFile), which
// makes every tab effectively "synced" across all workspaces. File *content*
// is a global path-keyed cache in App.tsx, so showing the same file in two
// workspaces never re-loads or re-compiles it. To make tab sync selectable
// ("some tabs synced, some not") scope openFiles/activeFile per workspace and
// keep a global synced-paths set merged into each workspace's strip.
// ---------------------------------------------------------------------------

/** Icon keys understood by the workspace bar's icon registry (see icons.tsx /
 *  WorkspaceBar). Adding a stage = add a key here + a row in the registry. */
export type WorkspaceIconKey = "edit" | "layers" | "rocket" | "instagram" | "rotoscope";

/** The three long-lived singleton panels (Claude terminal, editor, preview)
 *  shared across the editing-style stages. */
export const ALL_PANELS: PanelId[] = ["terminal", "editor", "preview"];

/** The Instagram stage's four panel slots. These are NOT the shared singletons;
 *  each is filled by a downstream panel ticket via a renderPanel case. Like the
 *  singletons they are mounted-once / detached-when-hidden (SplitLayout mountedIds
 *  is monotonic), so a panel here is NOT remounted on re-entering the stage --
 *  per-project reset is the panel component's own responsibility. */
export const IG_PANELS: PanelId[] = [
  "ig-extraction-list",
  "ig-preview",
  "ig-frame-grid",
  "ig-brief",
];

/** The rotoscoping stage's three panel slots (proposal: video preview on the
 *  left, project-assets list top-right, rotoscope-outputs list bottom-right).
 *  Like the IG slots these are additive, mounted-once / detached-when-hidden. */
export const ROTO_PANELS: PanelId[] = [
  "roto-video",
  "roto-assets",
  "roto-outputs",
];

// The default 3-panel arrangement, reused by workspace defs below.
export const DEFAULT_LAYOUT: LayoutNode = {
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

// --- Hard-coded workspace definitions (config, never persisted) ------------
export interface WorkspaceDef {
  id: string;
  name: string;
  icon: WorkspaceIconKey;
  /** The panels this stage may show -- scopes its show/hide menu, and what
   *  reset can produce. A panel not listed here can't be added to the stage. */
  availablePanels: PanelId[];
  /** Arrangement used until the user rearranges it. null = all panels hidden. */
  defaultLayout: LayoutNode | null;
}

// The Instagram stage's arrangement: a left extraction-list sidebar; the main
// area stacks a top row (IG video preview + frame grid) over the brief below.
// Uses only the four IG slots -- no terminal/editor/preview in this stage.
const IG_LAYOUT: LayoutNode = {
  direction: "row",
  first: "ig-extraction-list",
  second: {
    direction: "column",
    first: {
      direction: "row",
      first: "ig-preview",
      second: "ig-frame-grid",
      splitPercentage: 50,
    },
    second: "ig-brief",
    splitPercentage: 60,
  },
  splitPercentage: 22,
};

// The rotoscoping stage's arrangement: the video preview fills the left; the
// right is a column stacking the project-assets list over the outputs list.
// Uses only the three roto slots -- no terminal/editor/preview here.
const ROTO_LAYOUT: LayoutNode = {
  direction: "row",
  first: "roto-video",
  second: {
    direction: "column",
    first: "roto-assets",
    second: "roto-outputs",
    splitPercentage: 50,
  },
  splitPercentage: 60,
};

// Add a stage by adding an entry. "Editing" re-lays-out the three shared
// singletons; "IG" and "Rotoscope" are additive stages over their own slots.
export const WORKSPACE_DEFS: WorkspaceDef[] = [
  {
    id: "ig",
    name: "IG",
    icon: "instagram",
    availablePanels: [...IG_PANELS],
    defaultLayout: IG_LAYOUT,
  },
  {
    id: "roto",
    name: "Rotoscope",
    icon: "rotoscope",
    availablePanels: [...ROTO_PANELS],
    defaultLayout: ROTO_LAYOUT,
  },
  {
    id: "editing",
    name: "Editing",
    icon: "edit",
    availablePanels: [...ALL_PANELS],
    defaultLayout: DEFAULT_LAYOUT,
  },
];

const DEFS_BY_ID = new Map(WORKSPACE_DEFS.map((d) => [d.id, d]));
// Tab render order (above) puts IG left of Editing, but the app should still
// open in the Editing workspace, so pin the fallback/default explicitly rather
// than keying it off WORKSPACE_DEFS[0].
const FALLBACK_ID = "editing";

// --- Persisted user state --------------------------------------------------
const STATE_KEY = "claude-motion:workspaceState";
// Earlier this store persisted the whole workspaces array (incl. config);
// before that, a single global layout lived here. Both are migrated on load.
const LEGACY_WORKSPACES_KEY = "claude-motion:workspaces";
const LEGACY_LAYOUT_KEY = "claude-motion:panelLayout";

interface WorkspaceState {
  activeWorkspaceId: string;
  /** Saved layout per workspace id. A MISSING key means "use the def's
   *  defaultLayout"; an explicit null means the user hid every panel. */
  layouts: Record<string, LayoutNode | null>;

  /** Switch the active workspace (the one whose layout SplitLayout renders). */
  setActiveWorkspace: (id: string) => void;
  /** Save the ACTIVE workspace's layout (drag/resize/show-hide/reset). */
  setLayout: (layout: LayoutNode | null) => void;
}

function persist(state: Pick<WorkspaceState, "activeWorkspaceId" | "layouts">): void {
  try {
    localStorage.setItem(
      STATE_KEY,
      JSON.stringify({
        activeWorkspaceId: state.activeWorkspaceId,
        layouts: state.layouts,
      }),
    );
  } catch {
    // Best-effort; ignore quota/availability errors.
  }
}

// Keep only layouts whose workspace id still exists in the defs.
function sanitizeLayouts(raw: unknown): Record<string, LayoutNode | null> {
  const out: Record<string, LayoutNode | null> = {};
  if (raw && typeof raw === "object") {
    for (const [id, layout] of Object.entries(raw as Record<string, LayoutNode | null>)) {
      if (DEFS_BY_ID.has(id)) out[id] = layout;
    }
  }
  return out;
}

function validActive(id: unknown): string {
  return typeof id === "string" && DEFS_BY_ID.has(id) ? id : FALLBACK_ID;
}

function loadInitial(): Pick<WorkspaceState, "activeWorkspaceId" | "layouts"> {
  // Preferred: the new {activeWorkspaceId, layouts} blob.
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        activeWorkspaceId?: string;
        layouts?: unknown;
      };
      return {
        activeWorkspaceId: validActive(parsed.activeWorkspaceId),
        layouts: sanitizeLayouts(parsed.layouts),
      };
    }
  } catch {
    // Fall through to migration.
  }

  // Migrate the earlier workspaces-array format: pull out each {id, layout}.
  try {
    const raw = localStorage.getItem(LEGACY_WORKSPACES_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as Array<{ id?: string; layout?: LayoutNode | null }>;
      if (Array.isArray(arr)) {
        const layouts: Record<string, LayoutNode | null> = {};
        for (const w of arr) {
          if (w && typeof w.id === "string" && DEFS_BY_ID.has(w.id)) {
            layouts[w.id] = w.layout ?? null;
          }
        }
        return { activeWorkspaceId: FALLBACK_ID, layouts };
      }
    }
  } catch {
    // Fall through.
  }

  // Migrate the pre-workspaces single layout into the default workspace.
  try {
    const legacy = localStorage.getItem(LEGACY_LAYOUT_KEY);
    if (legacy !== null) {
      return {
        activeWorkspaceId: FALLBACK_ID,
        layouts: { [FALLBACK_ID]: JSON.parse(legacy) as LayoutNode | null },
      };
    }
  } catch {
    // Fall through.
  }

  // First run: no overrides, defs' defaultLayout applies.
  return { activeWorkspaceId: FALLBACK_ID, layouts: {} };
}

const initial = loadInitial();

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeWorkspaceId: initial.activeWorkspaceId,
  layouts: initial.layouts,

  setActiveWorkspace: (id) =>
    set((state) => {
      if (!DEFS_BY_ID.has(id) || id === state.activeWorkspaceId) return state;
      persist({ activeWorkspaceId: id, layouts: state.layouts });
      return { activeWorkspaceId: id };
    }),

  setLayout: (layout) =>
    set((state) => {
      const layouts = { ...state.layouts, [state.activeWorkspaceId]: layout };
      persist({ activeWorkspaceId: state.activeWorkspaceId, layouts });
      return { layouts };
    }),
}));

// --- Selectors -------------------------------------------------------------
// Components read derived slices through these so the def/override merge lives
// in one place.

export function selectActiveDef(state: WorkspaceState): WorkspaceDef {
  return DEFS_BY_ID.get(state.activeWorkspaceId) ?? WORKSPACE_DEFS[0];
}

/** The active workspace's layout -- its saved override, else the def default. */
export function selectActiveLayout(state: WorkspaceState): LayoutNode | null {
  const id = state.activeWorkspaceId;
  if (id in state.layouts) return state.layouts[id];
  return selectActiveDef(state).defaultLayout;
}

/** The active workspace's allowed panels -- scopes the show/hide menu. */
export function selectActiveAvailablePanels(state: WorkspaceState): PanelId[] {
  return selectActiveDef(state).availablePanels;
}

/** The active workspace's default arrangement -- the target for "reset". */
export function selectActiveDefaultLayout(state: WorkspaceState): LayoutNode | null {
  return selectActiveDef(state).defaultLayout;
}
