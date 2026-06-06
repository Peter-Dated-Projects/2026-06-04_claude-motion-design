import { createContext, useContext } from "react";
import { create, type StoreApi, type UseBoundStore } from "zustand";

/** Where in the preview pipeline an entry originated. */
export type RenderLogStage = "compile" | "render" | "runtime" | "watchdog";
export type RenderLogLevel = "info" | "warn" | "error";

export interface RenderLogEntry {
  id: number;
  /** Epoch ms when the entry was recorded. */
  ts: number;
  level: RenderLogLevel;
  stage: RenderLogStage;
  message: string;
}

/** Hard cap on retained entries -- oldest are dropped past this so the log can run
 *  indefinitely (e.g. a per-frame runtime throw) without unbounded growth. */
const MAX_ENTRIES = 100;

export interface RenderLogState {
  entries: RenderLogEntry[];
  add: (level: RenderLogLevel, stage: RenderLogStage, message: string) => void;
  clear: () => void;
}

// Monotonic id, module-scoped so it keeps climbing even after a clear() AND across
// store instances (ids never collide, so they stay valid React keys across a wipe
// and never clash between two live previews' logs).
let nextId = 0;

export type RenderLogStore = UseBoundStore<StoreApi<RenderLogState>>;

/** Create an isolated render-log store. Each PreviewPanel owns one so that two live
 *  previews (e.g. the main editor preview and RenderModal's export preview, mounted
 *  at the same time) don't pour their compile events into one shared bucket and show
 *  every entry twice. */
export function createRenderLogStore(): RenderLogStore {
  return create<RenderLogState>((set) => ({
    entries: [],
    add: (level, stage, message) =>
      set((state) => {
        const entry: RenderLogEntry = {
          id: nextId++,
          ts: Date.now(),
          level,
          stage,
          message,
        };
        const entries = [...state.entries, entry];
        // Drop oldest once over the cap.
        if (entries.length > MAX_ENTRIES) {
          entries.splice(0, entries.length - MAX_ENTRIES);
        }
        return { entries };
      }),
    clear: () => set({ entries: [] }),
  }));
}

// The store a PreviewPanel created, shared down to its RenderLogPanel child. Null
// outside a provider -- consumers must be rendered under a PreviewPanel.
const RenderLogContext = createContext<RenderLogStore | null>(null);

export const RenderLogProvider = RenderLogContext.Provider;

/** Read the render-log store provided by the enclosing PreviewPanel. */
export function useRenderLogStoreCtx(): RenderLogStore {
  const store = useContext(RenderLogContext);
  if (!store) {
    throw new Error("useRenderLogStoreCtx must be used within a RenderLogProvider");
  }
  return store;
}

/** Count of error-level entries -- drives the collapsed toolbar badge. */
export function selectErrorCount(state: RenderLogState): number {
  let n = 0;
  for (const e of state.entries) if (e.level === "error") n++;
  return n;
}
