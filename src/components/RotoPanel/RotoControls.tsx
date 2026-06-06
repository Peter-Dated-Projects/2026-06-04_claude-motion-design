import { useRotoStore, MAX_FRAME_SKIP } from "../../store/rotoStore";

/**
 * Frame-skip selector + live output-frame estimate + the Generate button.
 *
 * The estimate is computed PURELY in TS from the video's cached ffprobe metadata
 * (`durationSeconds` / `fps` on the loaded video) -- no LLM, no backend round-trip
 * -- so it updates instantly as the user drags the skip slider:
 *
 *   outputFrames = Math.ceil((duration * fps) / (frameSkip + 1))
 *
 * fps falls back to 30 when the video has not been probed yet (the proposal's
 * tables assume a 30fps source); the estimate is then a best-effort approximation
 * and the panel still works -- the real count is whatever the microservice emits.
 */

/** Source fps assumed when the loaded video has not been probed (proposal default). */
const ASSUMED_FPS = 30;

interface RotoControlsProps {
  /** Whether Generate is allowed (start frame locked + at least one fg point). */
  canGenerate: boolean;
  /** Open the compression modal -> kick off the job. */
  onGenerate: () => void;
}

export default function RotoControls({ canGenerate, onGenerate }: RotoControlsProps) {
  const video = useRotoStore((s) => s.video);
  const frameSkip = useRotoStore((s) => s.frameSkip);
  const setFrameSkip = useRotoStore((s) => s.setFrameSkip);

  const duration = video?.durationSeconds ?? null;
  const fps = video?.fps ?? ASSUMED_FPS;
  const estimate =
    duration != null && duration > 0
      ? Math.ceil((duration * fps) / (frameSkip + 1))
      : null;

  const skips = Array.from({ length: MAX_FRAME_SKIP + 1 }, (_, i) => i);

  return (
    <div className="roto-controls">
      <style>{STYLES}</style>

      <div className="roto-controls__row">
        <div className="roto-controls__label">Frame skip</div>
        <div className="roto-controls__skips">
          {skips.map((s) => (
            <button
              key={s}
              type="button"
              className={
                "roto-controls__skip" +
                (s === frameSkip ? " roto-controls__skip--active" : "")
              }
              onClick={() => setFrameSkip(s)}
              title={
                s === 0
                  ? "Process every frame"
                  : `Process every ${s + 1}${ordinalSuffix(s + 1)} frame`
              }
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="roto-controls__estimate">
        {estimate != null ? (
          <>
            ~<strong>{estimate}</strong> output frame{estimate === 1 ? "" : "s"}
            {video?.fps == null ? " (est. @ 30fps)" : null}
          </>
        ) : (
          "Output-frame estimate unavailable until the video is probed."
        )}
      </div>

      <button
        type="button"
        className="roto-controls__generate"
        disabled={!canGenerate}
        onClick={onGenerate}
        title={
          canGenerate
            ? "Compress (optional) and send to the rotoscoping service"
            : "Set a start frame and place at least one foreground point first"
        }
      >
        Generate Rotoscope
      </button>
    </div>
  );
}

/** 1st / 2nd / 3rd / 4th ... suffix for the skip tooltip. */
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
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--border-soft);
  background: var(--surface-alt);
}
.roto-controls__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.roto-controls__label {
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.roto-controls__skips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.roto-controls__skip {
  min-width: 26px;
  padding: 3px 6px;
  font-size: 12px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.roto-controls__skip:hover {
  border-color: var(--accent, #6ea8fe);
}
.roto-controls__skip--active {
  color: #fff;
  background: var(--accent, #6ea8fe);
  border-color: var(--accent, #6ea8fe);
}
.roto-controls__estimate {
  font-size: 11px;
  color: var(--text-faint);
}
.roto-controls__estimate strong {
  color: var(--text);
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
