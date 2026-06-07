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

/** Named quality preset for the pre-upload re-encode (bug-bash proposal section 6b). */
export type QualityPreset = "original" | "high" | "fast" | "low";

/** Output-resolution preset; `custom` unlocks the explicit width/height inputs. */
export type ResolutionPreset = "360p" | "720p" | "1080p" | "custom";

/**
 * Chosen output resolution. `width`/`height` are the effective pixel dimensions
 * the server scales to; for a named preset they mirror RESOLUTION_PRESETS, for
 * `custom` they are whatever the user typed. `maintainAspect` (custom only) locks
 * editing to the entered width:height ratio so changing one dimension fills the
 * other -- NOTE: LoadedVideo carries no source dimensions, so this is the entered
 * ratio, not the true source aspect ratio.
 */
export interface RotoResolution {
  preset: ResolutionPreset;
  width: number;
  height: number;
  maintainAspect: boolean;
}

/** Pixel dimensions for each named resolution preset (16:9 landscape sources). */
export const RESOLUTION_PRESETS: Record<
  Exclude<ResolutionPreset, "custom">,
  { width: number; height: number }
> = {
  "360p": { width: 640, height: 360 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
};

/** Proposal default: 720p output. */
export const DEFAULT_RESOLUTION: RotoResolution = {
  preset: "720p",
  ...RESOLUTION_PRESETS["720p"],
  maintainAspect: true,
};

/** Proposal default: "fast" (~CRF 23) re-encode. */
export const DEFAULT_QUALITY: QualityPreset = "fast";

/**
 * Hard cap (seconds) the rotoscoping microservice enforces on an uploaded clip
 * (`MAX_VIDEO_SECONDS = 60` in the service; it returns 400 past it). The client
 * mirrors it so a too-long range is caught before the upload the server rejects.
 */
export const MAX_CLIP_SECONDS = 60;

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
  /**
   * LEGACY / transient scrub position, or null. No longer the canonical SAM2
   * reference input: the reference frame is now derived deterministically at
   * enqueue (frame 0 of the selected clip -- `round(clipStart * fps)`, else 0;
   * see useRotoJobQueue.runJob and decision `roto-reference-frame-is-clip-frame-zero`).
   * This field + `setStartFrame` are retained only so the not-yet-removed manual
   * "Set Start Frame" UI in RotoVideoPanel still compiles; T-010 removes that UI,
   * after which this can be dropped. Whatever value it holds is IGNORED by the job.
   */
  startFrame: number | null;
  /**
   * Clip-range bounds in seconds on the SOURCE timeline, or null when unset.
   * When both are set the submit flow trims the source to [clipStart, clipEnd]
   * before upload (T-015). null/null means upload the whole source. These are
   * SOURCE-relative; `clipStart` also IS the SAM2 reference frame: the reference
   * is derived at enqueue as `round(clipStart * fps)` (else 0), which rebases to
   * frame 0 of the trimmed clip.
   */
  clipStart: number | null;
  clipEnd: number | null;
  /** Placed prompt points, in placement order (fg + bg interleaved). */
  points: RotoPoint[];
  /** Frames to skip between processed frames (0..MAX_FRAME_SKIP). */
  frameSkip: number;
  /** Chosen output resolution (preset or custom width/height). */
  resolution: RotoResolution;
  /** Chosen re-encode quality preset; "original" skips the pre-upload re-encode. */
  quality: QualityPreset;

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

  // --- Comparison cross-panel signal -----------------------------------------
  /**
   * Monotonic nonce bumped when the Outputs pane requests that the Video pane
   * enter comparison mode for a freshly-loaded (sequence, source-clip) pair.
   * The two panes are siblings with no shared parent, so this store field is the
   * cross-panel channel. A nonce rather than a boolean so a repeat "Compare"
   * click re-fires even when the user previously toggled comparison back off.
   */
  comparisonNonce: number;

  // --- Service-discovery actions ---------------------------------------------
  /** Record the startup /health probe result (availability + model/VRAM info). */
  setServiceAvailability: (status: RotoscopingStatus) => void;

  // --- Setup actions ---------------------------------------------------------
  /** Load a source video into the preview pane; resets start frame + points
   *  and clears any loaded output sequence. */
  loadVideo: (video: LoadedVideo) => void;
  /**
   * Load a source video for comparison. Mirrors `loadVideo`'s setup resets
   * (clears startFrame/clipStart/clipEnd/points and the job phase/error/progress)
   * but does NOT clear `loadedSequence` -- the one difference from `loadVideo`.
   *
   * CALLER CONTRACT: this exists solely for the Outputs pane "Compare" button.
   * Because it does not clear `loadedSequence`, the caller MUST set both sides
   * together -- call `loadSequence(...)` and `loadVideoForComparison(...)` as an
   * atomic pair in a single handler, never one without the other. Calling this
   * twice in a row with two different videos would otherwise leave the first
   * call's sequence paired with the second video, producing a mismatched pair.
   * The regular `loadVideo` path still clears the sequence as before.
   */
  loadVideoForComparison: (video: LoadedVideo) => void;
  /** Load a completed output's PNG sequence for stop-motion playback. */
  loadSequence: (sequence: LoadedSequence) => void;
  /** Clear the loaded output sequence (returns to the source-video view). */
  clearSequence: () => void;
  /**
   * LEGACY setter for `startFrame`. The SAM2 reference frame is no longer chosen
   * by a manual gesture -- it is derived from `clipStart` at enqueue (see the
   * `startFrame` field doc). Retained only until T-010 removes the manual UI that
   * still calls it; the value it sets is not read by the job.
   */
  setStartFrame: (frame: number | null) => void;
  /** Set the clip-range start in seconds (clamped to >= 0), or null to clear. */
  setClipStart: (seconds: number | null) => void;
  /** Set the clip-range end in seconds (clamped to >= 0), or null to clear. */
  setClipEnd: (seconds: number | null) => void;
  /** Append a prompt point (foreground or background per its label). */
  addPoint: (point: RotoPoint) => void;
  /** Clear all placed points. */
  clearPoints: () => void;
  /** Set the frame-skip value (clamped to [0, MAX_FRAME_SKIP]). */
  setFrameSkip: (skip: number) => void;
  /** Set the output resolution (preset or custom width/height). */
  setResolution: (resolution: RotoResolution) => void;
  /** Set the re-encode quality preset. */
  setQuality: (quality: QualityPreset) => void;

  // --- Job actions -----------------------------------------------------------
  /** Begin a job: enter `uploading` with a fresh progress/error slate. */
  startJob: (jobId: string) => void;
  /** Apply a progress tick (display only; flips `uploading` -> `processing`). */
  applyProgress: (progress: RotoProgress) => void;
  /** Job finished: enter `done` and push the result into the outputs list. */
  jobComplete: (result: RotoscopeResult) => void;
  /** Record a failure and enter `error`. */
  setError: (message: string) => void;

  // --- Comparison cross-panel signal -----------------------------------------
  /** Ask the Video pane to enter comparison mode (bumps `comparisonNonce`).
   *  Pair with `loadSequence` + `loadVideoForComparison` in the same handler. */
  requestComparison: () => void;

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
  clipStart: null,
  clipEnd: null,
  points: [] as RotoPoint[],
  frameSkip: DEFAULT_FRAME_SKIP,
  resolution: DEFAULT_RESOLUTION,
  quality: DEFAULT_QUALITY,
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
  comparisonNonce: 0,

  setServiceAvailability: (status) =>
    set({ serviceAvailable: status.available, status }),

  loadVideo: (video) =>
    set({
      video,
      loadedSequence: null,
      startFrame: null,
      clipStart: null,
      clipEnd: null,
      points: [],
      resolution: DEFAULT_RESOLUTION,
      quality: DEFAULT_QUALITY,
      progress: null,
      phase: "idle",
      error: null,
    }),

  loadVideoForComparison: (video) =>
    set({
      video,
      // Mirror loadVideo's setup resets so exiting comparison never leaves the
      // PRIOR video's locked reference frame / points submittable over the new
      // source clip -- but KEEP loadedSequence (the whole point of this path).
      startFrame: null,
      clipStart: null,
      clipEnd: null,
      points: [],
      phase: "idle",
      error: null,
      progress: null,
    }),

  loadSequence: (loadedSequence) => set({ loadedSequence }),

  clearSequence: () => set({ loadedSequence: null }),

  setStartFrame: (startFrame) => set({ startFrame }),

  setClipStart: (seconds) =>
    set({ clipStart: seconds == null ? null : Math.max(0, seconds) }),

  setClipEnd: (seconds) =>
    set({ clipEnd: seconds == null ? null : Math.max(0, seconds) }),

  addPoint: (point) => set((state) => ({ points: [...state.points, point] })),

  clearPoints: () => set({ points: [] }),

  setFrameSkip: (skip) => set({ frameSkip: clampSkip(skip) }),

  setResolution: (resolution) => set({ resolution }),

  setQuality: (quality) => set({ quality }),

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

  requestComparison: () =>
    set((state) => ({ comparisonNonce: state.comparisonNonce + 1 })),

  setOutputs: (outputs) => set({ outputs }),

  reset: () => set({ ...FRESH_SETUP }),
}));
