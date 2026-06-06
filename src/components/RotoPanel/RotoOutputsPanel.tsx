import { useRotoStore } from "../../store/rotoStore";

/**
 * The rotoscoping stage's bottom-right "Rotoscope Outputs" pane.
 *
 * Scoped subset (T-005): a store-driven list of the active project's completed
 * rotoscope jobs. It reads `rotoStore.outputs` (one entry per
 * `assets/rotoscope_<source>/` folder) and renders a row per output with its
 * label and frame count. The list refreshes automatically when a new output
 * lands, because `rotoStore.jobComplete` pushes the result into `outputs` after
 * a successful `rotoscope_video` (wired at the app boundary / T-004).
 *
 * Pure store consumer -- no `invoke`/`listen`, no new shared wiring.
 *
 * Deferred to T-006 (depends on this ticket; edits this file afterward):
 * thumbnails and double-click playback. Both need surface that does not exist
 * yet -- see the TODO below.
 */
export default function RotoOutputsPanel() {
  const outputs = useRotoStore((s) => s.outputs);

  // TODO(T-006): (1) render a thumbnail per row from the output folder's first
  // PNG via convertFileSrc -- needs a backend command to enumerate the folder's
  // PNG files (meta.json carries the frame count but not filenames, and nothing
  // lists files under assets/ today). (2) On double-click, load the output's PNG
  // sequence into the left Video Preview pane as looping stop-motion at the
  // effective output fps -- needs a rotoStore field/action for a loaded frame
  // sequence (the store currently models only a single source `video`). Both
  // are out of this ticket's frontend-only, two-file scope.

  return (
    <div className="roto-outputs">
      <style>{STYLES}</style>
      <div className="roto-outputs__label">
        Rotoscope Outputs
        {outputs.length > 0 ? (
          <span className="roto-outputs__count">{outputs.length}</span>
        ) : null}
      </div>

      {outputs.length === 0 ? (
        <div className="roto-outputs__hint">
          Completed rotoscope jobs appear here.
        </div>
      ) : (
        <ul className="roto-outputs__list">
          {outputs.map((o) => (
            <li key={o.dir} className="roto-outputs__row" title={o.dir}>
              <span className="roto-outputs__name">{o.name}</span>
              <span className="roto-outputs__frames">
                {o.frameCount} {o.frameCount === 1 ? "frame" : "frames"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Scoped styles -- no CSS file is in this ticket's scope, so the pane's look
// lives here in a one-time <style> block (same convention as the T-003 stubs
// and the IG panels). Colors come from the app theme tokens defined in App.css.
const STYLES = `
.roto-outputs {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface-alt);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.roto-outputs__label {
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
  background: var(--surface-alt);
}
.roto-outputs__count {
  color: var(--text-faint);
  text-transform: none;
  letter-spacing: 0;
}
.roto-outputs__hint {
  padding: 16px 12px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
}
.roto-outputs__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  list-style: none;
  margin: 0;
  padding: 4px 0;
}
.roto-outputs__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
}
.roto-outputs__name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.roto-outputs__frames {
  flex: none;
  color: var(--text-faint);
  font-size: 10px;
}
`;
