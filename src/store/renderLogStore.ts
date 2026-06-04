import { create } from "zustand";

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

// Monotonic id, module-scoped so it keeps climbing even after a clear() (ids never
// collide, so they stay valid React keys across a wipe).
let nextId = 0;

export const useRenderLogStore = create<RenderLogState>((set) => ({
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

/** Count of error-level entries -- drives the collapsed toolbar badge. */
export function selectErrorCount(state: RenderLogState): number {
  let n = 0;
  for (const e of state.entries) if (e.level === "error") n++;
  return n;
}
