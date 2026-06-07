import { useEffect, useState } from "react";
import {
  useRotoStore,
  RESOLUTION_PRESETS,
  type ModelSize,
  type QualityPreset,
  type ResolutionPreset,
  type RotoResolution,
} from "../../store/rotoStore";

/**
 * Output controls for the rotoscoping setup: Output FPS, output resolution,
 * quality preset, a live output-frame estimate, and the Generate button.
 *
 * FPS <-> frame-skip: the server still consumes an integer `frameSkip`, so the
 * typed Output FPS is just a friendlier view over it. Given the probed source
 * fps we derive
 *
 *   frameSkip = max(0, round(sourceFps / targetFps) - 1)
 *
 * and the displayed fps is the inverse, sourceFps / (frameSkip + 1). The input is
 * disabled until the video is probed (we can't map fps -> skip without the source
 * rate); the output-frame estimate is computed purely in TS from the cached
 * ffprobe metadata so it updates instantly.
 *
 * Resolution + quality live in the store (single source of truth); the pre-submit
 * confirmation reads them rather than collecting them again.
 */

interface RotoControlsProps {
  /** Whether Generate is allowed (start frame locked + at least one fg point). */
  canGenerate: boolean;
  /** Open the pre-submit confirmation -> kick off the job. */
  onGenerate: () => void;
}

const QUALITY_OPTIONS: { value: QualityPreset; label: string; hint: string }[] = [
  { value: "original", label: "Original", hint: "No re-encode (copy as-is)" },
  { value: "high", label: "High", hint: "~CRF 18 (large, near-lossless)" },
  { value: "fast", label: "Fast", hint: "~CRF 23 (balanced)" },
  { value: "low", label: "Low", hint: "~CRF 28 (small, lossy)" },
];

const RESOLUTION_OPTIONS: { value: ResolutionPreset; label: string }[] = [
  { value: "360p", label: "360p" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
  { value: "custom", label: "Custom" },
];

const MODEL_OPTIONS: { value: ModelSize; label: string; hint: string }[] = [
  { value: "tiny", label: "Tiny", hint: "Fastest, lowest quality masks" },
  { value: "small", label: "Small", hint: "Faster, slightly lower quality" },
  { value: "base_plus", label: "Base+", hint: "Balanced default" },
  { value: "large", label: "Large", hint: "Best masks, slowest + most VRAM" },
];

/**
 * Swap-stage labels the SAM2 service (T-006) emits on `roto://progress` AHEAD of
 * the frame stages when a job's requested model differs from the resident one.
 * Pinned verbatim by T-006: `downloading_model` carries a 0..1 download fraction,
 * then `loading_model`, and `queued` for a job waiting behind a swap/in-flight run.
 * RotoControls reflects these so the control reads "loading model..." instead of
 * looking idle while a multi-GB checkpoint downloads or the predictor rebuilds.
 */
const MODEL_SWAP_STAGES = new Set(["downloading_model", "loading_model", "queued"]);

export default function RotoControls({ canGenerate, onGenerate }: RotoControlsProps) {
  const video = useRotoStore((s) => s.video);
  const frameSkip = useRotoStore((s) => s.frameSkip);
  const setFrameSkip = useRotoStore((s) => s.setFrameSkip);
  const resolution = useRotoStore((s) => s.resolution);
  const setResolution = useRotoStore((s) => s.setResolution);
  const quality = useRotoStore((s) => s.quality);
  const setQuality = useRotoStore((s) => s.setQuality);
  const modelSize = useRotoStore((s) => s.modelSize);
  const setModelSize = useRotoStore((s) => s.setModelSize);
  // Live progress tick (fed at the app boundary via applyProgress). Used only to
  // show the model-swap state on the Model control -- never to drive a job.
  const progress = useRotoStore((s) => s.progress);

  // While the service is swapping models, surface it on the control instead of
  // leaving it looking idle. `downloading_model` carries a fraction; the others
  // are indeterminate. Stages pinned by T-006 (see MODEL_SWAP_STAGES).
  const swapStage = progress && MODEL_SWAP_STAGES.has(progress.stage)
    ? progress.stage
    : null;
  const modelLoadingLabel =
    swapStage === "downloading_model"
      ? `Downloading model... ${Math.round((progress?.progress ?? 0) * 100)}%`
      : swapStage === "queued"
        ? "Queued (model swap)..."
        : swapStage === "loading_model"
          ? "Loading model..."
          : null;

  const duration = video?.durationSeconds ?? null;
  // Source fps is required to map between fps and frame-skip; null until probed.
  const sourceFps = video?.fps ?? null;
  const probed = sourceFps != null && sourceFps > 0;

  // Effective output fps implied by the stored frameSkip (the canonical value).
  const targetFps = probed ? sourceFps / (frameSkip + 1) : null;

  // Local text state for the fps field so the user can type freely (incl. a
  // transient empty / invalid string) without us clobbering it each keystroke.
  const [fpsText, setFpsText] = useState("");
  const [fpsError, setFpsError] = useState(false);
  // Ceiling warning shown when the typed fps exceeds the source rate. Held in its
  // own state so the targetFps sync effect (which fires as we clamp to the source
  // rate) does NOT wipe it -- it persists until the next valid in-range edit.
  const [fpsWarning, setFpsWarning] = useState<string | null>(null);

  // Sync the field from the derived target fps whenever it (or probe state)
  // changes from outside this input -- e.g. a new video, or skip set elsewhere.
  useEffect(() => {
    setFpsText(targetFps != null ? trimFps(targetFps) : "");
    setFpsError(false);
  }, [targetFps]);

  // Clear a stale ceiling warning when the source video changes (new source fps).
  // Keyed on `video` (not targetFps) so the in-place clamp -- which moves targetFps
  // -- does not wipe the warning it just set.
  useEffect(() => {
    setFpsWarning(null);
  }, [video]);

  const onFpsChange = (raw: string) => {
    setFpsText(raw);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      // Reject zero/negative/non-numeric: hold the value, flag the field.
      setFpsError(true);
      return;
    }
    setFpsError(false);
    if (sourceFps != null) {
      if (parsed > sourceFps) {
        // Can't output more frames than the source has: clamp to every frame
        // (skip 0) and warn. The field snaps back to the source rate via the
        // sync effect once frameSkip lands at 0.
        setFpsWarning(`Max source fps is ${trimFps(sourceFps)}fps`);
        setFrameSkip(0);
        return;
      }
      setFpsWarning(null);
      setFrameSkip(Math.max(0, Math.round(sourceFps / parsed) - 1));
    }
  };

  const estimate =
    duration != null && duration > 0 && sourceFps != null
      ? Math.ceil((duration * sourceFps) / (frameSkip + 1))
      : null;

  // --- Resolution helpers ----------------------------------------------------

  const selectResolutionPreset = (preset: ResolutionPreset) => {
    if (preset === "custom") {
      // Seed custom from whatever dimensions are currently in effect.
      setResolution({ ...resolution, preset: "custom" });
      return;
    }
    setResolution({
      preset,
      ...RESOLUTION_PRESETS[preset],
      maintainAspect: resolution.maintainAspect,
    });
  };

  const setCustomDimension = (dim: "width" | "height", raw: string) => {
    const value = Math.max(0, Math.round(Number(raw) || 0));
    const next: RotoResolution = { ...resolution, preset: "custom", [dim]: value };
    if (resolution.maintainAspect) {
      // Lock to the currently-entered ratio (LoadedVideo has no source dims).
      const ratio = resolution.width / resolution.height;
      if (Number.isFinite(ratio) && ratio > 0 && value > 0) {
        if (dim === "width") next.height = Math.max(1, Math.round(value / ratio));
        else next.width = Math.max(1, Math.round(value * ratio));
      }
    }
    setResolution(next);
  };

  return (
    <div className="roto-controls">
      <style>{STYLES}</style>

      {/* --- Output FPS --------------------------------------------------- */}
      <div className="roto-controls__field">
        <label className="roto-controls__label" htmlFor="roto-fps">
          Output FPS
        </label>
        <div className="roto-controls__fps">
          <input
            id="roto-fps"
            type="text"
            inputMode="decimal"
            className={
              "roto-controls__fps-input" +
              (fpsError ? " roto-controls__fps-input--error" : "")
            }
            value={probed ? fpsText : ""}
            placeholder={probed ? "" : "Load video first"}
            disabled={!probed}
            onChange={(e) => onFpsChange(e.target.value)}
          />
          {probed ? (
            <span className="roto-controls__fps-hint">
              every {frameSkip + 1}
              {ordinalSuffix(frameSkip + 1)} frame
            </span>
          ) : null}
        </div>
        {probed && fpsWarning ? (
          <div className="roto-controls__fps-warning">{fpsWarning}</div>
        ) : null}
      </div>

      <div className="roto-controls__estimate">
        {estimate != null ? (
          <>
            ~<strong>{estimate}</strong> output frame{estimate === 1 ? "" : "s"}
          </>
        ) : (
          "Output-frame estimate unavailable until the video is probed."
        )}
      </div>

      {/* --- Output resolution -------------------------------------------- */}
      <div className="roto-controls__field">
        <div className="roto-controls__label">Resolution</div>
        <div className="roto-controls__segments">
          {RESOLUTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={
                "roto-controls__segment" +
                (resolution.preset === opt.value
                  ? " roto-controls__segment--active"
                  : "")
              }
              onClick={() => selectResolutionPreset(opt.value)}
            >
              {opt.label}
            </button>
          ))}
          {/* Custom dims live INLINE on the same row as the segments so toggling
              Custom doesn't add a row below (keeps the section height stable). */}
          {resolution.preset === "custom" ? (
            <div className="roto-controls__custom-inline">
              <label className="roto-controls__dim">
                <span>W</span>
                <input
                  type="number"
                  min={1}
                  value={resolution.width || ""}
                  onChange={(e) => setCustomDimension("width", e.target.value)}
                />
              </label>
              <span className="roto-controls__dim-x">x</span>
              <label className="roto-controls__dim">
                <span>H</span>
                <input
                  type="number"
                  min={1}
                  value={resolution.height || ""}
                  onChange={(e) => setCustomDimension("height", e.target.value)}
                />
              </label>
              <button
                type="button"
                title="Maintain aspect ratio"
                aria-pressed={resolution.maintainAspect}
                className={
                  "roto-controls__aspect-toggle" +
                  (resolution.maintainAspect
                    ? " roto-controls__aspect-toggle--active"
                    : "")
                }
                onClick={() =>
                  setResolution({
                    ...resolution,
                    maintainAspect: !resolution.maintainAspect,
                  })
                }
              >
                Aspect
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* --- Quality ------------------------------------------------------ */}
      <div className="roto-controls__field">
        <div className="roto-controls__label">Quality</div>
        <div className="roto-controls__segments">
          {QUALITY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={
                "roto-controls__segment roto-controls__segment--tip" +
                (quality === opt.value ? " roto-controls__segment--active" : "")
              }
              onClick={() => setQuality(opt.value)}
            >
              {opt.label}
              {/* Immediate custom tooltip, replacing the delayed native title. */}
              <span className="roto-controls__tip" role="tooltip">
                {opt.hint}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* --- Model size --------------------------------------------------- */}
      <div className="roto-controls__field">
        <div className="roto-controls__label">Model</div>
        <div className="roto-controls__segments">
          {MODEL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={
                "roto-controls__segment roto-controls__segment--tip" +
                (modelSize === opt.value ? " roto-controls__segment--active" : "")
              }
              onClick={() => setModelSize(opt.value)}
            >
              {opt.label}
              <span className="roto-controls__tip" role="tooltip">
                {opt.hint}
              </span>
            </button>
          ))}
        </div>
        {/* Never lie about the model: while the service downloads/loads/queues a
            swap, say so rather than leaving the control looking settled. */}
        {modelLoadingLabel ? (
          <div className="roto-controls__model-loading">{modelLoadingLabel}</div>
        ) : null}
      </div>

      <button
        type="button"
        className="roto-controls__generate"
        disabled={!canGenerate}
        onClick={onGenerate}
        title={
          canGenerate
            ? "Review the settings and send to the rotoscoping service"
            : "Set a start frame and place at least one foreground point first"
        }
      >
        Generate Rotoscope
      </button>
    </div>
  );
}

/** Format a derived fps for the input: drop a trailing ".0" but keep real decimals. */
function trimFps(fps: number): string {
  const rounded = Math.round(fps * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** 1st / 2nd / 3rd / 4th ... suffix for the frame-cadence hint. */
function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

const STYLES = `
.roto-controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border-top: 1px solid var(--border-soft);
  background: var(--surface-alt);
}
.roto-controls__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.roto-controls__label {
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.roto-controls__fps {
  display: flex;
  align-items: center;
  gap: 8px;
}
.roto-controls__fps-input {
  width: 84px;
  padding: 4px 8px;
  font-size: 13px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
}
.roto-controls__fps-input:focus {
  outline: none;
  border-color: var(--accent, #6ea8fe);
}
.roto-controls__fps-input--error {
  border-color: #c0524f;
}
.roto-controls__fps-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.roto-controls__fps-hint {
  font-size: 11px;
  color: var(--text-faint);
}
.roto-controls__fps-warning {
  font-size: 11px;
  color: #d08a3e;
}
.roto-controls__estimate {
  font-size: 11px;
  color: var(--text-faint);
}
.roto-controls__estimate strong {
  color: var(--text);
}
.roto-controls__segments {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.roto-controls__model-loading {
  font-size: 11px;
  color: var(--accent, #6ea8fe);
}
.roto-controls__segment {
  position: relative;
  min-width: 48px;
  padding: 4px 10px;
  font-size: 12px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-controls__segment:hover {
  border-color: var(--accent, #6ea8fe);
}
.roto-controls__segment--active {
  color: #fff;
  background: var(--accent, #6ea8fe);
  border-color: var(--accent, #6ea8fe);
}
/* Custom-resolution inputs, inline on the resolution segment row. */
.roto-controls__custom-inline {
  display: flex;
  align-items: center;
  gap: 6px;
}
.roto-controls__dim {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-muted);
}
.roto-controls__dim input {
  width: 56px;
  padding: 4px 6px;
  font-size: 13px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface-alt);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
}
.roto-controls__dim-x {
  color: var(--text-faint);
  font-size: 12px;
}
.roto-controls__aspect-toggle {
  padding: 4px 8px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-controls__aspect-toggle:hover {
  border-color: var(--accent, #6ea8fe);
}
.roto-controls__aspect-toggle--active {
  color: #fff;
  background: var(--accent, #6ea8fe);
  border-color: var(--accent, #6ea8fe);
}
/* Custom quality tooltip: immediate (no native title delay), positioned above
   the button, raised above siblings so the controls row doesn't clip it. */
.roto-controls__tip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  width: max-content;
  max-width: 200px;
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.3;
  text-align: center;
  white-space: normal;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 5px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}
.roto-controls__segment--tip:hover .roto-controls__tip {
  opacity: 1;
  visibility: visible;
}
.roto-controls__generate {
  align-self: flex-start;
  margin-top: 2px;
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  color: #fff;
  background: var(--accent, #6ea8fe);
  border: none;
  border-radius: 5px;
  cursor: pointer;
}
.roto-controls__generate:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
`;
