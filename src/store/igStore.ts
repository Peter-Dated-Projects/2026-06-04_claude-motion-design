import { create } from "zustand";
import type {
  Brief,
  ClipResult,
  DownloadResult,
  IGExtractionListItem,
  IGFrame,
  IGPhase,
  PhaseAInput,
  ScoredFrame,
  StageProgress,
} from "../types/ig";

/**
 * Source-of-truth store for the active IG extraction.
 *
 * Design notes:
 * - This store is intentionally Tauri-free. Every action below is a PURE reducer
 *   callable in isolation (no `invoke`/`listen`), so the cross-boundary contract
 *   is unit-testable without a running backend. The end-to-end wiring that calls
 *   the Rust commands and subscribes to the `ig://` events lives in the
 *   integration ticket (T-031); it will drive this store through these same
 *   actions. Do NOT spread `invoke`/`listen` through the reducers here.
 * - Frames are keyed by their 1-based `index` (not array position) because score
 *   events may arrive progressively or out of order; a late or duplicate event
 *   updates the right slot rather than appending.
 * - The scorer's `kept` and the user's `overrideKept` are kept separate. The
 *   effective keep decision is `overrideKept ?? kept`; `rejectReason` is never
 *   discarded by a toggle, so the grid can still show "was rejected: <reason>".
 */

/** The effective keep decision: user override wins, else the scorer's verdict. */
export function isFrameKept(frame: IGFrame): boolean {
  return frame.overrideKept ?? frame.kept;
}

/**
 * The frame paths threaded into Phase B's `analyze` call: effective-kept frames,
 * ranked best-first by combined score (matching the scorer's `kept` ordering).
 * Pure — exported so it can be unit-tested directly. An empty result is a valid
 * Phase-A outcome; a panel decides whether to block the Analyze button on it.
 */
export function selectKeptFramePaths(frames: Record<number, IGFrame>): string[] {
  return Object.values(frames)
    .filter(isFrameKept)
    .sort((a, b) => b.score - a.score)
    .map((f) => f.path);
}

/** Frames in capture order (ascending 1-based index) — what the grid renders. */
export function selectFramesInOrder(frames: Record<number, IGFrame>): IGFrame[] {
  return Object.values(frames).sort((a, b) => a.index - b.index);
}

export interface IGState {
  /** Phase state machine. Mutated only through the actions below. */
  phase: IGPhase;

  /** Resolved source video for the active extraction (set during Phase A). */
  source: DownloadResult | null;
  /** Resolved <=30s working clip for the active extraction (set during Phase A). */
  clip: ClipResult | null;

  /** Scored frames keyed by 1-based `index`. */
  frames: Record<number, IGFrame>;

  /** Latest stage-progress tick for the staged progress bar, or null when idle. */
  stageProgress: StageProgress | null;

  /** The motion-language brief, available once Phase B completes. */
  brief: Brief | null;

  /** Human-readable error message when `phase === "error"`. */
  error: string | null;

  /** Past extractions for the sidebar (populated by the integration ticket). */
  extractions: IGExtractionListItem[];
  /** Currently selected past-extraction id, or null. */
  activeExtractionId: string | null;

  // --- Phase A ---------------------------------------------------------------
  /** Begin Phase A: clear the active extraction and enter `running-A`. */
  startPhaseA: (input: PhaseAInput) => void;
  /** Apply a stage-progress tick (display only; does not drive transitions). */
  applyStageProgress: (progress: StageProgress) => void;
  /** Record the download stage result. */
  applyDownloadResult: (result: DownloadResult) => void;
  /** Record the clip stage result. */
  applyClipResult: (result: ClipResult) => void;
  /** Upsert a per-frame score record by `index`, preserving any user override. */
  applyFrameScore: (frame: ScoredFrame) => void;
  /** Phase A finished scoring: pause at `awaiting-review` for user review. */
  phaseAComplete: () => void;

  // --- Review ----------------------------------------------------------------
  /** Flip a frame's keep override by 1-based `index`, preserving `rejectReason`. */
  toggleFrameKept: (index: number) => void;
  /** The user-chosen kept frame paths threaded into Phase B (best-first by score). */
  keptFramePaths: () => string[];

  // --- Phase B ---------------------------------------------------------------
  /** Begin Phase B (analyze -> store): enter `running-B`. */
  startPhaseB: () => void;
  /** Record the brief and complete the run (`-> done`). */
  setBrief: (brief: Brief) => void;

  // --- Errors / lifecycle ----------------------------------------------------
  /** Record a failure and enter `error`. */
  setError: (message: string) => void;
  /** Reset to `idle`, clearing the active extraction (keeps the sidebar list). */
  reset: () => void;

  // --- Sidebar ---------------------------------------------------------------
  /** Replace the past-extractions list. */
  setExtractions: (extractions: IGExtractionListItem[]) => void;
  /** Select a past extraction by id (loading its data is the integration ticket's job). */
  setActiveExtraction: (id: string | null) => void;
}

/** Fields reset at the start of each extraction (everything except the sidebar list). */
const FRESH_EXTRACTION = {
  source: null,
  clip: null,
  frames: {} as Record<number, IGFrame>,
  stageProgress: null,
  brief: null,
  error: null,
} satisfies Partial<IGState>;

export const useIGStore = create<IGState>((set, get) => ({
  phase: "idle",
  ...FRESH_EXTRACTION,
  extractions: [],
  activeExtractionId: null,

  startPhaseA: (_input) =>
    set({ ...FRESH_EXTRACTION, phase: "running-A" }),

  applyStageProgress: (progress) => set({ stageProgress: progress }),

  applyDownloadResult: (result) => set({ source: result }),

  applyClipResult: (result) => set({ clip: result }),

  applyFrameScore: (frame) =>
    set((state) => {
      const existing = state.frames[frame.index];
      // Preserve a user override if the same frame's score re-arrives (late/dup event).
      const next: IGFrame = { ...frame, overrideKept: existing?.overrideKept };
      return { frames: { ...state.frames, [frame.index]: next } };
    }),

  phaseAComplete: () =>
    set((state) =>
      state.phase === "running-A" ? { phase: "awaiting-review" } : state
    ),

  toggleFrameKept: (index) =>
    set((state) => {
      const frame = state.frames[index];
      if (!frame) return state;
      // Flip the EFFECTIVE decision; keep `kept` + `rejectReason` intact.
      const next: IGFrame = { ...frame, overrideKept: !isFrameKept(frame) };
      return { frames: { ...state.frames, [index]: next } };
    }),

  keptFramePaths: () => selectKeptFramePaths(get().frames),

  startPhaseB: () =>
    set((state) =>
      state.phase === "awaiting-review" ? { phase: "running-B" } : state
    ),

  setBrief: (brief) => set({ brief, phase: "done" }),

  setError: (message) => set({ error: message, phase: "error" }),

  reset: () => set({ ...FRESH_EXTRACTION, phase: "idle" }),

  setExtractions: (extractions) => set({ extractions }),

  setActiveExtraction: (id) => set({ activeExtractionId: id }),
}));
