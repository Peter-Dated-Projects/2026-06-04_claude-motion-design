import { create } from "zustand";
import type {
  LoadedVideo,
  RotoOutputListItem,
  RotoPhase,
  RotoPoint,
  RotoProgress,
  RotoscopeResult,
  RotoscopingStatus,
} from "../types/roto";

/**
 * Source-of-truth store for the rotoscoping stage.
 *
 * Design notes (mirrors the IG store, src/store/igStore.ts):
 * - This store is intentionally Tauri-free. Every action is a PURE reducer
 *   callable in isolation (no `invoke`/`listen`), so the cross-boundary contract
 *   stays unit-testable without a running backend. The wiring that calls the Rust
 *   commands (`check_rotoscoping_service`, `rotoscope_video`, `cancel_rotoscope`)
 *   and subscribes to the `roto://progress` event lives at the app boundary
 *   (App.tsx today; the panel tickets T-004/T-005 may grow a dedicated host like
 *   IGPipelineHost). Do NOT spread `invoke`/`listen` through the reducers here.
 * - The microservice is OPTIONAL. `serviceAvailable` gates whether the workspace
 *   even appears (WorkspaceBar reads it); it is set once at startup from
 *   `check_rotoscoping_service` and is `false` until proven otherwise.
 * - Points are kept as an ordered array (not keyed) because placement order is
 *   how the user reasons about them and "Clear Points" wipes the whole set; the
 *   foreground/background split is carried per-point in `label`.
 */

/**
 * A rotoscope output's PNG sequence loaded into the left pane for looping
 * stop-motion playback. Not part of the backend contract -- the Outputs panel
 * builds this from a `list_rotoscope_outputs` row (convertFileSrc the ordered
 * PNG paths into asset:// urls, derive the effective playback fps from the
 * stored frame_skip). Distinct from a source `video`: when present, the left
 * pane plays this sequence instead of the source-video setup flow.
 */
export interface LoadedSequence {
  /** Output folder label, e.g. `rotoscope_clip`. */
  name: string;
  /** Absolute path to the output folder. */
  dir: string;
  /** Ordered asset:// urls (convertFileSrc of the PNG sequence). */
  urls: string[];
  /** Effective playback fps (source fps / (frameSkip + 1)). */
  fps: number;
}

/** Proposal default: process every 4th frame (skip=3 -> ~7.5fps at 30fps source). */
export const DEFAULT_FRAME_SKIP = 3;

/** Proposal cap: beyond this the stop-motion playback is too choppy to read. */
export const MAX_FRAME_SKIP = 10;

export interface RotoState {
  // --- Service discovery -----------------------------------------------------
  /** Whether the microservice answered /health at startup. Gates the workspace. */
  serviceAvailable: boolean;
  /** Enriched status (model / VRAM) when available; null while unknown. */
  status: RotoscopingStatus | null;

  // --- Active setup ----------------------------------------------------------
  /** The video loaded into the preview pane, or null (empty state). */
  video: LoadedVideo | null;
  /**
   * A completed output's PNG sequence loaded for stop-motion playback, or null.
   * Mutually exclusive with the source-video flow in the UI: when set, the left
   * pane plays this instead of the `video` setup. Loading a source video clears
   * it; `clearSequence` returns to whatever source-video state was underneath.
   */
  loadedSequence: LoadedSequence | null;
  /** The locked reference frame index, or null until "Set Start Frame". */
  startFrame: number | null;
  /** Placed prompt points, in placement order (fg + bg interleaved). */
  points: RotoPoint[];
  /** Frames to skip between processed frames (0..MAX_FRAME_SKIP). */
  frameSkip: number;

  // --- Job lifecycle ---------------------------------------------------------
  /** Job state machine. Mutated only through the actions below. */
  phase: RotoPhase;
  /** Latest progress tick for the bar, or null when idle/done. */
  progress: RotoProgress | null;
  /** Server-side job id (for cancel), set once a job is in flight. */
  jobId: string | null;
  /** Human-readable error when `phase === "error"`. */
  error: string | null;

  // --- Outputs ---------------------------------------------------------------
  /** Completed rotoscope jobs for the active project. */
  outputs: RotoOutputListItem[];

  // --- Service-discovery actions ---------------------------------------------
  /** Record the startup /health probe result (availability + model/VRAM info). */
  setServiceAvailability: (status: RotoscopingStatus) => void;

  // --- Setup actions ---------------------------------------------------------
  /** Load a source video into the preview pane; resets start frame + points
   *  and clears any loaded output sequence. */
  loadVideo: (video: LoadedVideo) => void;
  /** Load a completed output's PNG sequence for stop-motion playback. */
  loadSequence: (sequence: LoadedSequence) => void;
  /** Clear the loaded output sequence (returns to the source-video view). */
  clearSequence: () => void;
  /** Lock the current scrub position as the reference frame. */
  setStartFrame: (frame: number | null) => void;
  /** Append a prompt point (foreground or background per its label). */
  addPoint: (point: RotoPoint) => void;
  /** Clear all placed points. */
  clearPoints: () => void;
  /** Set the frame-skip value (clamped to [0, MAX_FRAME_SKIP]). */
  setFrameSkip: (skip: number) => void;

  // --- Job actions -----------------------------------------------------------
  /** Begin a job: enter `uploading` with a fresh progress/error slate. */
  startJob: (jobId: string) => void;
  /** Apply a progress tick (display only; flips `uploading` -> `processing`). */
  applyProgress: (progress: RotoProgress) => void;
  /** Job finished: enter `done` and push the result into the outputs list. */
  jobComplete: (result: RotoscopeResult) => void;
  /** Record a failure and enter `error`. */
  setError: (message: string) => void;

  // --- Outputs / lifecycle ---------------------------------------------------
  /** Replace the outputs list (enumerated from the project's assets). */
  setOutputs: (outputs: RotoOutputListItem[]) => void;
  /** Reset the active setup + job (keeps service availability + outputs list). */
  reset: () => void;
}

const clampSkip = (skip: number): number =>
  Math.max(0, Math.min(MAX_FRAME_SKIP, Math.round(skip)));

/** Derive the output folder label from a result dir (its last path segment). */
function outputNameFromDir(dir: string): string {
  const parts = dir.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? dir;
}

/** Fields cleared at the start of each job / on reset (not the service flag or list). */
const FRESH_SETUP = {
  video: null,
  loadedSequence: null,
  startFrame: null,
  points: [] as RotoPoint[],
  frameSkip: DEFAULT_FRAME_SKIP,
  phase: "idle" as RotoPhase,
  progress: null,
  jobId: null,
  error: null,
} satisfies Partial<RotoState>;

export const useRotoStore = create<RotoState>((set) => ({
  serviceAvailable: false,
  status: null,
  ...FRESH_SETUP,
  outputs: [],

  setServiceAvailability: (status) =>
    set({ serviceAvailable: status.available, status }),

  loadVideo: (video) =>
    set({
      video,
      loadedSequence: null,
      startFrame: null,
      points: [],
      progress: null,
      phase: "idle",
      error: null,
    }),

  loadSequence: (loadedSequence) => set({ loadedSequence }),

  clearSequence: () => set({ loadedSequence: null }),

  setStartFrame: (startFrame) => set({ startFrame }),

  addPoint: (point) => set((state) => ({ points: [...state.points, point] })),

  clearPoints: () => set({ points: [] }),

  setFrameSkip: (skip) => set({ frameSkip: clampSkip(skip) }),

  startJob: (jobId) =>
    set({ jobId, phase: "uploading", progress: null, error: null }),

  applyProgress: (progress) =>
    set((state) => ({
      progress,
      // First real tick promotes uploading -> processing; terminal stages are
      // driven by jobComplete/setError, not here.
      phase: state.phase === "uploading" ? "processing" : state.phase,
    })),

  jobComplete: (result) =>
    set((state) => {
      const item: RotoOutputListItem = {
        name: outputNameFromDir(result.outputDir),
        dir: result.outputDir,
        frameCount: result.frameCount,
      };
      // Replace any existing entry for the same dir (a re-run overwrites in place).
      const rest = state.outputs.filter((o) => o.dir !== item.dir);
      return { phase: "done", jobId: null, outputs: [item, ...rest] };
    }),

  setError: (message) => set({ error: message, phase: "error", jobId: null }),

  setOutputs: (outputs) => set({ outputs }),

  reset: () => set({ ...FRESH_SETUP }),
}));
