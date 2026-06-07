import { useRotoJobQueueApi, type QueuedJob } from "../../hooks/useRotoJobQueue";

/**
 * Bottom-left floating stack of rotoscope job cards. Rendered app-level (outside
 * the panel layout) so it floats over every workspace. Reads the shared queue via
 * `useRotoJobQueueApi`; renders nothing when the queue is empty.
 *
 * The stack grows upward (newest on top): the queue holds jobs oldest-first, so
 * we reverse for display. Cards are compact (one line + a progress bar) so a few
 * of them do not cover critical UI.
 */
export default function RotoJobQueueOverlay() {
  const { jobs, cancel, dismiss } = useRotoJobQueueApi();
  if (jobs.length === 0) return null;

  // Newest on top -- render in reverse of submission order.
  const ordered = [...jobs].reverse();

  return (
    <div className="roto-jq" aria-label="Rotoscope job queue">
      <style>{STYLES}</style>
      {ordered.map((job) => (
        <JobCard key={job.id} job={job} onCancel={cancel} onDismiss={dismiss} />
      ))}
    </div>
  );
}

function JobCard({
  job,
  onCancel,
  onDismiss,
}: {
  job: QueuedJob;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);

  // Status line + bar fill width per state.
  let statusText: string;
  let fillPct: number;
  switch (job.status) {
    case "queued":
      statusText = "Waiting...";
      fillPct = 0;
      break;
    case "running":
      statusText = `${pct}%`;
      fillPct = pct;
      break;
    case "done":
      statusText = "Done";
      fillPct = 100;
      break;
    case "failed":
      statusText = `Failed: ${shortError(job.error)}`;
      fillPct = 100;
      break;
    case "cancelled":
      statusText = "Cancelled";
      fillPct = pct;
      break;
    default:
      // Defensive fallback for an unexpected status (e.g. a future enum value).
      statusText = String(job.status);
      fillPct = pct;
      break;
  }

  const showCancel = job.status === "queued" || job.status === "running";
  const showDismiss = job.status === "failed";

  return (
    <div className={`roto-jq__card roto-jq__card--${job.status}`}>
      <div className="roto-jq__top">
        <span className="roto-jq__label" title={job.label}>
          {job.label}
        </span>
        {showCancel ? (
          <button
            type="button"
            className="roto-jq__btn"
            onClick={() => onCancel(job.id)}
            aria-label="Cancel job"
            title="Cancel"
          >
            x
          </button>
        ) : null}
        {showDismiss ? (
          <button
            type="button"
            className="roto-jq__btn"
            onClick={() => onDismiss(job.id)}
            aria-label="Dismiss job"
            title="Dismiss"
          >
            x
          </button>
        ) : null}
      </div>
      <div className="roto-jq__bar">
        <div className="roto-jq__fill" style={{ width: `${fillPct}%` }} />
        <span className="roto-jq__status">{statusText}</span>
      </div>
    </div>
  );
}

/** First line / first ~80 chars of an error, for the compact failed card. */
function shortError(error: string | null): string {
  if (!error) return "unknown error";
  const firstLine = error.split("\n")[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}...` : firstLine;
}

const STYLES = `
.roto-jq {
  position: fixed;
  left: 16px;
  bottom: 60px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.roto-jq__card {
  pointer-events: auto;
  width: 240px;
  padding: 7px 9px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--surface, #1a1d24);
  border: 1px solid var(--border-soft, #2c313c);
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.4);
  transition: opacity 0.25s ease;
}
.roto-jq__card--cancelled {
  opacity: 0;
}
.roto-jq__top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.roto-jq__label {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--text, #e6e8ee);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.roto-jq__btn {
  flex: none;
  width: 18px;
  height: 18px;
  line-height: 16px;
  padding: 0;
  font-size: 12px;
  font-family: inherit;
  color: var(--text-muted, #9aa0ad);
  background: transparent;
  border: 1px solid var(--border-soft, #2c313c);
  border-radius: 4px;
  cursor: pointer;
}
.roto-jq__btn:hover {
  color: var(--text, #e6e8ee);
}
.roto-jq__bar {
  position: relative;
  height: 16px;
  border-radius: 4px;
  background: var(--surface-alt, #14171d);
  border: 1px solid var(--border-soft, #2c313c);
  overflow: hidden;
}
.roto-jq__fill {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  background: var(--accent, #6ea8fe);
  opacity: 0.55;
  transition: width 0.2s ease;
}
.roto-jq__card--queued .roto-jq__fill {
  background: var(--text-faint, #6b7280);
}
.roto-jq__card--done .roto-jq__fill {
  background: #3aa564;
  opacity: 0.7;
}
.roto-jq__card--failed .roto-jq__fill {
  background: #b3424a;
  opacity: 0.6;
}
.roto-jq__status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding: 0 7px;
  font-size: 10px;
  color: var(--text, #e6e8ee);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;
