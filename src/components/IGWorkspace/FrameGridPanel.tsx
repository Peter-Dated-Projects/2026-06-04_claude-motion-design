import { useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { IGFrame, RejectReason } from "../../types/ig";
import { isFrameKept, selectFramesInOrder, useIGStore } from "../../store/igStore";

/**
 * Top-right review panel: the candidate-frame grid and the heart of the two-phase
 * flow. It renders every scored frame, marks the scorer's rejects with a red
 * overlay + X, and -- only while paused at `awaiting-review` -- lets the user
 * click a frame to override the keep/reject decision before the paid Phase B
 * analysis runs.
 *
 * Scope: PRESENTATIONAL + DISPATCH ONLY. It reads frames + phase from the IG
 * store and dispatches `toggleFrameKept(index)`. The one Tauri touch is
 * `convertFileSrc` -- a PURE synchronous URL helper (NOT a backend call) used to
 * point an <img> at a local frame via the asset protocol (enabled for the
 * extraction dir + CSP by T-028). No `invoke`/`listen`, no base64, no per-frame
 * round-trip.
 *
 * Frames arrive progressively over Phase A (per-frame score events fill the
 * store), so tiles are keyed by the stable 1-based `frame.index` -- never array
 * position -- to avoid remounting/flicker as the list grows.
 *
 * Override semantics: the overlay tracks the EFFECTIVE decision (`isFrameKept` =
 * `overrideKept ?? kept`), but the tooltip always surfaces the scorer's ORIGINAL
 * verdict, so a frame the user re-keeps still shows why the scorer rejected it.
 */

/** Human-readable label for a scorer reject reason (the union is exhaustive). */
function rejectReasonLabel(reason: RejectReason): string {
  switch (reason) {
    case "low_sharpness":
      return "low sharpness";
    case "insufficient_change":
      return "insufficient change";
  }
}

/** Zero-padded 1-based index label, e.g. 1 -> "001". */
function padIndex(index: number): string {
  return String(index).padStart(3, "0");
}

/**
 * Tooltip text: always reports the scorer's original verdict (so an overridden
 * frame still surfaces the reason it was rejected), plus a note when the user has
 * overridden it.
 */
function frameTooltip(frame: IGFrame): string {
  const original = frame.kept
    ? "Kept by scorer"
    : `Rejected: ${frame.rejectReason ? rejectReasonLabel(frame.rejectReason) : "filtered"}`;
  const overridden =
    frame.overrideKept !== undefined && frame.overrideKept !== frame.kept;
  if (!overridden) return original;
  return `${original} (overridden: ${frame.overrideKept ? "kept" : "rejected"} by you)`;
}

export default function FrameGridPanel() {
  // Individual selectors -> stable references; selecting the whole store would
  // re-render the grid on every unrelated IG state change.
  const frames = useIGStore((s) => s.frames);
  const phase = useIGStore((s) => s.phase);
  const toggleFrameKept = useIGStore((s) => s.toggleFrameKept);

  // Frames may land out of order during Phase A; present in capture order.
  const ordered = useMemo(() => selectFramesInOrder(frames), [frames]);

  // Toggling the keep set is only valid while the run is paused for review.
  // Outside it (Phase A still scoring, or Phase B analyzing) the grid is inert.
  const interactive = phase === "awaiting-review";

  return (
    <div className="ig-grid">
      <style>{STYLES}</style>
      <div className="ig-grid__header">
        Frames
        {ordered.length > 0 ? (
          <span className="ig-grid__count">{ordered.length}</span>
        ) : null}
      </div>

      {ordered.length === 0 ? (
        <div className="ig-grid__empty">
          Candidate frames appear here as scoring runs.
        </div>
      ) : (
        <div className="ig-grid__tiles">
          {ordered.map((frame) => {
            const kept = isFrameKept(frame);
            const tooltip = frameTooltip(frame);
            return (
              <div
                key={frame.index}
                className={
                  "ig-grid__tile" +
                  (kept ? "" : " ig-grid__tile--rejected") +
                  (interactive ? " ig-grid__tile--interactive" : "")
                }
                title={tooltip}
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-pressed={interactive ? kept : undefined}
                onClick={
                  interactive ? () => toggleFrameKept(frame.index) : undefined
                }
                onKeyDown={
                  interactive
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleFrameKept(frame.index);
                        }
                      }
                    : undefined
                }
              >
                <div className="ig-grid__thumb">
                  {frame.path ? (
                    <img
                      className="ig-grid__img"
                      src={convertFileSrc(frame.path)}
                      alt={`Frame ${padIndex(frame.index)}`}
                      loading="lazy"
                      draggable={false}
                    />
                  ) : (
                    <div
                      className="ig-grid__placeholder"
                      aria-hidden="true"
                    />
                  )}
                  {!kept ? (
                    <div className="ig-grid__overlay" aria-hidden="true">
                      <span className="ig-grid__x">&#10005;</span>
                    </div>
                  ) : null}
                </div>
                <div className="ig-grid__label">{padIndex(frame.index)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* Scoped styles. This ticket touches only this file (no CSS file in scope), so
   the grid's look lives here as a one-time <style> block. Colors come from the
   app theme tokens (defined in App.css) so it tracks the rest of the UI. */
const STYLES = `
.ig-grid {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  user-select: none;
}
.ig-grid__header {
  display: flex;
  align-items: center;
  gap: 8px;
  position: sticky;
  top: 0;
  padding: 6px 10px;
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-bottom: 1px solid var(--border-soft);
  background: var(--surface);
}
.ig-grid__count {
  color: var(--text-faint);
  text-transform: none;
  letter-spacing: 0;
}
.ig-grid__empty {
  padding: 16px 12px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.5;
  text-align: center;
}
.ig-grid__tiles {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 5px;
  padding: 10px;
  align-content: start;
}
.ig-grid__tile {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: none;
  background: transparent;
  padding: 0;
  cursor: default;
}
.ig-grid__tile--interactive {
  cursor: pointer;
}
.ig-grid__tile--interactive:focus-visible {
  outline: 2px solid var(--accent-strong);
  outline-offset: 2px;
  border-radius: 3px;
}
.ig-grid__thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 9 / 16;
  border-radius: 3px;
  overflow: hidden;
  background: var(--surface-alt);
  border: 1px solid var(--border-soft);
}
.ig-grid__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ig-grid__placeholder {
  width: 100%;
  height: 100%;
  background:
    repeating-linear-gradient(
      45deg,
      var(--surface-alt),
      var(--surface-alt) 6px,
      var(--hover-soft) 6px,
      var(--hover-soft) 12px
    );
}
.ig-grid__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(220, 38, 38, 0.42);
}
.ig-grid__x {
  color: #fff;
  font-size: 22px;
  line-height: 1;
  font-weight: 700;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
.ig-grid__label {
  text-align: center;
  color: var(--text-muted);
  font-size: 10px;
  letter-spacing: 0.04em;
}
`;
