import { useRotoStore, type QualityPreset, type RotoState } from "../../store/rotoStore";

/**
 * Pre-submit review shown after clicking "Generate Rotoscope".
 *
 * This is a read-only confirmation summary, NOT a settings collector. All of the
 * knobs (fps, resolution, quality) now live in the main controls / store
 * (bug-bash proposal sections 5 + 6, landed in T-013); this modal just restates
 * the chosen settings and the derived job size so the user can sanity-check
 * before sending. On "Start Rotoscoping" it maps the chosen quality preset to the
 * legacy `(compress, quality)` pair the existing submit path still expects:
 * "Original" means skip the re-encode (compress=false); every other preset
 * compresses with a representative quality value.
 *
 * The old "Compress with ffmpeg" checkbox is gone entirely -- compression is
 * implied by any quality preset other than "Original".
 */

/** Map a quality preset to the legacy (compress, quality%) submit pair. */
export function qualityToSubmitParams(preset: QualityPreset): {
  compress: boolean;
  quality: number;
} {
  switch (preset) {
    case "original":
      return { compress: false, quality: 100 };
    case "high":
      return { compress: true, quality: 90 };
    case "fast":
      return { compress: true, quality: 70 };
    case "low":
      return { compress: true, quality: 50 };
  }
}

/** Friendly quality label + the compression hint shown on its row. */
const QUALITY_LABELS: Record<QualityPreset, string> = {
  original: "Original (no re-encode)",
  high: "High (~CRF 18)",
  fast: "Fast (~CRF 23)",
  low: "Low (~CRF 28)",
};

/**
 * Clip range is optional and owned by T-015 (it adds `clipStart`/`clipEnd` to the
 * store). Until that lands, those fields are absent from RotoState, so we read
 * them defensively here and only render the clip row when both are set -- this
 * ticket must not hard-depend on T-015.
 */
type ClipRangeFields = { clipStart?: number | null; clipEnd?: number | null };

/** Format seconds as `mm:ss.s` (e.g. 4.2 -> "00:04.2"). */
function formatTimecode(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = safe - mins * 60;
  const mm = String(mins).padStart(2, "0");
  const ss = secs.toFixed(1).padStart(4, "0");
  return `${mm}:${ss}`;
}

interface ReviewModalProps {
  /** Start the job with the params derived from the chosen quality preset. */
  onConfirm: (compress: boolean, quality: number) => void;
  /** Dismiss back to the setup view (the "Edit" action). */
  onCancel: () => void;
}

export default function ReviewModal({ onConfirm, onCancel }: ReviewModalProps) {
  const video = useRotoStore((s) => s.video);
  const frameSkip = useRotoStore((s) => s.frameSkip);
  const resolution = useRotoStore((s) => s.resolution);
  const quality = useRotoStore((s) => s.quality);
  const points = useRotoStore((s) => s.points);
  // Defensive optional read -- see ClipRangeFields above (T-015 owns these).
  const clip = useRotoStore((s) => {
    const ext = s as RotoState & ClipRangeFields;
    return ext.clipStart != null && ext.clipEnd != null
      ? { start: ext.clipStart, end: ext.clipEnd }
      : null;
  });

  const sourceFps = video?.fps ?? null;
  const duration = video?.durationSeconds ?? null;
  // Probe sets fps + duration together; until both land the video is "unprobed".
  const probed = sourceFps != null && duration != null;

  // Scope the estimate's duration input to the clip when a region is set (both
  // bounds present -- `clip` is already null when only one is, matching the
  // trim gating). Otherwise use the full source duration.
  const estimateDuration =
    clip != null ? Math.max(0, clip.end - clip.start) : duration;

  // Cadence: we process every (frameSkip + 1)th frame.
  const step = frameSkip + 1;
  // Derived output fps (canonical value is the integer frameSkip).
  const targetFps = sourceFps != null && sourceFps > 0 ? sourceFps / step : null;
  // Output-frame estimate, computed in TS from the cached ffprobe metadata over
  // the (clip-scoped) duration. Non-null exactly once probed; clamped to >= 1 so
  // a zero-length / inverted range never shows a 0 or negative frame count.
  const estimate =
    probed && sourceFps != null && estimateDuration != null
      ? Math.max(1, Math.ceil((estimateDuration * sourceFps) / step))
      : null;

  const fgCount = points.filter((p) => p.label === 1).length;
  const bgCount = points.filter((p) => p.label === 0).length;

  const ordinal = `${step}${ordinalSuffix(step)}`;

  const confirm = () => {
    const { compress, quality: q } = qualityToSubmitParams(quality);
    onConfirm(compress, q);
  };

  return (
    <div
      className="roto-modal__backdrop"
      onPointerDown={(e) => {
        // Click outside the card cancels (matches a standard dismiss gesture).
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <style>{STYLES}</style>
      <div
        className="roto-modal__card"
        role="dialog"
        aria-modal="true"
        aria-label="Review rotoscope settings"
      >
        <div className="roto-modal__title">Review before rotoscoping</div>
        <div className="roto-modal__body">
          These are the settings chosen in the controls. Edit to change them, or
          start the job.
        </div>

        <dl className="roto-modal__summary">
          {clip ? (
            <div className="roto-modal__row">
              <dt>Clip range</dt>
              <dd>
                {formatTimecode(clip.start)} - {formatTimecode(clip.end)} (
                {Math.max(0, clip.end - clip.start).toFixed(1)}s)
              </dd>
            </div>
          ) : null}

          <div className="roto-modal__row">
            <dt>Output FPS</dt>
            <dd>
              {targetFps != null ? (
                <>
                  {trimFps(targetFps)} fps{" "}
                  <span className="roto-modal__hint">(every {ordinal} frame)</span>
                </>
              ) : (
                <span className="roto-modal__hint">every {ordinal} frame</span>
              )}
            </dd>
          </div>

          <div className="roto-modal__row">
            <dt>Resolution</dt>
            <dd>
              {resolution.preset !== "custom" ? `${resolution.preset} ` : ""}(
              {resolution.width}x{resolution.height})
            </dd>
          </div>

          <div className="roto-modal__row">
            <dt>Quality</dt>
            <dd>{QUALITY_LABELS[quality]}</dd>
          </div>

          <div className="roto-modal__row">
            <dt>Estimated frames</dt>
            <dd>
              {estimate != null ? (
                `${estimate}`
              ) : (
                <span className="roto-modal__hint">probing video...</span>
              )}
            </dd>
          </div>

          <div className="roto-modal__row">
            <dt>Points</dt>
            <dd>
              {fgCount} foreground, {bgCount} background
            </dd>
          </div>
        </dl>

        <div className="roto-modal__actions">
          <button type="button" className="roto-modal__btn" onClick={onCancel}>
            Edit
          </button>
          <button
            type="button"
            className="roto-modal__btn roto-modal__btn--primary"
            onClick={confirm}
          >
            Start Rotoscoping
          </button>
        </div>
      </div>
    </div>
  );
}

/** Format a derived fps for display: drop a trailing ".0" but keep real decimals. */
function trimFps(fps: number): string {
  const rounded = Math.round(fps * 100) / 100;
  return String(rounded);
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
.roto-modal__backdrop {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.5);
  padding: 16px;
}
.roto-modal__card {
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.45);
}
.roto-modal__title {
  font-size: 14px;
  font-weight: 600;
}
.roto-modal__body {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}
.roto-modal__summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
}
.roto-modal__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}
.roto-modal__row dt {
  color: var(--text-muted);
}
.roto-modal__row dd {
  margin: 0;
  color: var(--text);
  text-align: right;
}
.roto-modal__hint {
  color: var(--text-faint);
}
.roto-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.roto-modal__btn {
  padding: 6px 16px;
  font-size: 13px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface-alt);
  border: 1px solid var(--border-soft);
  border-radius: 5px;
  cursor: pointer;
}
.roto-modal__btn--primary {
  color: #fff;
  background: var(--accent, #6ea8fe);
  border-color: var(--accent, #6ea8fe);
  font-weight: 600;
}
`;
