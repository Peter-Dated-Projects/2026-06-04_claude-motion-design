import { useRotoStore } from "../../store/rotoStore";

/**
 * Live job view: progress bar + stage label + frame counter, driven entirely by
 * `rotoStore.progress` (fed from the `roto://progress` event at the app boundary).
 *
 * Stage labelling mirrors the proposal's wording:
 *   Uploading... / Extracting Frames... / Loading Model... /
 *   Rotoscoping (n / total)... / Packaging...
 * The `uploading` phase has no tick yet (the clip is still being sent), so its
 * label comes from the phase rather than a progress payload.
 *
 * Cancel calls `cancel_rotoscope` (DELETE on the service) and returns the user to
 * point placement; the actual invoke is owned by the container and passed in.
 */

interface ProcessingViewProps {
  /** Cancel the in-flight job (invoke cancel_rotoscope + reset to setup). */
  onCancel: () => void;
}

export default function ProcessingView({ onCancel }: ProcessingViewProps) {
  const phase = useRotoStore((s) => s.phase);
  const progress = useRotoStore((s) => s.progress);

  // Bar fills from the latest tick; uploading (pre-tick) shows an indeterminate
  // sliver so the user sees activity before the service registers the job.
  const fraction = progress?.progress ?? (phase === "uploading" ? 0.04 : 0);
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);

  return (
    <div className="roto-processing">
      <style>{STYLES}</style>
      <div className="roto-processing__stage">{stageLabel(phase, progress)}</div>

      <div className="roto-processing__track">
        <div
          className="roto-processing__fill"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="roto-processing__meta">
        {progress?.framesTotal != null ? (
          <span>
            {progress.framesDone ?? 0} / {progress.framesTotal} frames
          </span>
        ) : (
          <span>{pct}%</span>
        )}
      </div>

      <button
        type="button"
        className="roto-processing__cancel"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

/** Map phase + progress tick to the proposal's human-readable stage line. */
function stageLabel(
  phase: string,
  progress: { stage: string; framesDone?: number; framesTotal?: number } | null,
): string {
  // Before the first SSE tick the clip is still uploading.
  if (phase === "uploading" && !progress) return "Uploading...";

  const stage = progress?.stage ?? "";
  switch (stage) {
    case "loading":
      return "Loading Model...";
    case "extracting":
      return "Extracting Frames...";
    case "segmenting":
      if (progress?.framesTotal != null) {
        return `Rotoscoping (${progress.framesDone ?? 0} / ${progress.framesTotal} frames)...`;
      }
      return "Rotoscoping...";
    case "packaging":
      return "Packaging...";
    case "done":
      return "Done";
    default:
      // Unknown / future stage: show it verbatim rather than a blank label.
      return stage ? `${stage}...` : "Processing...";
  }
}

const STYLES = `
.roto-processing {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 24px 16px;
  max-width: 420px;
  margin: 0 auto;
}
.roto-processing__stage {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.roto-processing__track {
  width: 100%;
  height: 8px;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  overflow: hidden;
}
.roto-processing__fill {
  height: 100%;
  background: var(--accent, #6ea8fe);
  transition: width 0.2s ease;
}
.roto-processing__meta {
  font-size: 11px;
  color: var(--text-faint);
}
.roto-processing__cancel {
  align-self: flex-start;
  padding: 6px 16px;
  font-size: 13px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface-alt);
  border: 1px solid var(--border-soft);
  border-radius: 5px;
  cursor: pointer;
}
.roto-processing__cancel:hover {
  border-color: #ff5c5c;
  color: #ff8c8c;
}
`;
